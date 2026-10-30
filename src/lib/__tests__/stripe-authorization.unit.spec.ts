import { decideStripeAuthorization } from '../stripe-authorization'

/**
 * The stripe-connect provider authorizes only what Stripe says is paid AND bound to this
 * payment session (see the module header for the live hole this closes).
 */
describe('decideStripeAuthorization', () => {
  const bound = (over: Record<string, unknown> = {}) => ({
    payment_status: 'paid', status: 'complete', metadata: { medusa_payment_session_id: 'payses_1' }, ...over,
  })

  it('a paid session bound to this payment session is authorized', () => {
    expect(decideStripeAuthorization(bound(), 'payses_1')).toBe('authorized')
  })
  it('a paid session bound to ANOTHER payment session is refused (no replay onto other carts)', () => {
    expect(decideStripeAuthorization(bound(), 'payses_attacker')).toBe('refused')
  })
  it('an unbound session is refused, however paid', () => {
    expect(decideStripeAuthorization(bound({ metadata: {} }), 'payses_1')).toBe('refused')
    expect(decideStripeAuthorization(bound({ metadata: null }), 'payses_1')).toBe('refused')
  })
  it('no payment-session id from Medusa is refused', () => {
    expect(decideStripeAuthorization(bound(), undefined)).toBe('refused')
  })
  it('bound but unpaid is pending; bound and expired is canceled', () => {
    expect(decideStripeAuthorization(bound({ payment_status: 'unpaid', status: 'open' }), 'payses_1')).toBe('pending')
    expect(decideStripeAuthorization(bound({ payment_status: 'unpaid', status: 'expired' }), 'payses_1')).toBe('canceled')
  })
})
