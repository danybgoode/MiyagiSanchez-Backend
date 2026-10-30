/**
 * profit-ledger-write — the I/O composer for the append-only financial ledger
 * (profit-analyzer S1 · US-2). One entry point, `appendOrderLedger(scope,
 * orderId)`, shared by every write point (order.placed subscriber, the
 * post-materialize ML hook, the backfill route): loads the order, branches on
 * its `metadata.source`, resolves COGS from variant metadata + the seller id,
 * builds events via the PURE `profit-ledger` seam, and appends exactly-once.
 *
 * Contract: BEST-EFFORT and flag-gated. Never throws (a ledger hiccup must
 * never affect order placement / ML apply / shipping); gated on
 * `ops.profit_enabled` so the whole surface ships dark; every write is
 * idempotent (deterministic dedupe keys + the DB unique constraint), so the
 * backfill route can replay any order at any time to heal gaps.
 */

import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { logger } from './logger'
import { isEnabled } from './flags'
import { PROFIT_MODULE } from '../modules/profit'
import type ProfitModuleService from '../modules/profit/service'
import { MERCADOLIBRE_MODULE } from '../modules/mercadolibre'
import type MercadolibreModuleService from '../modules/mercadolibre/service'
import {
  buildNativeOrderEvents,
  buildMlOrderEvents,
  buildNativeShippingEvent,
  orderSourceOf,
  type NativeOrderLine,
} from './profit-ledger'

type Scope = { resolve: (key: string) => any }

type OrderRow = {
  id: string
  currency_code?: string | null
  created_at?: string | Date | null
  metadata?: Record<string, unknown> | null
  items?: Array<{
    id: string
    variant_id?: string | null
    product_id?: string | null
    quantity?: unknown
    unit_price?: unknown
  }> | null
}

async function loadOrder(scope: Scope, orderId: string): Promise<OrderRow | null> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'order',
    fields: ['id', 'currency_code', 'created_at', 'metadata', 'items.*'],
    filters: { id: orderId },
  })
  return (data?.[0] as OrderRow | undefined) ?? null
}

/** variant_id → unit_cost_cents (only well-formed integer costs; else absent). */
async function loadVariantCosts(scope: Scope, variantIds: string[]): Promise<Map<string, number>> {
  const costs = new Map<string, number>()
  if (variantIds.length === 0) return costs
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'product_variant',
    fields: ['id', 'metadata'],
    filters: { id: variantIds },
  })
  for (const row of (data ?? []) as Array<{ id: string; metadata?: Record<string, unknown> | null }>) {
    const cost = row.metadata?.unit_cost_cents
    if (typeof cost === 'number' && Number.isInteger(cost) && cost >= 0) costs.set(row.id, cost)
  }
  return costs
}

/** The seller owning `productId`, via the product↔seller link (best-effort). */
async function resolveSellerIdByProduct(scope: Scope, productId: string): Promise<string | null> {
  try {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: 'product',
      fields: ['id', 'seller.id'],
      filters: { id: productId },
    })
    return ((data?.[0] as any)?.seller?.id as string | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * Append the ledger events a sale produces (revenue / ml_fee / cogs_snapshot
 * / ML shipping) for one order. Both sources; replay-safe; never throws.
 * Returns what happened for observability, or null when gated/skipped.
 */
export async function appendOrderLedger(
  scope: Scope,
  orderId: string,
): Promise<{ appended: number; skipped: number } | null> {
  try {
    if (!(await isEnabled('ops.profit_enabled'))) return null
    const order = await loadOrder(scope, orderId)
    if (!order) return null

    const meta = (order.metadata ?? {}) as Record<string, unknown>
    const source = orderSourceOf(meta)
    const currency = (order.currency_code || 'mxn').toLowerCase()
    const capturedAt = order.created_at ? new Date(order.created_at) : new Date()
    const items = (order.items ?? []).filter((i) => !!i?.id)

    const profit = scope.resolve(PROFIT_MODULE) as ProfitModuleService

    if (source === 'mercadolibre') {
      // The Medusa seller id was stamped at materialization (Epic A).
      const sellerId = typeof meta.ml_seller_id === 'string' ? meta.ml_seller_id : null
      // The link's ML item id, via the product↔ML-item link (a materialized
      // order is per-link, so every line shares one product).
      const productId = items[0]?.product_id ?? null
      if (!productId) return null
      const ml = scope.resolve(MERCADOLIBRE_MODULE) as MercadolibreModuleService
      const [link] = await (ml as any).listProductMlLinks({ product_id: productId }, { take: 1 })
      const mlItemId = (link?.ml_item_id as string | undefined) ?? null
      if (!mlItemId) return null

      const variantId = items[0]?.variant_id ?? null
      const costs = await loadVariantCosts(scope, variantId ? [variantId] : [])

      // Line-id mapping is only unambiguous for the single-line case (the
      // overwhelmingly common one); multi-line orders fall back to the pure
      // builder's deterministic index qualifier.
      const lineIds = items.length === 1 ? [items[0].id] : []

      const events = buildMlOrderEvents({
        order_id: order.id,
        seller_id: sellerId,
        currency_code: currency,
        captured_at: capturedAt,
        ml_item_id: mlItemId,
        ml_raw_order: meta.ml_raw_order,
        ml_raw_shipment: meta.ml_raw_shipment,
        order_line_ids: lineIds,
        unit_cost_cents: variantId != null ? (costs.get(variantId) ?? null) : null,
      })
      return await profit.appendFinancialEvents(events)
    }

    // Native order.
    const firstProductId = items[0]?.product_id ?? null
    const sellerId = firstProductId ? await resolveSellerIdByProduct(scope, firstProductId) : null
    const variantIds = [...new Set(items.map((i) => i.variant_id).filter((v): v is string => !!v))]
    const costs = await loadVariantCosts(scope, variantIds)

    const lines: NativeOrderLine[] = items.map((i) => ({
      line_id: i.id,
      quantity: typeof i.quantity === 'number' ? i.quantity : Number(i.quantity ?? 0),
      unit_price_cents: typeof i.unit_price === 'number' ? i.unit_price : Number(i.unit_price ?? 0),
      unit_cost_cents: i.variant_id ? (costs.get(i.variant_id) ?? null) : null,
    }))

    const events = buildNativeOrderEvents({
      source,
      order_id: order.id,
      seller_id: sellerId,
      currency_code: currency,
      captured_at: capturedAt,
      lines,
    })
    return await profit.appendFinancialEvents(events)
  } catch (e) {
    logger.error('profit-ledger', 'appendOrderLedger failed (non-fatal)', { orderId, error: e })
    return null
  }
}

/**
 * Append the shipping-cost follow-up event when an Envia label is bought for
 * a native order (the ship route's write point). Best-effort, flag-gated,
 * idempotent — a re-generated label for the same order is a no-op.
 */
export async function appendNativeShippingLedger(
  scope: Scope,
  input: { orderId: string; amountCents: number; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    if (!(await isEnabled('ops.profit_enabled'))) return
    const order = await loadOrder(scope, input.orderId)
    if (!order) return
    const firstProductId = order.items?.[0]?.product_id ?? null
    const sellerId = firstProductId ? await resolveSellerIdByProduct(scope, firstProductId) : null
    const event = buildNativeShippingEvent({
      order_id: input.orderId,
      seller_id: sellerId,
      currency_code: (order.currency_code || 'mxn').toLowerCase(),
      captured_at: new Date(),
      amount_cents: input.amountCents,
      metadata: input.metadata,
    })
    if (!event) return
    const profit = scope.resolve(PROFIT_MODULE) as ProfitModuleService
    await profit.appendFinancialEvents([event])
  } catch (e) {
    logger.error('profit-ledger', 'appendNativeShippingLedger failed (non-fatal)', {
      orderId: input.orderId,
      error: e,
    })
  }
}
