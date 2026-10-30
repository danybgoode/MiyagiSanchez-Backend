import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../_utils/clerk-auth'
import { isEnabled } from '../../../../../lib/flags'
import { orderSourceOf } from '../../../../../lib/profit-ledger'
import { PROFIT_MODULE } from '../../../../../modules/profit'
import type ProfitModuleService from '../../../../../modules/profit/service'

/**
 * GET /store/sellers/me/profit — the seller's financial-events ledger, with
 * just enough order/line enrichment (titles, product ids) for the frontend's
 * pure margin math (`lib/profit.ts`) to aggregate per order and per SKU.
 * Raw events out, no margin math here — the calc lives in ONE pure, spec'd
 * seam on the frontend (profit-analyzer S1 · US-3).
 *
 * Gate order: flag → auth (LEARNINGS — the flag decides whether the route
 * "exists" before any other gate answers).
 */

const MAX_EVENTS = 1000

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await isEnabled('ops.profit_enabled'))) {
    return res.status(404).json({ message: 'Not found' })
  }

  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })

  const profit = req.scope.resolve(PROFIT_MODULE) as ProfitModuleService
  const events = await profit.listFinancialEvents(
    { seller_id: sellerAuth.sellerId },
    { take: MAX_EVENTS, order: { captured_at: 'DESC' } },
  )

  // Enrich: order display data + line → product/title map for SKU grouping.
  const orderIds: string[] = [...new Set(events.map((e: { order_id: string }) => e.order_id))]
  let orders: Array<Record<string, unknown>> = []
  if (orderIds.length > 0) {
    try {
      const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({
        entity: 'order',
        fields: ['id', 'display_id', 'created_at', 'currency_code', 'metadata',
          'items.id', 'items.product_id', 'items.variant_id', 'items.title', 'items.quantity'],
        filters: { id: orderIds },
      })
      orders = ((data ?? []) as Array<Record<string, unknown>>).map((o) => ({
        id: o.id,
        display_id: o.display_id ?? null,
        created_at: o.created_at ?? null,
        currency_code: o.currency_code ?? null,
        source: orderSourceOf(o.metadata),
        items: ((o.items ?? []) as Array<Record<string, unknown>>).map((i) => ({
          id: i.id,
          product_id: i.product_id ?? null,
          variant_id: i.variant_id ?? null,
          title: i.title ?? null,
          quantity: i.quantity ?? null,
        })),
      }))
    } catch (e) {
      console.error('[profit] order enrichment failed (degrading to events-only)', e)
    }
  }

  return res.json({
    events: events.map((e: Record<string, unknown>) => ({
      id: e.id,
      order_id: e.order_id,
      order_line_id: e.order_line_id ?? null,
      source: e.source,
      event_type: e.event_type,
      amount_cents: e.amount_cents,
      currency_code: e.currency_code,
      captured_at: e.captured_at,
    })),
    orders,
  })
}
