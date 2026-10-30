import {
  CLAIM_STALE_MS,
  cashChange,
  decideExistingClaim,
  inPersonPayloadHash,
  validateInPersonSale,
} from '../in-person-sale'

/**
 * in-person-sales S1.2 — the pure half of exactly-once. No DB: proves validation,
 * that the payload hash identifies WHAT was sold (not how it was spelled), and the
 * claim decision a unique-index collision is answered with (D4).
 */

const CID = '6f1c2b8e-4d3a-4b7e-9c1d-2a3b4c5d6e7f'
const body = (over: Record<string, unknown> = {}) => ({
  client_id: CID,
  kind: 'cash',
  lines: [{ variant_id: 'variant_b', quantity: 1 }, { variant_id: 'variant_a', quantity: 2 }],
  ...over,
})

describe('validateInPersonSale', () => {
  it('accepts a cash sale and canonicalises it (sorted lines, lower-case id)', () => {
    const r = validateInPersonSale(body({ client_id: CID.toUpperCase(), tendered_cents: 50000 }))
    expect(r).toEqual({
      ok: true,
      sale: {
        client_id: CID,
        kind: 'cash',
        lines: [{ variant_id: 'variant_a', quantity: 2 }, { variant_id: 'variant_b', quantity: 1 }],
        tendered_cents: 50000,
        offline: false,
        sold_at: null,
        buyer_email: null,
      },
    })
  })

  it('merges two taps on the same variant into one line', () => {
    const r = validateInPersonSale(body({ lines: [{ variant_id: 'v', quantity: 1 }, { variant_id: 'v', quantity: 2 }] }))
    expect(r.ok && r.sale.lines).toEqual([{ variant_id: 'v', quantity: 3 }])
  })

  it.each([
    [{ client_id: 'not-a-uuid' }, 'INVALID_CLIENT_ID'],
    [{ kind: 'barter' }, 'INVALID_KIND'],
    [{ lines: [] }, 'EMPTY_SALE'],
    [{ lines: [{ variant_id: 'v', quantity: 0 }] }, 'INVALID_QUANTITY'],
    [{ lines: [{ variant_id: 'v', quantity: 1.5 }] }, 'INVALID_QUANTITY'],
    [{ lines: [{ variant_id: 'v', quantity: 600 }, { variant_id: 'v', quantity: 600 }] }, 'INVALID_QUANTITY'],
    [{ lines: [{ quantity: 1 }] }, 'INVALID_LINE'],
    [{ tendered_cents: -1 }, 'INVALID_TENDERED'],
    [{ tendered_cents: 10.5 }, 'INVALID_TENDERED'],
    [{ kind: 'card', tendered_cents: 100 }, 'TENDERED_NOT_CASH'],
    [{ kind: 'transfer', offline: true }, 'OFFLINE_NOT_CASH'],
    [{ sold_at: 'yesterday-ish' }, 'INVALID_SOLD_AT'],
    [{ buyer_email: 'no-at-sign' }, 'INVALID_EMAIL'],
  ])('refuses %j with %s', (over, code) => {
    const r = validateInPersonSale(body(over))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe(code)
  })

  it('refuses more than 50 distinct lines', () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({ variant_id: `v${i}`, quantity: 1 }))
    const r = validateInPersonSale(body({ lines }))
    expect(!r.ok && r.code).toBe('TOO_MANY_LINES')
  })
})

describe('inPersonPayloadHash', () => {
  const sale = (b: Record<string, unknown>) => {
    const r = validateInPersonSale(body(b))
    if (!r.ok) throw new Error(r.code)
    return r.sale
  }

  it('is the same for two spellings of the same sale', () => {
    const a = sale({ lines: [{ variant_id: 'x', quantity: 2 }, { variant_id: 'y', quantity: 1 }] })
    const b = sale({ lines: [{ variant_id: 'y', quantity: 1 }, { variant_id: 'x', quantity: 1 }, { variant_id: 'x', quantity: 1 }] })
    expect(inPersonPayloadHash(a)).toBe(inPersonPayloadHash(b))
  })

  it('ignores the cash amount and the receipt address (a corrected resend is the same sale)', () => {
    expect(inPersonPayloadHash(sale({ tendered_cents: 100 }))).toBe(inPersonPayloadHash(sale({ buyer_email: 'a@b.mx' })))
  })

  it('differs when the products, the quantities or the method differ', () => {
    const base = inPersonPayloadHash(sale({}))
    expect(inPersonPayloadHash(sale({ lines: [{ variant_id: 'variant_a', quantity: 3 }, { variant_id: 'variant_b', quantity: 1 }] }))).not.toBe(base)
    expect(inPersonPayloadHash(sale({ lines: [{ variant_id: 'variant_a', quantity: 2 }] }))).not.toBe(base)
    expect(inPersonPayloadHash(sale({ kind: 'card' }))).not.toBe(base)
  })
})

describe('cashChange', () => {
  it('computes the change in integer centavos', () => {
    expect(cashChange(45550, 50000)).toEqual({ change_cents: 4450, short_cents: 0 })
  })
  it('reports what is still owed when the cash is short', () => {
    expect(cashChange(45550, 40000)).toEqual({ change_cents: 0, short_cents: 5550 })
  })
  it('exact amount and "no amount given" both mean no change', () => {
    expect(cashChange(100, 100)).toEqual({ change_cents: 0, short_cents: 0 })
    expect(cashChange(100, null)).toEqual({ change_cents: 0, short_cents: 0 })
  })
})

describe('decideExistingClaim', () => {
  const now = new Date('2026-10-29T12:00:00Z')
  const claim = (over: Record<string, unknown> = {}) => ({
    status: 'claimed',
    payload_hash: 'h1',
    order_id: null,
    cart_id: 'cart_1',
    claimed_at: new Date(now.getTime() - 1_000),
    ...over,
  })

  it('a completed claim with the same sale is a replay of its order', () => {
    expect(decideExistingClaim(claim({ status: 'completed', order_id: 'order_1' }), 'h1', now))
      .toEqual({ action: 'replay', order_id: 'order_1' })
  })

  it('a reused client_id with a DIFFERENT sale is refused, even when the first is completed', () => {
    expect(decideExistingClaim(claim({ status: 'completed', order_id: 'order_1' }), 'h2', now))
      .toEqual({ action: 'reject_reused' })
  })

  it('a fresh claim is in progress; the boundary is exclusive at the stale window', () => {
    expect(decideExistingClaim(claim(), 'h1', now)).toEqual({ action: 'in_progress' })
    const edge = claim({ claimed_at: new Date(now.getTime() - CLAIM_STALE_MS + 1) })
    expect(decideExistingClaim(edge, 'h1', now)).toEqual({ action: 'in_progress' })
  })

  it('a stale claim is taken over and RESUMES its recorded cart', () => {
    const stale = claim({ claimed_at: new Date(now.getTime() - CLAIM_STALE_MS) })
    expect(decideExistingClaim(stale, 'h1', now)).toEqual({ action: 'takeover', cart_id: 'cart_1' })
  })

  it('a released claim (claimed_at = epoch) is taken over immediately', () => {
    expect(decideExistingClaim(claim({ claimed_at: new Date(0) }), 'h1', now))
      .toEqual({ action: 'takeover', cart_id: 'cart_1' })
  })

  it('a card/transfer sale waiting for payment hands back its SAME cart, even when old', () => {
    const waiting = claim({ status: 'awaiting_payment', claimed_at: new Date(0) })
    expect(decideExistingClaim(waiting, 'h1', now)).toEqual({ action: 'awaiting', cart_id: 'cart_1' })
  })

  it('a waiting sale under a reused client_id with a different sale is still refused', () => {
    expect(decideExistingClaim(claim({ status: 'awaiting_payment' }), 'h2', now)).toEqual({ action: 'reject_reused' })
  })

  it('cancelled and failed claims are closed, never re-applied', () => {
    expect(decideExistingClaim(claim({ status: 'failed' }), 'h1', now)).toEqual({ action: 'reject_closed', status: 'failed' })
    expect(decideExistingClaim(claim({ status: 'cancelled' }), 'h1', now)).toEqual({ action: 'reject_closed', status: 'cancelled' })
  })
})

describe('disallowedCounterProviders (codex security lens, PR 218)', () => {
  const { disallowedCounterProviders } = require('../in-person-sale')
  it('a card sale may complete only on a card processor', () => {
    expect(disallowedCounterProviders('card', ['pp_stripe-connect_stripe-connect'])).toEqual([])
    expect(disallowedCounterProviders('card', ['pp_mercadopago_mercadopago'])).toEqual([])
    expect(disallowedCounterProviders('card', ['pp_cash_cash'])).toEqual(['pp_cash_cash'])
    expect(disallowedCounterProviders('card', ['pp_manual_manual'])).toEqual(['pp_manual_manual'])
  })
  it('cash only on cash, transfer only on the manual provider', () => {
    expect(disallowedCounterProviders('cash', ['pp_cash_cash'])).toEqual([])
    expect(disallowedCounterProviders('cash', ['pp_stripe-connect_stripe-connect'])).toEqual(['pp_stripe-connect_stripe-connect'])
    expect(disallowedCounterProviders('transfer', ['pp_manual_manual'])).toEqual([])
    expect(disallowedCounterProviders('transfer', ['pp_cash_cash'])).toEqual(['pp_cash_cash'])
  })
  it('an unknown kind allows nothing', () => {
    expect(disallowedCounterProviders('barter', ['pp_cash_cash'])).toEqual(['pp_cash_cash'])
  })
})
