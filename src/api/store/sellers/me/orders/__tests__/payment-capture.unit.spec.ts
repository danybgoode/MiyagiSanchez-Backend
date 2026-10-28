import { normalizeMedusaOrder } from '../route'

/**
 * `payment_captured` — the honest "did the money actually land?" answer
 * (MiyagiSanchez-Storefront#298, fresh-reviewer finding).
 *
 * The bug this guards against is subtle and was live: `status` is NOT an assertion of
 * capture. It initialises to 'paid' and is only demoted for cancel/refund/return or an
 * uncaptured MANUAL method — so an automatic order sitting at `payment_status:
 * 'authorized'` normalises to 'paid'. A consumer reading `status === 'paid'` as "we have
 * the money" is reading a fall-through default.
 *
 * That is harmless for the seller order list this route was written for, and NOT harmless
 * for the merchant-lifecycle projection, whose `first_sale` milestone is write-once and
 * unwithdrawable. The FIRST test below is the load-bearing one: it fails against the
 * pre-fix behaviour of inferring capture from `status`.
 */

// Minimal order in the shape `normalizeMedusaOrder` reads. Everything it does not touch
// is omitted deliberately — a fixture that mirrors a real order would hide which fields
// actually drive the result.
function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order_test',
    status: 'pending',
    currency_code: 'mxn',
    total: 10_000,
    items: [],
    metadata: {},
    ...overrides,
  }
}

const norm = (o: Record<string, unknown>) =>
  normalizeMedusaOrder(o, 'seller_1', 'Tienda de Prueba') as unknown as {
    status: string
    payment_status: string | null
    payment_captured: boolean
  }

describe('normalizeMedusaOrder · payment_captured', () => {
  it('an AUTHORIZED card order reports status "paid" but is NOT captured', () => {
    // The whole reason this field exists. If these two ever agree, the fall-through
    // default has been mistaken for a capture assertion again.
    const r = norm(order({ payment_status: 'authorized', metadata: { payment_method: 'card' } }))
    expect(r.status).toBe('paid')
    expect(r.payment_captured).toBe(false)
    expect(r.payment_status).toBe('authorized')
  })

  it('a CAPTURED card order is captured', () => {
    const r = norm(order({ payment_status: 'captured', metadata: { payment_method: 'card' } }))
    expect(r.payment_captured).toBe(true)
  })

  it('a PARTIALLY captured order counts as captured — money did land', () => {
    const r = norm(order({ payment_status: 'partially_captured', metadata: { payment_method: 'card' } }))
    expect(r.payment_captured).toBe(true)
  })

  it('a manual (SPEI) order the seller has NOT confirmed is not captured', () => {
    const r = norm(order({ payment_status: 'authorized', metadata: { payment_method: 'spei' } }))
    expect(r.status).toBe('pending_payment')
    expect(r.payment_captured).toBe(false)
  })

  it('a manual order the seller HAS confirmed is captured — receipt is how manual money lands', () => {
    const r = norm(
      order({
        payment_status: 'authorized',
        metadata: { payment_method: 'spei', payment_received: true },
      }),
    )
    expect(r.payment_captured).toBe(true)
  })

  it('an order with no payment_status at all is not captured (absence is never capture)', () => {
    const r = norm(order({ metadata: { payment_method: 'card' } }))
    expect(r.payment_status).toBeNull()
    expect(r.payment_captured).toBe(false)
  })

  it('a REFUNDED card order is not captured', () => {
    const r = norm(
      order({ payment_status: 'refunded', metadata: { payment_method: 'card', payment_received: true } }),
    )
    expect(r.status).toBe('refunded')
    expect(r.payment_captured).toBe(false)
  })

  it('a REFUNDED MANUAL order is not captured either — the answer must not depend on method', () => {
    // The bug a cross-agent pass caught: `isManualPay && manualConfirmed` was evaluated
    // without the refund guard, so a refunded SPEI order still carried
    // `payment_received: true` and reported captured — while a refunded CARD order
    // reported false, because Medusa had moved `payment_status` off 'captured'. One field
    // answering differently per payment method is worse than either reading alone.
    const r = norm(
      order({ payment_status: 'refunded', metadata: { payment_method: 'spei', payment_received: true } }),
    )
    expect(r.status).toBe('refunded')
    expect(r.payment_captured).toBe(false)
  })

  it.each(['card', 'spei'])(
    'a PARTIALLY REFUNDED %s order IS captured — funds landed and some remain',
    (method) => {
      // Method parity, checked as a pair rather than asserted in prose. Cross-agent
      // review caught this exact status splitting the two ways: automatic orders fell
      // out of `isCaptured` and reported false, while a manual order with
      // `payment_received: true` reported true for the identical payment_status.
      const r = norm(
        order({
          payment_status: 'partially_refunded',
          metadata: { payment_method: method, payment_received: true },
        }),
      )
      expect(r.payment_captured).toBe(true)
    },
  )

  it.each(['card', 'spei'])('a FULLY refunded %s order is not captured', (method) => {
    const r = norm(
      order({ payment_status: 'refunded', metadata: { payment_method: method, payment_received: true } }),
    )
    expect(r.payment_captured).toBe(false)
  })

  it.each(['card', 'spei'])(
    'a captured-then-RETURNED %s order is still captured — a return is not a refund',
    (method) => {
      // `payment_captured` is a PAYMENT fact. Folding fulfillment state into it reported
      // false for money that had demonstrably landed and had not been given back
      // (cross-agent review). Callers wanting "a sale that stuck" read `status`, which is
      // 'refunded' here — and that is what actually gates the first_sale milestone.
      const r = norm(
        order({
          payment_status: 'captured',
          fulfillment_status: 'returned',
          metadata: { payment_method: method, payment_received: true },
        }),
      )
      expect(r.status).toBe('refunded')
      expect(r.payment_captured).toBe(true)
    },
  )

  it.each(['card', 'spei'])(
    'a captured-then-CANCELED %s order is still captured until a refund actually happens',
    (method) => {
      const r = norm(
        order({
          status: 'canceled',
          payment_status: 'captured',
          metadata: { payment_method: method, payment_received: true },
        }),
      )
      expect(r.status).toBe('refunded')
      expect(r.payment_captured).toBe(true)
    },
  )
})
