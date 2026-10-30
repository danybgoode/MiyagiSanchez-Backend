/**
 * Stripe Connect Express payment provider for Medusa v2.
 *
 * Flow:
 *   1. `start-checkout` endpoint creates a Stripe Checkout Session (with
 *      transfer_data pointing at seller's connected account), stores the
 *      session ID + redirect URL in the Medusa PaymentSession.data.
 *   2. `initiatePayment` is a no-op — data is already set by start-checkout.
 *   3. `authorizePayment` fetches the Stripe session and returns "authorized"
 *      when it is paid/complete.
 *   4. `capturePayment` is a no-op — Stripe Checkout auto-captures.
 *   5. `getWebhookActionAndData` handles `checkout.session.completed` events
 *      so Medusa can automatically finalize orders on webhook delivery.
 */

import Stripe from 'stripe'
import { AbstractPaymentProvider, BigNumber } from '@medusajs/framework/utils'
import {
  readStripePaymentContext,
  stripeRefundParams,
  stripeRequestOptions,
} from '../../lib/stripe-market-strategy'
import { decideStripeAuthorization } from '../../lib/stripe-authorization'
import {
  InitiatePaymentInput,
  InitiatePaymentOutput,
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  ProviderWebhookPayload,
  WebhookActionResult,
  PaymentSessionStatus,
} from '@medusajs/framework/types'

type Options = {
  apiKey: string
  webhookSecret: string
}

/**
 * Rebuild the Stripe request context from the DURABLE payment-session data.
 *
 * A US direct charge lives on the SELLER's connected account, so every lifecycle call
 * must address that account. Called from the platform context instead, a `cs_…`/`pi_…`
 * created on a connected account simply 404s — silently catastrophic here:
 * `authorizePayment` returns `error`, the cart never completes, and the buyer is
 * charged with no order, no fulfilment and no email. `capturePayment` is worse still —
 * the escrow hold expires after ~7 days and the money returns AFTER the seller shipped.
 *
 * MX is unaffected by construction: a destination charge IS a platform charge, and
 * `readStripePaymentContext` maps legacy sessions (which carry only
 * `stripe_seller_account`) to `destination_charge`, whose request options are
 * `undefined` — byte-identical to the behaviour before this existed.
 */
function requestContextFor(data: Record<string, unknown>) {
  const context = readStripePaymentContext(data)
  return { context, options: context ? stripeRequestOptions(context) : undefined }
}

export class StripeConnectProviderService extends AbstractPaymentProvider<Options> {
  static identifier = 'stripe-connect'

  protected stripe_: Stripe

  constructor(container: Record<string, unknown>, options: Options) {
    super(container, options)
    this.stripe_ = new Stripe(options.apiKey, { apiVersion: '2025-09-30.clover' as any })
  }

  static validateOptions(options: Record<string, unknown>) {
    if (!options.apiKey) throw new Error('Stripe apiKey is required')
  }

  // ── initiatePayment ───────────────────────────────────────────────────────
  // The start-checkout endpoint pre-creates the Stripe session and passes its
  // data here. We just return it as-is so Medusa stores it on the session.
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    return {
      id: (data.stripe_session_id as string) ?? 'pending',
      data,
    }
  }

  // ── authorizePayment ──────────────────────────────────────────────────────
  // Called when cart completion is attempted (either from success page or webhook).
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>

    // NEVER short-circuit on `data.status`: session data is written by whoever creates
    // the payment session, including callers of Medusa's public payment-sessions route.
    // Stripe's own answer decides, for a Checkout Session bound to THIS payment session
    // (src/lib/stripe-authorization.ts has the hole this closed).
    const sessionId = data.stripe_session_id as string
    if (!sessionId) {
      return { status: 'pending' as PaymentSessionStatus, data }
    }

    try {
      const { options } = requestContextFor(data)
      const session = await this.stripe_.checkout.sessions.retrieve(sessionId, {}, options)
      const decision = decideStripeAuthorization(session as any, (input.context as any)?.idempotency_key)
      if (decision === 'authorized') {
        return { status: 'authorized' as PaymentSessionStatus, data: { ...data, status: 'paid', stripe_payment_intent: session.payment_intent } }
      }
      if (decision === 'canceled') return { status: 'canceled' as PaymentSessionStatus, data }
      if (decision === 'refused') return { status: 'error' as PaymentSessionStatus, data }
      return { status: 'pending' as PaymentSessionStatus, data }
    } catch {
      return { status: 'error' as PaymentSessionStatus, data }
    }
  }

  // ── capturePayment ────────────────────────────────────────────────────────
  // For escrow orders: explicitly capture the PaymentIntent (which was created with
  // capture_method: 'manual'). Non-escrow orders are auto-captured by Stripe at checkout.
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const pi = data.stripe_payment_intent as string | undefined
    if (data.escrow_mode && pi) {
      try {
        await this.stripe_.paymentIntents.capture(pi, undefined, requestContextFor(data).options)
      } catch (e) {
        // `cause` keeps the Stripe error reachable — its `code`, `decline_code` and
        // `requestId` are what make a failed capture diagnosable, and the message
        // string alone has none of them.
        throw new Error(`Stripe escrow capture failed: ${(e as Error).message}`, { cause: e })
      }
    }
    return { data: { ...data, escrow_captured: true } }
  }

  // ── cancelPayment ─────────────────────────────────────────────────────────
  // For escrow orders where funds were authorized but not yet captured: cancel the
  // PaymentIntent to void the hold (no money moved). For non-escrow or already-expired
  // sessions: expire the Checkout Session.
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const pi = data.stripe_payment_intent as string | undefined
    const sessionId = data.stripe_session_id as string | undefined
    if (data.escrow_mode && pi && !data.escrow_captured) {
      try {
        await this.stripe_.paymentIntents.cancel(pi, undefined, requestContextFor(data).options)
      } catch { /* already canceled or captured — ok */ }
    } else if (sessionId) {
      try {
        await this.stripe_.checkout.sessions.expire(sessionId, undefined, requestContextFor(data).options)
      } catch { /* already expired or completed — ok */ }
    }
    return { data: { ...data, status: 'canceled' } }
  }

  // ── deletePayment ─────────────────────────────────────────────────────────
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input)
  }

  // ── getPaymentStatus ──────────────────────────────────────────────────────
  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    // Same rule as authorizePayment: Stripe decides, never stored `data.status`.
    const sessionId = data.stripe_session_id as string
    if (!sessionId) return { status: 'pending' as PaymentSessionStatus }

    try {
      const session = await this.stripe_.checkout.sessions.retrieve(sessionId, {}, requestContextFor(data).options)
      // Status is informational (no Medusa path calls it; authorizePayment is the gate),
      // and callers pass no payment-session id — so only a PRESENT id that disagrees with
      // the binding is refused here (verifier, PR 219).
      const key = (input.context as any)?.idempotency_key as string | undefined
      if (key && decideStripeAuthorization(session as any, key) === 'refused') return { status: 'error' as PaymentSessionStatus }
      if (session.payment_status === 'paid') return { status: 'captured' as PaymentSessionStatus }
      if (session.status === 'expired') return { status: 'canceled' as PaymentSessionStatus }
      return { status: 'pending' as PaymentSessionStatus }
    } catch {
      return { status: 'error' as PaymentSessionStatus }
    }
  }

  // ── refundPayment ─────────────────────────────────────────────────────────
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const data = (input.data ?? {}) as Record<string, unknown>
    const paymentIntent = data.stripe_payment_intent as string
    if (!paymentIntent) return { data }

    try {
      const { context, options } = requestContextFor(data)
      const amount = input.amount ? Math.round(Number(input.amount)) : undefined
      // `reverse_transfer` reverses the destination transfer of an MX destination
      // charge. A direct charge has no transfer to reverse, and Stripe REJECTS the
      // parameter — so the refund shape is derived, never hard-coded.
      await this.stripe_.refunds.create(
        context
          ? stripeRefundParams(context, amount)
          : { payment_intent: paymentIntent, amount, reverse_transfer: true },
        options,
      )
    } catch (e) {
      // As above: the Stripe error carries the refund's own failure reason.
      throw new Error(`Stripe refund failed: ${(e as Error).message}`, { cause: e })
    }
    return { data: { ...data, refunded: true } }
  }

  // ── retrievePayment ───────────────────────────────────────────────────────
  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  // ── updatePayment ─────────────────────────────────────────────────────────
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    return { data: input.data ?? {} }
  }

  // ── getWebhookActionAndData ───────────────────────────────────────────────
  // Medusa calls this when POST /hooks/payment/pp_stripe-connect_stripe-connect fires.
  async getWebhookActionAndData(payload: ProviderWebhookPayload['payload']): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    // Verify signature
    const sig = (headers as Record<string, string>)['stripe-signature']
    let event: Stripe.Event
    try {
      event = this.stripe_.webhooks.constructEvent(
        rawData as string | Buffer,
        sig,
        this.config.webhookSecret,
      )
    } catch {
      return { action: 'not_supported', data: { session_id: '', amount: new BigNumber(0) } }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const sessionId = session.id
      const medusaSessionId = (session.metadata ?? {}).medusa_payment_session_id ?? ''
      const amount = session.amount_total ?? 0

      if (session.payment_status === 'paid') {
        return {
          action: 'authorized',
          data: {
            session_id: medusaSessionId || sessionId,
            amount: new BigNumber(amount),
          },
        }
      }
    }

    return { action: 'not_supported', data: { session_id: '', amount: new BigNumber(0) } }
  }
}

export default StripeConnectProviderService
