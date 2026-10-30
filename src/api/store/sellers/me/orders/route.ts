/**
 * GET /store/sellers/me/orders
 *
 * Returns all Medusa orders that contain products belonging to the
 * authenticated seller.  Requires Clerk JWT in the Authorization header.
 *
 * Response: { orders: NormalizedOrder[] }
 *
 * NormalizedOrder shape mirrors the legacy Supabase marketplace_orders shape
 * so the existing frontend UI components work without changes.
 */

import { MedusaContainer } from '@medusajs/framework/types'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../_utils/clerk-auth'
import {
  resolveSellerProductIdsWithSlots,
  sellerOwnsEveryOrderItem,
} from '../../../_utils/seller-catalog-query'
import { readRentalBooking, deriveRentalBookingState } from '../../../../../lib/rental-booking'
import { deriveOrderLifecycleStatus } from '../../../../../lib/order-status-transition'
import { orderSourceOf } from '../../../../../lib/profit-ledger'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })
  const { sellerId, sellerName, sellerClerkUserId } = sellerAuth

  const orders = await listOrdersForSeller(req.scope, sellerId, sellerName, { sellerClerkUserId })
  return res.json({ orders, seller_id: sellerId })
}

/**
 * Per-stage record of what `listOrdersForSeller` actually did.
 *
 * This exists because the function degrades to `[]` at four different points and
 * used to do so SILENTLY — an empty seller order list read identically whether the
 * seller genuinely had no orders, the product resolve threw, the SQL threw, or the
 * ownership filter rejected everything. "No orders" and "I could not tell" are
 * different facts and collapsing them cost a live diagnosis (2026-08-15: every
 * seller's order page was empty and nothing anywhere said why).
 */
export type SellerOrderTrace = {
  seller_product_ids?: number
  seller_product_error?: string
  matched_order_ids?: number
  order_query_error?: string
  orders_fetched?: number
  orders_after_ownership_filter?: number
  /** Soft-deleted linked products — the known, measured ownership gap. */
  unresolved_product_slots?: number
}

export type ListOrdersForSellerOptions = {
  /**
   * The seller's Clerk id, so the normalized order can address a notification at
   * them. Absent ⇒ `null` on the wire, which is the honest answer for a caller
   * that genuinely does not know it — not a default that looks like an answer.
   */
  sellerClerkUserId?: string | null
  /** Optional collector; mutated in place. See `SellerOrderTrace`. */
  trace?: SellerOrderTrace
}

/**
 * The shared order-listing query — extracted from the Clerk-gated `GET` above
 * (ml-orders-native S3 · US-9) so the new internal agent-read bridge
 * (`internal/sellers/orders/route.ts`) can call the SAME function instead of a
 * third copy of this query. Behavior-preserving; the Clerk route's `GET` is now
 * a thin wrapper.
 */
export async function listOrdersForSeller(
  scope: MedusaContainer,
  sellerId: string,
  sellerName: string,
  options: ListOrdersForSellerOptions = {},
): Promise<ReturnType<typeof normalizeMedusaOrder>[]> {
  const { sellerClerkUserId = null, trace } = options

  // ── Get seller's product IDs ──────────────────────────────────────────────
  let sellerProductIds = new Set<string>()
  try {
    const resolved = await resolveSellerProductIdsWithSlots(scope, sellerId)
    sellerProductIds = resolved.ids
    // Soft-deleted linked products. An order whose every item is one of these stays
    // invisible to its seller — the residual gap left by removing `includeDeleted`,
    // which never worked. Reported as a number so it can be watched, not assumed zero.
    if (trace) trace.unresolved_product_slots = resolved.unresolvedSlots
    if (resolved.unresolvedSlots > 0) {
      console.warn('[seller/me/orders] seller', sellerId, 'has', resolved.unresolvedSlots,
        'soft-deleted linked product(s); orders containing only those are not listed')
    }
  } catch (e) {
    // Degrade, never die — but SAY SO. This catch was bare for months and turned
    // a hard failure into "this seller has no orders", which is a confident
    // falsehood on the one screen a merchant uses to see they made a sale.
    console.error('[seller/me/orders] seller product resolve error:', e)
    if (trace) trace.seller_product_error = String(e)
    return []
  }

  if (trace) trace.seller_product_ids = sellerProductIds.size
  if (!sellerProductIds.size) return []
  const productIds = [...sellerProductIds]

  // ── Fetch Medusa orders that contain these products ───────────────────────
  const knex = (scope as any).resolve(ContainerRegistrationKeys.PG_CONNECTION) as any

  let orders: unknown[] = []
  try {
    // Step 1: order IDs that contain the seller's products. Raw SQL via the join
    // table — order_line_item has no order_id column (it links through order_item),
    // and orderService.listLineItems does not exist on the Order service in this
    // Medusa version (it threw a TypeError → every seller's orders page was empty).
    const liRows = await knex.raw(
      `select distinct oi.order_id
         from order_item oi
         join order_line_item li on li.id = oi.item_id
        where li.product_id = ANY(?)`,
      [productIds],
    )
    const orderIds = ((liRows?.rows ?? []) as Array<{ order_id?: string }>)
      .map((r) => r.order_id)
      .filter(Boolean) as string[]

    if (trace) trace.matched_order_ids = orderIds.length
    if (!orderIds.length) return []

    // Step 2: fetch full order objects via the Remote Query (query.graph). Using
    // orderService.listOrders here throws "Shipping method version is required to
    // load adjustments" once an order has a shipping method — which silently
    // returned [] (the .catch) and made every seller's orders page look empty.
    const query = (scope as any).resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await (query as any).graph({
      entity: 'order',
      fields: [
        'id', 'status', 'payment_status', 'fulfillment_status',
        'total', 'subtotal', 'currency_code', 'email', 'metadata', 'created_at', 'updated_at',
        'items.*', 'shipping_address.*', 'customer.*', 'customer.metadata', 'fulfillments.*',
      ],
      filters: { id: orderIds },
    })
    orders = data ?? []
  } catch (e) {
    console.error('[seller/me/orders] order query error:', e)
    if (trace) trace.order_query_error = String(e)
  }

  if (trace) trace.orders_fetched = (orders as unknown[]).length

  // ── Normalize to legacy shape ─────────────────────────────────────────────
  const owned = (orders as any[])
    .filter((order) => sellerOwnsEveryOrderItem(sellerProductIds, order.items))
  if (trace) trace.orders_after_ownership_filter = owned.length

  return owned.map(o => normalizeMedusaOrder(o, sellerId, sellerName, sellerClerkUserId))
}

// ── Normalization helper ──────────────────────────────────────────────────────

export function normalizeMedusaOrder(
  order: Record<string, unknown>,
  sellerId: string,
  sellerName: string,
  /**
   * The owning seller's Clerk id. Load-bearing, not decoration: the storefront
   * addresses every seller notification (email / push / Telegram) by Clerk id, and
   * this field is the ONLY place a Medusa-backed order carries one. It was
   * hardcoded `null` here, so `dispatchToSeller` never fired for any `order_` id —
   * a buyer could report a payment and the seller was never told (2026-08-15).
   *
   * Defaults to `null` because a caller that does not know it must say so rather
   * than send a plausible-looking wrong value; callers that DO know it must pass it.
   */
  sellerClerkUserId: string | null = null,
) {
  const item = (order.items as any[])?.[0]
  const sa = order.shipping_address as Record<string, string> | undefined
  const customer = order.customer as Record<string, string> | undefined

  // Buyer personalization rides each line item's metadata (set at checkout). Surface
  // it per item so the seller (fulfillment) and the buyer can both see exactly what
  // was requested — Configurable & Personalized Products epic.
  const personalization = ((order.items as any[]) ?? [])
    .map((it: any) => {
      const p = it?.metadata?.personalization as { fields?: Array<{ id?: string; label?: string; value?: string }> } | undefined
      const fields = Array.isArray(p?.fields)
        ? p!.fields.filter(f => f && typeof f.value === 'string' && f.value.trim())
        : []
      return fields.length ? { title: (it?.title as string) ?? 'Producto', fields } : null
    })
    .filter(Boolean)

  // Raw per-item ids/qty/personalization (custom-print-products S4 · 4.3) —
  // unlike `personalization` above (filtered to items that HAVE fields), this
  // is EVERY item, so "Volver a pedir" can rebuild a configurator cart line
  // (variant selection alone, no custom fields, still needs a variant_id).
  const lineItems = ((order.items as any[]) ?? []).map((it: any) => ({
    product_id: (it?.product_id as string) ?? null,
    variant_id: (it?.variant_id as string) ?? null,
    quantity: Number(it?.quantity) || 1,
    unit_price_cents: Math.round(Number(it?.unit_price) || 0),
    personalization: (it?.metadata?.personalization ?? null) as unknown,
  }))

  const metadata = (order.metadata ?? {}) as Record<string, unknown>
  const checkoutSelection = (metadata.checkout_selection ?? {}) as Record<string, unknown>
  const support = (metadata.support ?? null) as Record<string, unknown> | null
  const isSupportOrder = support?.kind === 'support'
  const selectedFulfillment = (metadata.fulfillment_method ?? checkoutSelection.fulfillment_method ?? 'standard') as string

  // Manual payments (SPEI/cash/DiMo) are only *authorized* at checkout — the funds
  // aren't captured until the seller confirms receipt. Until then the order is
  // PENDING PAYMENT, not paid. (Card/MP orders are captured → 'paid'.)
  const paymentMethod = (metadata.payment_method as string) ?? null
  const isManualPay = ['manual', 'spei', 'cash', 'dimo'].includes(paymentMethod ?? '')
  const paymentStatus = (order.payment_status as string) ?? ''
  const isCaptured = paymentStatus === 'captured' || paymentStatus === 'partially_captured'
  const manualConfirmed = metadata.payment_received === true

  // Money that was given back (or never taken). Extracted so `status` below and
  // `payment_captured` further down cannot drift apart — they were duplicated conditions
  // once and disagreed for manual payments.
  // `payment_captured` below: did the MONEY land, and has it been given back?
  //
  // Strictly a payment fact. An earlier revision gated this on `isRefundedOrCanceled`,
  // which folds in FULFILLMENT and ORDER state — so a captured order that was later
  // returned or canceled reported `payment_captured: false` even though nothing had
  // been refunded (cross-agent review). A return is not a refund; only payment state
  // proves funds went back. Callers that want "a sale that stuck" combine this with
  // `status`, which is where returns and cancellations belong.
  //
  // `partially_refunded` counts as captured: funds were taken and some remain. Getting
  // this wrong was method-dependent in both directions (cross-agent review, twice) —
  // automatic orders fell out of `isCaptured` and reported false, while a manual order
  // with `payment_received` reported true for the identical status. Whatever the answer
  // is, it has to be the same one for both, which is why the tests assert it as a pair.
  //
  // Deliberately NOT folded into `isCaptured`: that variable drives the `status`
  // vocabulary, and widening it would silently relabel existing orders.
  const isPartiallyRefunded = paymentStatus === 'partially_refunded'
  const isPaymentRefunded = paymentStatus === 'refunded'
  const hasCapturedFunds =
    !isPaymentRefunded &&
    (isCaptured || isPartiallyRefunded || (isManualPay && manualConfirmed))

  const status = deriveOrderLifecycleStatus(order)

  // Manual-payment state machine (mirrors the frontend lib/manual-payment-state.ts
  // vocabulary so the UCP/MCP order object an agent reads carries the same state).
  // pending_payment → buyer_reported_paid → payment_confirmed → processing.
  const buyerReportedPaid = metadata.buyer_reported_paid === true
  const paymentConfirmed = isCaptured || manualConfirmed
  const fulfillmentStarted = ['processing', 'shipped', 'in_transit', 'delivered', 'fulfilled', 'completed'].includes(status)
  const manualPaymentState = !isManualPay
    ? null
    : paymentConfirmed
      ? (fulfillmentStarted ? 'processing' : 'payment_confirmed')
      : buyerReportedPaid
        ? 'buyer_reported_paid'
        : 'pending_payment'

  // Refund-state machine (mirrors the frontend lib/refund-state.ts vocabulary so the
  // UCP/MCP order object an agent reads carries the same derived refund_state). The
  // off-platform SPEI/cash rail walks solicitado → aceptado → transferencia_pendiente →
  // confirmado (buyer confirms receipt); card/escrow refunds auto-confirm.
  const rr = (metadata.return_request ?? null) as Record<string, unknown> | null
  const refundState: string = (() => {
    if (!rr || !rr.status) return 'none'
    if (rr.status === 'requested') return 'solicitado'
    if (rr.status === 'declined') return 'rechazado'
    const refundStatus = (rr.refund_status as string | null) ?? null
    if (refundStatus === 'refunded' || refundStatus === 'voided') return 'confirmado'
    if (refundStatus === 'manual') {
      if (rr.buyer_confirmed_at) return 'confirmado'
      if (rr.transfer_sent_at || rr.refunded_at) return 'transferencia_pendiente'
      return 'aceptado'
    }
    return 'aceptado'
  })()

  // Pickup-appointment machine (Delivery & Manual-Money Polish S2 — mirrors the frontend
  // lib/pickup-appointment.ts vocabulary so the UCP/MCP order object an agent reads carries
  // the same derived state). The buyer proposes a date + window at checkout (propuesta), the
  // seller confirms (confirmada) or reschedules (back to propuesta, proposed_by seller).
  const pa = (metadata.pickup_appointment ?? null) as Record<string, unknown> | null
  const pickupAppointmentState: string = (() => {
    if (!pa || !pa.status) return 'none'
    if (pa.status === 'confirmada') return 'confirmada'
    if (pa.status === 'propuesta') return 'propuesta'
    return 'none'
  })()

  // Rental booking (rental line-item pricing S1.3): the derived state both sides +
  // agents read, plus the raw block so order pages / emails / the ledger render the
  // breakdown (noches × tarifa · depósito · total) without a second fetch. Absent for
  // every non-rental order → 'none' / null (frontend reads rental_booking_state ?? 'none').
  const rentalBooking = readRentalBooking(metadata)
  const rentalBookingState = deriveRentalBookingState(rentalBooking)

  const buyerName = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null
    : null

  // Buyer's Clerk id (buyer-notifications-money-path S1.1) — stamped on the Medusa
  // customer at checkout (resolveOrCreateBuyerCustomer, start-checkout/route.ts) as
  // customer.metadata.clerk_user_id. null for guest orders (no customer link).
  const customerMetadata = (customer as unknown as { metadata?: Record<string, unknown> } | undefined)?.metadata
  const rawBuyerClerkUserId = customerMetadata?.clerk_user_id
  const buyerClerkUserId = typeof rawBuyerClerkUserId === 'string' && rawBuyerClerkUserId.length > 0
    ? rawBuyerClerkUserId
    : null

  // Which marketplace sold this (ml-orders-native S1 · US-3) — a DIFFERENT axis
  // from any buyer-traffic `channel` concept: this is "Mercado Libre vs Miyagi",
  // stamped by `materializeMlOrder` at order-creation time. `metadata` is already
  // selected above, so no query change is needed — just surface it top-level
  // (normalizeMedusaOrder curates; it never passes raw metadata through).
  // in-person-sales S2.3: counter and payment-link sales keep their own source so the
  // inbox can badge and filter them; anything else stays the online default 'miyagi'.
  const ledgerSource = orderSourceOf(metadata)
  const source = ledgerSource === 'native' ? 'miyagi' : ledgerSource

  // Free-form seller tags (ml-orders-native S3 · US-7) — manual CRUD via
  // `[id]/tags`, plus the automatic 'mercadolibre' tag stamped at materialization.
  // No native Medusa order-tags concept exists (unlike Product), so this rides
  // metadata like every other cross-cutting order flag on this page.
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((t): t is string => typeof t === 'string')
    : []

  return {
    id: order.id,
    status,
    source,
    tags,
    ml_order_id: source === 'mercadolibre' ? ((metadata.ml_order_id as string) ?? null) : null,
    ml_pack_id: source === 'mercadolibre' ? ((metadata.ml_pack_id as string) ?? null) : null,
    amount_cents: isSupportOrder ? (support.amount_cents ?? order.total ?? 0) : (order.total ?? 0),
    currency: ((order.currency_code as string) ?? 'mxn').toUpperCase(),
    shipping_method: isSupportOrder ? 'support' : selectedFulfillment,
    shipping_cost_cents: 0,
    // The carrier the BUYER selected at checkout (start-checkout's
    // normalizeShippingQuote → metadata.shipping_carrier) — e.g. 'correos_mx'
    // for a Correos Impresos order. Distinct from marketplace_shipments[0].carrier
    // below, which only exists once the seller has actually shipped; this lets
    // the ship form pre-fill the right manual carrier BEFORE that happens
    // (shipping-provider-expansion S3.4).
    checkout_shipping_carrier: (metadata.shipping_carrier as string | undefined) ?? null,
    // Direct-payment fields so the buyer order/success page can show instructions
    // and the pending-payment state.
    payment_method: (metadata.payment_method as string) ?? null,
    payment_received: metadata.payment_received === true,
    // Raw Medusa payment state + the derived "money actually landed" answer.
    //
    // WHY THIS IS EXPOSED (MiyagiSanchez-Storefront#298, fresh-reviewer finding): `status`
    // above is NOT an assertion that payment was captured. It initialises to 'paid' and
    // is only demoted for cancel/refund/return or a MANUAL method that is not yet
    // captured — so a card/MercadoPago order sitting at `payment_status: 'authorized'`
    // normalises to 'paid'. Every consumer that reads `status === 'paid'` as "we have the
    // money" is therefore reading a fall-through default. That is harmless for the seller
    // order list it was written for (which shows lifecycle, not accounting) and NOT
    // harmless for the merchant-lifecycle projection, whose `first_sale` milestone is
    // write-once and unwithdrawable.
    //
    // `payment_captured` is the honest answer and is deliberately narrow: real capture
    // for automatic methods, or the seller's explicit confirmation of receipt for manual
    // ones (SPEI/cash/DiMo are only ever *authorized* at checkout — `payment_received` is
    // how the money is acknowledged).
    //
    // THE CONTRACT, as a RULE rather than a value list — Medusa v2's PaymentStatus union
    // has ten members (`not_paid | awaiting | authorized | partially_authorized |
    // captured | partially_captured | partially_refunded | refunded | canceled |
    // requires_action`) and an enumeration here would go stale the moment one is added:
    //
    //   1. `payment_status === 'refunded'`  → FALSE, always, on both methods.
    //   2. otherwise `captured` / `partially_captured` / `partially_refunded` → true
    //   3. otherwise a MANUAL method with `payment_received` → true
    //   4. otherwise → false
    //
    // Rule 3 is why an unrecognised or absent payment_status still reports true for a
    // manual order the seller has confirmed: Medusa's payment-collection state is not
    // authoritative for money that moved off-platform. Everything unmatched falls to
    // rule 4, which fails closed — the safe direction for a write-once consumer.
    //
    // A return or a cancellation does NOT appear above, deliberately: those are
    // fulfillment and order state, and neither proves the money went back. A caller wanting "a sale that
    // stuck" reads `status` (which is 'refunded' for those orders) alongside this.
    // Splitting the two axes is deliberate — three cross-agent rounds each caught this
    // field quietly meaning slightly more than its name, in a different direction each
    // time (the payment method, then a refund sub-state, then fulfillment).
    payment_status: paymentStatus || null,
    payment_captured: hasCapturedFunds,
    // Durable manual-payment lifecycle (Sprint 1): the buyer's "Ya hice el pago"
    // persists here and survives reload; manual_payment_state is the shared vocabulary.
    buyer_reported_paid: buyerReportedPaid,
    buyer_reported_paid_at: (metadata.buyer_reported_paid_at as string) ?? null,
    manual_payment_state: manualPaymentState,
    manual_payment: (metadata.manual_payment ?? null) as unknown,
    // Two-sided refund lifecycle (Delivery & Manual-Money Polish S1): the derived state
    // both sides + agents read, plus the raw record so the order pages can render detail
    // without a second fetch. refund_state ?? 'none' degrades gracefully pre-deploy.
    refund_state: refundState,
    return_request: rr,
    // Pickup appointment (S2): the derived state both sides + agents read, plus the raw
    // record so the order pages render the slot without a second fetch. Degrades to
    // 'none' / null pre-deploy (frontend reads pickup_appointment_state ?? 'none').
    pickup_appointment_state: pickupAppointmentState,
    pickup_appointment: pa,
    // Rental booking (S1.3): derived state + raw block so both order pages, both
    // emails, and the in-chat ledger render the dates + itemized deposit (Sprint 2
    // consumes these). Null / 'none' on every non-rental order — byte-for-byte
    // unchanged for today's orders.
    rental_booking_state: rentalBookingState,
    rental_booking: rentalBooking,
    event_tickets: Array.isArray(metadata.event_tickets) ? metadata.event_tickets : [],
    buyer_name: buyerName,
    buyer_email: (order.email as string) ?? customer?.email ?? null,
    buyer_clerk_user_id: buyerClerkUserId,
    // Per-line-item buyer personalization (empty array when none).
    personalization,
    // Raw per-item ids/qty/personalization for reorder (custom-print-products S4 · 4.3).
    line_items: lineItems,
    // Lightweight proof-of-print sign-off (custom-print-products S4 · 4.1):
    // a durable order-metadata flag pair, same curation discipline as
    // `tags`/`refund_state` above. Advisory only — never gates shipping.
    proof_sent: metadata.proof_sent === true,
    proof_sent_at: (metadata.proof_sent_at as string) ?? null,
    proof_image_url: (metadata.proof_image_url as string) ?? null,
    proof_size: (metadata.proof_size as string) ?? null,
    proof_quantity: typeof metadata.proof_quantity === 'number' ? metadata.proof_quantity : null,
    proof_price_cents: typeof metadata.proof_price_cents === 'number' ? metadata.proof_price_cents : null,
    proof_approved: metadata.proof_approved === true,
    proof_approved_at: (metadata.proof_approved_at as string) ?? null,
    support: isSupportOrder ? support : null,
    created_at: order.created_at,
    updated_at: order.updated_at,
    shipping_address: sa ? {
      name: [sa.first_name, sa.last_name].filter(Boolean).join(' '),
      line1: sa.address_1 ?? '',
      line2: sa.address_2 ?? '',
      city: sa.city ?? '',
      state: sa.province ?? '',
      postal_code: sa.postal_code ?? '',
      country: sa.country_code ?? 'MX',
    } : null,
    // Nested shapes that the UI expects
    marketplace_listings: {
      id: (item?.product_id as string) ?? (order.id as string),
      title: isSupportOrder ? 'Apoyo / contribución' : ((item?.title as string) ?? 'Producto'),
      images: item?.thumbnail ? [{ url: item.thumbnail as string }] : null,
      listing_type: isSupportOrder ? 'support' : 'product',
      metadata: isSupportOrder ? support : null,
    },
    marketplace_shops: {
      id: sellerId,
      name: sellerName,
      slug: '',
      clerk_user_id: sellerClerkUserId,
      metadata: null,
    },
    marketplace_shipments: (() => {
      // Prefer the shipment we persist on the order (set by the seller PATCH route).
      const sh = (metadata.shipment ?? null) as Record<string, any> | null
      if (sh && (sh.tracking_number || sh.carrier || sh.status)) {
        return [{
          id: `${order.id}_ship`,
          carrier: sh.carrier ?? 'manual',
          tracking_number: sh.tracking_number ?? null,
          label_url: sh.label_url ?? null,
          status: sh.status ?? 'label_created',
          estimated_delivery_date: sh.estimated_delivery_date ?? null,
          weight_grams: null,
          envia_shipment_id: null,
          created_at: sh.created_at ?? order.created_at,
        }]
      }
      // Fallback: native Medusa fulfillments (legacy / future full-fulfillment).
      return ((order.fulfillments as any[]) ?? []).length > 0
        ? ((order.fulfillments as any[]).map((f: any) => ({
            id: f.id,
            carrier: f.data?.carrier ?? 'manual',
            tracking_number: f.labels?.[0]?.tracking_number ?? f.tracking_numbers?.[0]?.tracking_number ?? null,
            label_url: f.labels?.[0]?.label_url ?? f.data?.label_url ?? null,
            status: f.delivered_at ? 'delivered' : f.shipped_at ? 'shipped' : 'label_created',
            estimated_delivery_date: null,
            weight_grams: null,
            envia_shipment_id: null,
            created_at: f.created_at,
          })))
        : null
    })(),
    // Mark as Medusa-backed for routing decisions in the frontend
    _source: 'medusa',
    _medusa_order_id: order.id,
  }
}
