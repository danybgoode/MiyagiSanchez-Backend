/**
 * Offline oversell — record a synced cash sale whose stock ran out meanwhile
 * (in-person-sales S3.2, D12).
 *
 * The sale already happened at the stall without signal; refusing it now would make
 * the records lie. So when `completeCartWorkflow` refuses an OFFLINE cash sale for stock,
 * the order is created directly with `createOrdersStep` — the `ml-order-materialize.ts`
 * composition, which skips Medusa's availability check — stock is decremented only as
 * far as it goes (`planOversoldDecrement`), the shortfall is written to
 * `metadata.oversold` for the inbox flag, and the profit ledger row is appended directly
 * (createOrdersStep emits no `order.placed`).
 *
 * Exactly once: a fence on the claim token (D4) admits only the current owner. Before creating, any
 * order already carrying this client id is adopted (a crash between create and the claim
 * update), so a takeover never creates a second order.
 */
import { ContainerRegistrationKeys, Modules, QueryContext } from '@medusajs/framework/utils'
import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { createOrdersStep } from '@medusajs/medusa/core-flows'
import type { CreateOrderDTO } from '@medusajs/framework/types'
import { appendOrderLedger } from './profit-ledger-write'
import { resolveStockLocationId } from '../api/store/_utils/inventory'
import { planOversoldDecrement, type InPersonSaleInput } from './in-person-sale'

type Scope = { resolve: (key: string) => any }

const recordOversoldWorkflow = createWorkflow(
  'in-person-record-oversold-sale',
  (input: { orders: CreateOrderDTO[] }) => new WorkflowResponse(createOrdersStep(input.orders)),
)

/** An order already recorded for this seller's client id (crash recovery), if any. */
async function existingOrderFor(scope: Scope, sellerId: string, clientId: string): Promise<string | null> {
  const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const r = await knex.raw(
    `select id from "order"
      where deleted_at is null
        and metadata->>'seller_id' = ?
        and metadata->'in_person'->>'client_id' = ?
      limit 1`,
    [sellerId, clientId],
  )
  return r?.rows?.[0]?.id ?? null
}

export class OversoldOwnershipLost extends Error {}

export async function recordOversoldOfflineSale(
  scope: Scope,
  input: {
    sellerId: string
    sale: InPersonSaleInput
    regionId: string
    channelId: string
    email: string
    soldAt: string
    claimId: string
    claimToken: string
  },
): Promise<{ orderId: string; totalCents: number; oversold: ReturnType<typeof planOversoldDecrement> }> {
  const { sellerId, sale } = input
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  // Fence: only the claim's CURRENT owner may create the order. A slow original request
  // whose claim was taken over (stale > 60 s) stops here instead of racing the new owner
  // into a second order (codex security lens, PR 220).
  // One owner at a time per claim, for the WHOLE check-then-create: a fence checked once
  // could be passed by a slow original request after a takeover, and both could find no
  // order and create one (codex, PR 220 round 2). Inside the lock the token is re-checked
  // and the existing-order lookup sees whatever the previous holder created. The lock's
  // timeout is generous because Medusa uses it as the key's TTL too.
  const locking = scope.resolve(Modules.LOCKING)
  const orderId: string = await locking.execute(`in-person-oversold:${input.claimId}`, async () => {
    const fenced = await knex.raw(
      `update in_person_sale set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('oversold_fallback_at', now()::text), updated_at = now()
        where id = ? and claim_token = ? and status = 'claimed' returning id`,
      [input.claimId, input.claimToken],
    )
    if (!(fenced?.rows?.length)) throw new OversoldOwnershipLost()

    let orderId = await existingOrderFor(scope, sellerId, sale.client_id)
    if (!orderId) {
      // Prices the way a cart would price them: the variant's calculated price in the MX region.
      const { data: variants } = await query.graph({
        entity: 'variant',
        fields: ['id', 'title', 'product_id', 'product.title', 'calculated_price.calculated_amount'],
        filters: { id: sale.lines.map((l) => l.variant_id) },
        context: { calculated_price: QueryContext({ region_id: input.regionId, currency_code: 'mxn' }) },
      })
      const byId = new Map<string, any>((variants ?? []).map((v: any) => [v.id, v]))
      const items = sale.lines.map((l) => {
        const v = byId.get(l.variant_id)
        const unit = Number(v?.calculated_price?.calculated_amount)
        if (!v || !Number.isFinite(unit)) throw new Error(`no MX price for variant ${l.variant_id}`)
        return {
          title: v.product?.title ?? v.title ?? 'Producto',
          variant_id: l.variant_id,
          product_id: v.product_id,
          quantity: l.quantity,
          unit_price: unit,
        }
      })
      const { result } = await recordOversoldWorkflow(scope as any).run({
        input: {
          orders: [{
            region_id: input.regionId,
            sales_channel_id: input.channelId,
            email: input.email,
            currency_code: 'mxn',
            no_notification: true,
            items,
            metadata: {
              source: 'in_person',
              seller_id: sellerId,
              payment_method: 'cash',
              payment_received: true,
              payment_received_at: input.soldAt,
              payment_confirmed_by: 'seller_counter',
              fulfillment_method: 'in_person',
              in_person: {
                client_id: sale.client_id,
                kind: 'cash',
                tendered_cents: sale.tendered_cents,
                sold_at: input.soldAt,
                offline: true,
                receipt_email: sale.buyer_email,
              },
              // Filled in once stock is taken (below); `oversold_stock_done` marks that step
              // so a retry that adopts this order finishes it instead of skipping it.
              oversold: null,
              oversold_stock_done: false,
            },
          } as CreateOrderDTO],
        },
      })
      orderId = ((Array.isArray(result) ? result[0] : result) as any).id as string
    }
    return orderId!
  }, { timeout: 120 })

  const oversold = await takeStockOnce(scope, orderId, sale.lines)
  // Idempotent (dedupe keys): safe to call on every attempt, including an adoption.
  await appendOrderLedger(scope as never, orderId)

  const { data: totals } = await query.graph({ entity: 'order', fields: ['id', 'total'], filters: { id: orderId } })
  return { orderId, totalCents: Math.round(Number((totals?.[0] as any)?.total ?? 0)), oversold }
}

/**
 * Take the sale's stock exactly once, under the SAME locks Medusa's own reservations take
 * (core-flows reserve-inventory: `locking.execute(inventoryItemIds, …)`), so an online
 * reservation or another offline sale cannot plan against the same units in between
 * (codex, PR 220). The plan is read inside the lock; the order records the shortfall and
 * `oversold_stock_done` in the same critical section.
 */
async function takeStockOnce(
  scope: Scope,
  orderId: string,
  lines: Array<{ variant_id: string; quantity: number }>,
): Promise<ReturnType<typeof planOversoldDecrement>> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const orderService = scope.resolve(Modules.ORDER)
  const readMeta = async () => {
    const { data } = await query.graph({ entity: 'order', fields: ['id', 'metadata'], filters: { id: orderId } })
    return ((data?.[0] as any)?.metadata ?? {}) as Record<string, any>
  }
  const before = await readMeta()
  if (before.oversold_stock_done === true) return before.oversold?.lines ?? []

  const locationId = await resolveStockLocationId(scope, 'mx')
  const inventory = scope.resolve(Modules.INVENTORY)
  const { data: invRows } = await query.graph({
    entity: 'variant',
    fields: ['id', 'manage_inventory', 'inventory_items.inventory_item_id'],
    filters: { id: lines.map((l) => l.variant_id) },
  })
  const itemOf: Record<string, string | undefined> = {}
  for (const v of (invRows ?? []) as any[]) {
    const itemId = v?.inventory_items?.[0]?.inventory_item_id
    if (v?.manage_inventory && itemId && locationId) itemOf[v.id] = itemId
  }
  const keys = [...new Set(Object.values(itemOf).filter(Boolean) as string[])]

  const run = async () => {
    const meta = await readMeta()
    if (meta.oversold_stock_done === true) return (meta.oversold?.lines ?? []) as ReturnType<typeof planOversoldDecrement>
    const available: Record<string, number | null> = {}
    for (const l of lines) {
      const itemId = itemOf[l.variant_id]
      if (!itemId) { available[l.variant_id] = null; continue }
      const [level] = await inventory.listInventoryLevels({ inventory_item_id: itemId, location_id: locationId })
      available[l.variant_id] = Number(level?.stocked_quantity ?? 0) - Number(level?.reserved_quantity ?? 0)
    }
    // The plan is fixed on the FIRST attempt and stored, with each line marked applied
    // right after its own adjustment: a retry after a partial failure resumes from the
    // stored plan and skips applied lines instead of decrementing them again (codex,
    // PR 220 round 2). Residual window: a crash between one line's adjustInventory and its
    // marker write — one line, at most once.
    const plan: Array<ReturnType<typeof planOversoldDecrement>[number] & { applied?: boolean }> =
      Array.isArray(meta.oversold_plan) ? meta.oversold_plan : planOversoldDecrement(lines, available)
    let current = { ...meta, oversold_plan: plan }
    if (!Array.isArray(meta.oversold_plan)) await orderService.updateOrders(orderId, { metadata: current })
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]
      const itemId = itemOf[p.variant_id]
      if (p.applied || !itemId || !locationId || p.decrement <= 0) continue
      await inventory.adjustInventory(itemId, locationId, -p.decrement)
      plan[i] = { ...p, applied: true }
      current = { ...current, oversold_plan: plan }
      await orderService.updateOrders(orderId, { metadata: current })
    }
    const shortfall = plan
      .filter((p) => p.shortfall > 0)
      .map(({ variant_id, quantity, decrement, shortfall: short }) => ({ variant_id, quantity, decrement, shortfall: short }))
    await orderService.updateOrders(orderId, {
      metadata: { ...current, oversold: shortfall.length ? { lines: shortfall } : null, oversold_stock_done: true },
    })
    return shortfall
  }
  if (!keys.length) return run()
  const locking = scope.resolve(Modules.LOCKING)
  return locking.execute(keys, run, { timeout: 30 })
}
