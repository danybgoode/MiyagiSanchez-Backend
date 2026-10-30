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
 * Exactly once: the claim is still held by this caller's token (D4). Before creating, any
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

export async function recordOversoldOfflineSale(
  scope: Scope,
  input: {
    sellerId: string
    sale: InPersonSaleInput
    regionId: string
    channelId: string
    email: string
    soldAt: string
  },
): Promise<{ orderId: string; totalCents: number; oversold: ReturnType<typeof planOversoldDecrement> }> {
  const { sellerId, sale } = input
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)

  const adopted = await existingOrderFor(scope, sellerId, sale.client_id)
  if (adopted) {
    const { data } = await query.graph({ entity: 'order', fields: ['id', 'total', 'metadata'], filters: { id: adopted } })
    const o = data?.[0] as any
    return { orderId: adopted, totalCents: Math.round(Number(o?.total ?? 0)), oversold: o?.metadata?.oversold?.lines ?? [] }
  }

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

  // Stock: what each variant still has at the MX location (null = unmanaged).
  const locationId = await resolveStockLocationId(scope, 'mx')
  const inventory = scope.resolve(Modules.INVENTORY)
  const available: Record<string, number | null> = {}
  const itemOf: Record<string, string | undefined> = {}
  const { data: invRows } = await query.graph({
    entity: 'variant',
    fields: ['id', 'manage_inventory', 'inventory_items.inventory_item_id'],
    filters: { id: sale.lines.map((l) => l.variant_id) },
  })
  for (const v of (invRows ?? []) as any[]) {
    const itemId = v?.inventory_items?.[0]?.inventory_item_id
    if (!v?.manage_inventory || !itemId || !locationId) { available[v.id] = null; continue }
    const [level] = await inventory.listInventoryLevels({ inventory_item_id: itemId, location_id: locationId })
    available[v.id] = Number(level?.stocked_quantity ?? 0) - Number(level?.reserved_quantity ?? 0)
    itemOf[v.id] = itemId
  }
  const plan = planOversoldDecrement(sale.lines, available)
  const shortfall = plan.filter((p) => p.shortfall > 0)

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
          // D12: the inbox flags this order «Vendiste más de lo que tenías en inventario».
          oversold: shortfall.length ? { lines: shortfall } : null,
        },
      } as CreateOrderDTO],
    },
  })
  const order = (Array.isArray(result) ? result[0] : result) as any
  const orderId = order.id as string

  // Decrement AFTER the order exists: a crash here leaves an order with its stock not yet
  // taken (the shortfall is still recorded) — the opposite order could take stock for a
  // sale that was never recorded, which is the failure this sprint exists to prevent.
  for (const p of plan) {
    const itemId = itemOf[p.variant_id]
    if (itemId && locationId && p.decrement > 0) await inventory.adjustInventory(itemId, locationId, -p.decrement)
  }
  await appendOrderLedger(scope as never, orderId)

  const { data: totals } = await query.graph({ entity: 'order', fields: ['id', 'total'], filters: { id: orderId } })
  return { orderId, totalCents: Math.round(Number((totals?.[0] as any)?.total ?? 0)), oversold: shortfall }
}
