import StripeConnectProviderService from '../service'

/**
 * The provider WIRING of the binding (the pure rule is in stripe-authorization.unit.spec):
 * authorizePayment must ask Stripe, read Medusa's payment-session id from
 * `context.idempotency_key`, and never authorize on forged session data
 * (verifier, PR 219 — `{ status: 'paid' }` through the public payment-sessions route).
 */
function provider(session: Record<string, unknown> | Error) {
  const svc = new (StripeConnectProviderService as any)({}, { apiKey: 'sk_test_x', webhookSecret: 'whsec_x' })
  const retrieve = jest.fn(async () => { if (session instanceof Error) throw session; return session })
  svc.stripe_ = { checkout: { sessions: { retrieve } } }
  return { svc, retrieve }
}

const PAID_BOUND = { payment_status: 'paid', status: 'complete', payment_intent: 'pi_1', metadata: { medusa_payment_session_id: 'payses_1' } }

describe('pp_stripe-connect authorizePayment', () => {
  it('forged { status: "paid" } with no Stripe session is never authorized', async () => {
    const { svc } = provider(PAID_BOUND)
    const r = await svc.authorizePayment({ data: { status: 'paid' }, context: { idempotency_key: 'payses_1' } })
    expect(r.status).not.toBe('authorized')
  })

  it('a real paid session bound to ANOTHER payment session is refused', async () => {
    const { svc } = provider(PAID_BOUND)
    const r = await svc.authorizePayment({ data: { status: 'paid', stripe_session_id: 'cs_1' }, context: { idempotency_key: 'payses_attacker' } })
    expect(r.status).toBe('error')
  })

  it('the bound, Stripe-paid session is authorized — Stripe was asked', async () => {
    const { svc, retrieve } = provider(PAID_BOUND)
    const r = await svc.authorizePayment({ data: { stripe_session_id: 'cs_1' }, context: { idempotency_key: 'payses_1' } })
    expect(r.status).toBe('authorized')
    expect(retrieve).toHaveBeenCalledWith('cs_1', {}, undefined)
  })

  it('bound but unpaid stays pending', async () => {
    const { svc } = provider({ ...PAID_BOUND, payment_status: 'unpaid', status: 'open' })
    const r = await svc.authorizePayment({ data: { stripe_session_id: 'cs_1' }, context: { idempotency_key: 'payses_1' } })
    expect(r.status).toBe('pending')
  })
})
