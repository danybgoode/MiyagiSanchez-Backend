/**
 * GET /store/customers/me/orders
 *
 * Returns all Medusa orders for the authenticated buyer (identified by Clerk JWT).
 * Used to power the buyer's /account/orders page in the frontend.
 *
 * Auth: Clerk JWT in Authorization header.
 *
 * Response: { orders: NormalizedOrder[] }
 * (same NormalizedOrder shape as /store/sellers/me/orders — mirrors legacy Supabase shape)
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { normalizeMedusaOrder } from '../../../sellers/me/orders/route'
import { resolveBuyerCustomerIds } from '../../../_utils/clerk-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  // Resolve ALL customer ids + emails for this buyer.
  const { clerkUserId, customerIds, emails } = await resolveBuyerCustomerIds(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Unauthorized' })
  }
  if (!customerIds.length && !emails.length) {
    return res.json({ orders: [] })
  }

  // ── Fetch orders by customer_id AND by email ──────────────────────────────
  // Manual orders aren't mirrored and can end up with a null/mismatched
  // customer_id; the order email (set from the cart) is the reliable fallback so
  // the buyer still sees + can open their order. (query.graph, not listOrders —
  // listOrders throws "Shipping method version is required" once a method exists.)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const fields = [
    'id', 'status', 'payment_status', 'fulfillment_status',
    'total', 'subtotal', 'currency_code', 'email', 'customer_id', 'metadata', 'created_at', 'updated_at',
    'items.*', 'shipping_address.*', 'fulfillments.*',
  ]
  const byId = new Map<string, any>()
  async function fetchBy(filters: Record<string, unknown>) {
    try {
      const { data } = await (query as any).graph({ entity: 'order', fields, filters })
      for (const o of (data ?? []) as any[]) byId.set(o.id, o)
    } catch (e) {
      console.error('[customers/me/orders] order query error:', e)
    }
  }
  if (customerIds.length) await fetchBy({ customer_id: customerIds })
  if (emails.length) await fetchBy({ email: emails })
  let orders: any[] = [...byId.values()]

  // ── Exclude print-ad placements — they live in /account/print-ads ─────────
  const productIds = [...new Set(
    orders.flatMap((o) => ((o.items ?? []) as any[]).map((i) => i.product_id).filter(Boolean)),
  )]
  if (productIds.length) {
    const printProductIds = new Set<string>()
    try {
      const { data: prods } = await (query as any).graph({
        entity: 'product', fields: ['id', 'metadata'], filters: { id: productIds },
      })
      for (const p of (prods ?? []) as any[]) if (p.metadata?.is_print_placement) printProductIds.add(p.id)
    } catch { /* best-effort */ }
    if (printProductIds.size) {
      orders = orders.filter((o) => {
        const items = (o.items ?? []) as any[]
        return items.length === 0 || !items.every((i) => printProductIds.has(i.product_id))
      })
    }
  }

  // ── Normalize (multi-seller; frontend enriches seller from Supabase) ──────
  // Seller-only fields never reach the buyer (in-person oversell shortfalls; verifier, PR 460).
  const normalized = orders.map((o) => {
    const { in_person_oversold: _sellerOnly, ...forBuyer } = normalizeMedusaOrder(o, '', '')
    return forBuyer
  })
  return res.json({ orders: normalized, customer_ids: customerIds })
}
