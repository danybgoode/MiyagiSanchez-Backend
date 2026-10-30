/**
 * Whether a Stripe Checkout Session pays for THIS Medusa payment session — the pure
 * decision behind `pp_stripe-connect`'s authorizePayment / getPaymentStatus.
 *
 * Why this exists (2026-10-30, verifier on in-person-sales PR 218): the provider used to
 * authorize any session whose stored data said `status: 'paid'`. That data is written by
 * whoever creates the payment session, and Medusa's public
 * `POST /store/payment-collections/:id/payment-sessions` passes a caller's `data` through
 * `initiatePayment` untouched — so anyone could create a stripe-connect session with
 * `{ status: 'paid' }` on any cart, call `/complete`, and get a paid order with no money.
 * (The Mercado Pago provider was closed the same way earlier; this is its Stripe twin.)
 *
 * Now the answer always comes from Stripe, and the Stripe session must be BOUND to this
 * payment session: start-checkout stamps `metadata.medusa_payment_session_id` on the
 * Checkout Session, and Medusa hands the provider its own session id as
 * `context.idempotency_key` (payment module `authorizePaymentSession`). Without the
 * binding, one real $1 payment could be replayed onto any other cart by copying its
 * `stripe_session_id`.
 */
export type StripeCheckoutFacts = {
  payment_status?: string | null
  status?: string | null
  metadata?: Record<string, string> | null
}

export type StripeAuthorization = 'authorized' | 'pending' | 'canceled' | 'refused'

export function decideStripeAuthorization(
  session: StripeCheckoutFacts,
  medusaPaymentSessionId: string | null | undefined,
): StripeAuthorization {
  const bound = session.metadata?.medusa_payment_session_id
  // Unbound or bound to another session: this Stripe payment does not belong here,
  // whatever its status. `refused` maps to an error status, never to authorized.
  if (!medusaPaymentSessionId || !bound || bound !== medusaPaymentSessionId) return 'refused'
  if (session.payment_status === 'paid') return 'authorized'
  if (session.status === 'expired') return 'canceled'
  return 'pending'
}
