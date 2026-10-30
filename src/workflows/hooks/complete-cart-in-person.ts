/**
 * Counter carts complete only on the provider their sale kind allows
 * (in-person-sales D9, codex security lens on PR 218).
 *
 * Medusa's public routes let anyone holding a cart id swap its payment session
 * (POST /store/payment-collections/:id/payment-sessions) and complete it
 * (POST /store/carts/:id/complete). For a card sale that meant: switch to the cash
 * provider — which authorizes unconditionally — and get an order with no money moved.
 * The status route already refuses to call that "paid"; this hook stops the order from
 * existing at all. A cart with no counter claim is untouched.
 */
import { completeCartWorkflow } from '@medusajs/medusa/core-flows'
import { ContainerRegistrationKeys, MedusaError } from '@medusajs/framework/utils'
import { IN_PERSON_MODULE } from '../../modules/in-person'
import { counterCartMatchesClaim, disallowedCounterProviders } from '../../lib/in-person-sale'
import { LINK_HASH_KIND, cartHoldsLink } from '../../lib/payment-link-cart'
import { derivePaymentLinkState } from '../../lib/payment-link'
import { SELLER_MODULE } from '../../modules/seller'
import { resolveSellerMpToken } from '../../api/store/_utils/mp'

const PROCESSABLE = new Set(['pending', 'requires_more', 'authorized', 'captured', 'pending_authorization'])

async function assertMpPaymentIsThisCart(container: any, sellerId: string, mpPaymentId: string, cartId: string, totalCents: number): Promise<void> {
  if (!mpPaymentId) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'No Mercado Pago payment on this checkout.')
  const sellerService = container.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id: sellerId })
  const token = await resolveSellerMpToken(sellerService, seller)
  if (!token) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Seller Mercado Pago token unavailable.')
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(mpPaymentId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `Mercado Pago payment lookup ${res.status}.`)
  const p = await res.json()
  const paidCents = Math.round(Number(p?.transaction_amount ?? 0) * 100)
  if (p?.status !== 'approved' || p?.external_reference !== cartId || !(paidCents >= totalCents)) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This Mercado Pago payment is not for this sale.')
  }
}

/**
 * A payment-link cart (S4, D15) completes only as built (lines + recorded total), only on
 * a card provider or the manual provider, and — once its link is closed (paid single-use,
 * expired, cancelled) — only with processor-confirmed money: the manual provider
 * authorizes unconditionally, so it could otherwise mint an order on a closed link.
 * Mercado Pago payments are proved to be for THIS cart, in full (as counter carts).
 */
async function validatePaymentLinkCart(container: any, inPerson: any, cart: any, cartId: string): Promise<void> {
  const [lc] = await inPerson.listPaymentLinkCarts({ cart_id: cartId }, { take: 1 })
  if (!lc) {
    // Not a link cart: it may not carry the seller's hidden «Cobro libre» product at all —
    // that product is payable only through a link, at the link's price. start-checkout
    // refuses it too, but Medusa's own public completion path does not pass through there
    // (codex security lens, PR 221 round 6).
    const productIds = Array.from(new Set(((cart?.items ?? []) as any[]).map((i) => i?.product_id).filter(Boolean)))
    if (productIds.length) {
      // Fail CLOSED (codex, PR 221 rounds 7–9): if this one lookup fails, cart completion's
      // own dozens of queries are failing too, so refusing adds no real availability risk —
      // while allowing would let the hidden product sell at its base price.
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'product', fields: ['id', 'metadata'], filters: { id: productIds },
      })
      const hidden = ((data ?? []) as any[]).some((p) => p?.metadata?.is_payment_link_product === true)
      if (hidden) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This product is payable only through its payment link.')
    }
    return
  }
  if (!counterCartMatchesClaim(
    { total: cart?.total, items: (cart?.items ?? []) as any[] },
    { kind: LINK_HASH_KIND, payload_hash: String(lc.payload_hash), total_cents: Number(lc.total_cents) },
  )) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This payment-link cart changed after it was built.')
  }
  // Every payment of a link cart must have come through start-checkout — the only path
  // that records this claim (Medusa's public payment-session routes are locked for link
  // carts). Without it, no provider may complete the cart (codex, PR 221 round 8).
  if (!lc?.metadata?.checkout_started_at) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This payment-link cart was not paid through its checkout.')
  }
  const [link] = await inPerson.listPaymentLinks({ id: lc.payment_link_id }, { take: 1 })
  const open = link && derivePaymentLinkState(link, new Date()) === 'pending'
  const sessions = ((cart?.payment_collection?.payment_sessions ?? []) as Array<{ status?: string; provider_id?: string; data?: any }>)
    .filter((s) => PROCESSABLE.has(String(s?.status)))
  for (const s of sessions) {
    const p = String(s.provider_id)
    if (p === 'pp_manual_manual') {
      if (!open) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This payment link is closed.')
      // A single-use link: only the cart holding it may complete on the manual provider
      // (which authorizes unconditionally) — otherwise two carts could both become
      // orders of one single-use link (codex, PR 221 round 2).
      if (link.uses === 'single' && !cartHoldsLink(link, cartId, new Date())) {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Another checkout holds this payment link.')
      }
      continue
    }
    if (p === 'pp_stripe-connect_stripe-connect') continue // the provider proves Stripe paid THIS session (stripe-authorization.ts)
    if (p === 'pp_mercadopago_mercadopago') {
      await assertMpPaymentIsThisCart(container, String(lc.seller_id), String(s?.data?.mp_payment_id ?? ''), cartId, Number(cart?.total ?? NaN))
      continue
    }
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, `A payment link cannot be completed with ${p}.`)
  }
}

completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  const cartId = (cart as any)?.id
  if (!cartId) return
  const inPerson: any = container.resolve(IN_PERSON_MODULE)
  const [claim] = await inPerson.listInPersonSales({ cart_id: cartId }, { take: 1 })
  if (!claim) return validatePaymentLinkCart(container, inPerson, cart, cartId)
  // A closed sale cannot become an order — except a CARD sale, whose provider authorizes
  // only a payment the processor confirmed: money already taken must still become its
  // order (never hidden). Transfer/cash authorize unconditionally, so after a cancel
  // they would mint a pending order the merchant closed (codex security lens, PR 218).
  if ((claim.status === 'cancelled' || claim.status === 'failed') && claim.kind !== 'card') {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This counter sale was closed.')
  }
  if (claim.kind === 'card') {
    // A CARD sale becomes an order only through the ONE checkout the server opened and
    // recorded for it (start-checkout's fence) — open or closed. A session added through
    // the public payment-session route, or one carrying another purchase's payment, is
    // refused (codex, PR 218, rounds 7–8).
    const ref = (claim.metadata as any)?.checkout_ref as string | undefined
    const processable = (((cart as any)?.payment_collection?.payment_sessions ?? []) as Array<{ status?: string; provider_id?: string; data?: any }>)
      .filter((s) => PROCESSABLE.has(String(s?.status)))
    if (!ref || !processable.length) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This counter sale has no recorded checkout.')
    for (const s of processable) {
      const d = s?.data ?? {}
      if (s.provider_id === 'pp_stripe-connect_stripe-connect') {
        // The Stripe provider additionally proves the session is bound to THIS payment
        // session and paid (stripe-authorization.ts).
        if (d.stripe_session_id !== ref) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Not this sale\'s checkout.')
      } else if (s.provider_id === 'pp_mercadopago_mercadopago') {
        if (d.mp_preference_id !== ref) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'Not this sale\'s checkout.')
        // The MP provider checks only that SOME payment is approved; prove it paid THIS
        // cart, in full, with the seller's own token.
        await assertMpPaymentIsThisCart(container, String(claim.seller_id), String(d.mp_payment_id ?? ''), cartId, Number((cart as any)?.total ?? NaN))
      }
    }
  }
  const sessions = (((cart as any)?.payment_collection?.payment_sessions ?? []) as Array<{ provider_id?: string; status?: string }>)
    .filter((s) => PROCESSABLE.has(String(s?.status)))
    .map((s) => String(s?.provider_id))
  // The cart must still be the sale the merchant rang up (lines + recorded total).
  if (!counterCartMatchesClaim(
    { total: (cart as any)?.total, items: ((cart as any)?.items ?? []) as any[] },
    { kind: String(claim.kind), payload_hash: String(claim.payload_hash), total_cents: (claim.metadata as any)?.total_cents },
  )) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This counter sale changed after it was rung up.')
  }
  const refused = disallowedCounterProviders(String(claim.kind), sessions)
  if (refused.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `This counter sale cannot be completed with ${refused.join(', ')}.`,
    )
  }
})
