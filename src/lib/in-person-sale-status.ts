/**
 * In-person sale — status and cancel for card / transfer sales (in-person-sales S2, D9/D10).
 *
 * The counter polls `getInPersonSaleStatus` while the buyer pays on their own phone.
 * Every answer is read from Medusa — the claim, the cart's own `order_cart` link, the
 * order's payment — never from anything the client says. "Paid" exists only once the
 * shop's provider webhook has turned the cart into an order.
 *
 * Money taken is never hidden: if the buyer pays in the seconds after the merchant
 * cancelled, the cart still became a paid order, and the status reports `paid`.
 */
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import Stripe from 'stripe'
import { IN_PERSON_MODULE } from '../modules/in-person'
import { SELLER_MODULE } from '../modules/seller'
import { resolveSellerMpToken } from '../api/store/_utils/mp'
import { readStripePaymentContext } from './stripe-market-strategy'

type Scope = { resolve: (key: string) => any }

export type InPersonSaleState =
  | 'awaiting_payment'      // card: QR shown, buyer has not paid · transfer: not yet completed
  | 'pending_confirmation'  // transfer: the order exists, the merchant has not said «Ya me llegó»
  | 'paid'                  // the money is confirmed (webhook-captured card, confirmed transfer, cash)
  | 'cancelled'
  | 'failed'

export interface InPersonSaleStatus {
  client_id: string
  kind: string
  state: InPersonSaleState
  order_id: string | null
  cart_id: string | null
  checkout_url: string | null
  total_cents: number
}

/**
 * Pure: the state a claim + its order's facts mean. Exported for the unit spec.
 * `order` is null when the cart has not become an order.
 */
export function deriveSaleState(
  claim: { kind: string; status: string },
  order: { payment_received: boolean; payment_status: string | null } | null,
): InPersonSaleState {
  if (order) {
    if (claim.kind === 'transfer') {
      return order.payment_received || order.payment_status === 'captured' ? 'paid' : 'pending_confirmation'
    }
    // Card: the provider webhook only completes a cart whose payment it approved, and
    // cash is captured before its claim completes. An order here IS a paid sale —
    // including one whose claim was cancelled a moment too late.
    return 'paid'
  }
  if (claim.status === 'cancelled') return 'cancelled'
  if (claim.status === 'failed') return 'failed'
  return 'awaiting_payment'
}

async function orderForCart(scope: Scope, cartId: string): Promise<string | null> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'order_cart', fields: ['order_id'], filters: { cart_id: cartId } })
  return (data?.[0] as any)?.order_id ?? null
}

/** The payment session start-checkout opened on this cart, if any. */
async function cartCheckout(scope: Scope, cartId: string): Promise<{ total: number; session: { provider_id: string; data: Record<string, unknown> } | null }> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'cart',
    fields: ['id', 'total', 'payment_collection.payment_sessions.provider_id', 'payment_collection.payment_sessions.data'],
    filters: { id: cartId },
  })
  const cart = data?.[0] as any
  const sessions = (cart?.payment_collection?.payment_sessions ?? []) as any[]
  const s = sessions[sessions.length - 1]
  return {
    total: Math.round(Number(cart?.total ?? 0)),
    session: s ? { provider_id: String(s.provider_id), data: (s.data ?? {}) as Record<string, unknown> } : null,
  }
}

async function loadClaim(scope: Scope, sellerId: string, clientId: string): Promise<any | null> {
  const [claim] = await scope.resolve(IN_PERSON_MODULE).listInPersonSales({ seller_id: sellerId, client_id: clientId })
  return claim ?? null
}

/** Status for one of THIS seller's counter sales. Null when the seller has no such sale. */
export async function getInPersonSaleStatus(scope: Scope, sellerId: string, clientId: string): Promise<InPersonSaleStatus | null> {
  const claim = await loadClaim(scope, sellerId, clientId)
  if (!claim) return null

  let orderId: string | null = claim.order_id ?? null
  if (!orderId && claim.cart_id) {
    orderId = await orderForCart(scope, claim.cart_id)
    if (orderId) {
      // The webhook (or the transfer completion) turned the cart into an order:
      // settle the claim so later reads and replays answer from it directly.
      await scope.resolve(IN_PERSON_MODULE).updateInPersonSales({ id: claim.id, status: 'completed', order_id: orderId })
    }
  }

  let order: { payment_received: boolean; payment_status: string | null } | null = null
  let total = 0
  if (orderId) {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: 'order',
      fields: ['id', 'total', 'payment_status', 'metadata'],
      filters: { id: orderId },
    })
    const o = data?.[0] as any
    order = { payment_received: o?.metadata?.payment_received === true, payment_status: o?.payment_status ?? null }
    total = Math.round(Number(o?.total ?? 0))
  }

  let checkoutUrl: string | null = null
  if (claim.cart_id && !orderId) {
    const c = await cartCheckout(scope, claim.cart_id)
    total = c.total
    const url = c.session?.data?.redirect_url
    checkoutUrl = typeof url === 'string' ? url : null
  }

  return {
    client_id: claim.client_id,
    kind: claim.kind,
    state: deriveSaleState(claim, order),
    order_id: orderId,
    cart_id: claim.cart_id ?? null,
    checkout_url: checkoutUrl,
    total_cents: total,
  }
}

export type CancelResult =
  | { ok: true; status: InPersonSaleStatus }
  | { ok: false; status: number; code: string; message: string }

/**
 * Cancel a card or transfer sale that has not become an order. For a card sale the
 * provider checkout is expired FIRST (so the QR can no longer be paid), then the claim
 * is closed — conditionally, so a cancel never overwrites a sale the webhook settled.
 */
export async function cancelInPersonSale(scope: Scope, sellerId: string, clientId: string): Promise<CancelResult> {
  const claim = await loadClaim(scope, sellerId, clientId)
  if (!claim) return { ok: false, status: 404, code: 'SALE_NOT_FOUND', message: 'No encontramos esa venta.' }
  if (claim.kind === 'cash') {
    return { ok: false, status: 409, code: 'CASH_NOT_CANCELLABLE', message: 'Una venta en efectivo ya está registrada.' }
  }

  if (claim.cart_id && !(await orderForCart(scope, claim.cart_id)) && claim.status === 'awaiting_payment') {
    const { session } = await cartCheckout(scope, claim.cart_id)
    if (session) {
      try {
        await expireProviderCheckout(scope, sellerId, session)
      } catch (e) {
        // Refuse to close a sale whose QR may still be payable: the merchant would
        // believe it cancelled while the buyer can still pay. Say so; they retry.
        console.error('[in-person] provider checkout expiry failed', { clientId, message: (e as Error)?.message })
        return { ok: false, status: 502, code: 'CANCEL_FAILED', message: 'No pudimos cancelar el cobro. Intenta otra vez.' }
      }
    }
    const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    await knex.raw(
      `update in_person_sale set status = 'cancelled', updated_at = now()
        where id = ? and status = 'awaiting_payment'`,
      [claim.id],
    )
  }

  const status = await getInPersonSaleStatus(scope, sellerId, clientId)
  return { ok: true, status: status! }
}

async function expireProviderCheckout(
  scope: Scope,
  sellerId: string,
  session: { provider_id: string; data: Record<string, unknown> },
): Promise<void> {
  if (session.provider_id === 'pp_stripe-connect_stripe-connect') {
    const ctx = readStripePaymentContext(session.data)
    const sessionId = ctx?.stripe_session_id ?? (session.data.stripe_session_id as string | undefined)
    if (!sessionId) return
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-09-30.clover' as any })
    // Direct charges (US) live on the seller's account; MX destination charges on ours.
    const opts = ctx?.stripe_strategy === 'direct_charge' ? { stripeAccount: ctx.stripe_account_id } : undefined
    const current = await stripe.checkout.sessions.retrieve(sessionId, opts)
    if (current.status === 'open') await stripe.checkout.sessions.expire(sessionId, opts)
    return
  }
  if (session.provider_id === 'pp_mercadopago_mercadopago') {
    const prefId = session.data.mp_preference_id
    if (typeof prefId !== 'string' || !prefId) return
    const sellerService = scope.resolve(SELLER_MODULE)
    const [seller] = await sellerService.listSellers({ id: sellerId })
    const token = await resolveSellerMpToken(sellerService, seller)
    if (!token) throw new Error('seller MP token unavailable')
    const res = await fetch(`https://api.mercadopago.com/checkout/preferences/${encodeURIComponent(prefId)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires: true, expiration_date_to: new Date().toISOString() }),
    })
    if (!res.ok) throw new Error(`MP preference expiry ${res.status}`)
    return
  }
  // Manual (transfer) sessions have nothing payable to expire.
}
