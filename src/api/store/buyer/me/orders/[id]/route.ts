/**
 * GET /store/customers/me/orders/:id
 *
 * Full detail for ONE Medusa order belonging to the authenticated buyer
 * (identified by Clerk JWT → Medusa customer.external_id). Powers the buyer
 * order-detail page /account/orders/[id] for Medusa-backed orders.
 *
 * Auth: Clerk JWT in the Authorization header.
 * Response: { order: NormalizedOrder } — same shape as the list endpoint, so
 * the existing OrderTrackingClient renders it unchanged.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { normalizeMedusaOrder } from '../../../../sellers/me/orders/route'
import { resolveBuyerCustomerIds } from '../../../../_utils/clerk-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  // Resolve ALL of the buyer's customer ids (external_id + shared email) so an
  // order linked to either the auth-flow or synced customer passes the check.
  const { clerkUserId, customerIds, emails } = await resolveBuyerCustomerIds(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Unauthorized' })
  }
  if (!customerIds.length && !emails.length) return res.status(404).json({ message: 'Order not found' })

  const { id: orderId } = req.params
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  // ── Fetch the order ───────────────────────────────────────────────────────
  // Via query.graph — retrieveOrder can throw "Shipping method version is required
  // to load adjustments" once the order has a shipping method.
  let order: Record<string, unknown>
  try {
    const { data } = await (query as any).graph({
      entity: 'order',
      fields: [
        'id', 'status', 'payment_status', 'fulfillment_status',
        'total', 'subtotal', 'currency_code',
        'email', 'customer_id', 'metadata', 'created_at', 'updated_at',
        'items.*', 'shipping_address.*', 'fulfillments.*',
      ],
      filters: { id: orderId },
    })
    const result = (data ?? [])[0]
    if (!result) return res.status(404).json({ message: 'Order not found' })
    order = result as Record<string, unknown>
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  // ── Ownership check — buyer can only see their own order ──────────────────
  // Ownership: customer_id match, OR (fallback for manual orders with a null/
  // mismatched customer_id) the order email matches one of the buyer's emails.
  const ownsByCustomer = !!order.customer_id && customerIds.includes(order.customer_id as string)
  const ownsByEmail = !!order.email && emails.includes(String(order.email).toLowerCase())
  if (!ownsByCustomer && !ownsByEmail) {
    return res.status(404).json({ message: 'Order not found' })
  }

  // ── Enrich the seller from the first item's product → seller link ─────────
  //
  // `seller.clerk_user_id` is read here, not just the name, because this route is
  // what the storefront's `resolveSellerForOrder` calls before notifying a seller
  // that their buyer reported a payment. Omitting it made that lookup return null
  // and the seller was never told a sale had happened (2026-08-15).
  let sellerId = ''
  let sellerName = ''
  let sellerClerkUserId: string | null = null
  const firstProductId = ((order.items as any[]) ?? [])[0]?.product_id as string | undefined
  if (firstProductId) {
    try {
      const { data } = await query.graph({
        entity: 'product',
        fields: ['id', 'seller.id', 'seller.name', 'seller.clerk_user_id'],
        filters: { id: firstProductId },
      })
      const seller = (data?.[0] as any)?.seller
      sellerId = seller?.id ?? ''
      sellerName = seller?.name ?? ''
      // An unclaimed (supply-imported) shop genuinely has no Clerk owner. Keep that
      // as null rather than '' — "nobody to notify" is a fact, not an empty string.
      sellerClerkUserId = typeof seller?.clerk_user_id === 'string' && seller.clerk_user_id
        ? seller.clerk_user_id
        : null
    } catch { /* seller enrichment is best-effort */ }
  }

  // Seller-only fields never reach the buyer (in-person oversell shortfalls; verifier, PR 460).
  const { in_person_oversold: _sellerOnly, ...forBuyer } = normalizeMedusaOrder(order, sellerId, sellerName, sellerClerkUserId)
  return res.json({ order: forBuyer })
}
