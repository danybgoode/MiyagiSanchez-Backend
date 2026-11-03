import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { PROFIT_MODULE } from '../../../modules/profit'
import type ProfitModuleService from '../../../modules/profit/service'

/**
 * ONE seller's financial-events ledger, with just enough order/line enrichment (titles, product ids) for the
 * storefront's pure margin math (`lib/profit.ts`) to aggregate per order and per SKU.
 *
 * Extracted from `GET /store/sellers/me/profit` (profit-analyzer S1 · US-3) so the internal read for the monthly
 * business check-in (`GET /internal/profit/ledger`, business-infrastructure D12) returns the SAME shape from the SAME
 * code — two copies of a ledger read drift, and the plan would then disagree with «Ganancias» about the same sales.
 *
 * The caller has already proven who the seller is (a Clerk token, or the internal secret + a server-side lookup).
 * This function scopes every read by that seller id and nothing else.
 */

export const MAX_LEDGER_EVENTS = 1000

export interface LedgerRead {
  events: Array<Record<string, unknown>>
  orders: Array<Record<string, unknown>>
}

export async function readSellerLedger(scope: { resolve: (key: string) => unknown }, sellerId: string): Promise<LedgerRead> {
  const profit = scope.resolve(PROFIT_MODULE) as ProfitModuleService
  const events = await profit.listFinancialEvents(
    { seller_id: sellerId },
    { take: MAX_LEDGER_EVENTS, order: { captured_at: 'DESC' } },
  )

  // Enrich: order display data + line → product/title map for SKU grouping.
  const orderIds: string[] = [...new Set(events.map((e: { order_id: string }) => e.order_id))]
  let orders: Array<Record<string, unknown>> = []
  if (orderIds.length > 0) {
    try {
      const query = scope.resolve(ContainerRegistrationKeys.QUERY) as { graph: (q: unknown) => Promise<{ data?: unknown[] }> }
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
        source: (o.metadata as Record<string, unknown> | null)?.source === 'mercadolibre' ? 'mercadolibre' : 'native',
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

  return {
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
  }
}
