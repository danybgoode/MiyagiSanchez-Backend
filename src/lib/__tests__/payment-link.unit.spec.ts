import {
  LINK_MAX_DAYS,
  derivePaymentLinkState,
  isTokenShaped,
  newPaymentLinkToken,
  validatePaymentLinkInput,
} from '../payment-link'

/** in-person-sales S4.1 (D13) — what a payment link may be, and what state it is in. */
const now = new Date('2026-10-31T12:00:00Z')

describe('validatePaymentLinkInput', () => {
  it('a free amount: concept + centavos, single-use, 7 days by default', () => {
    const r = validatePaymentLinkInput({ kind: 'amount', concept: '  Anticipo   pastel ', amount_cents: 80000 }, now)
    expect(r).toEqual({ ok: true, link: {
      kind: 'amount', lines: null, concept: 'Anticipo pastel', amount_cents: 80000, uses: 'single',
      expires_at: new Date('2026-11-07T12:00:00Z'),
    } })
  })
  it('products: merged, sorted lines; multi-use allowed', () => {
    const r = validatePaymentLinkInput({ kind: 'products', uses: 'multi', expires_in_days: 3,
      lines: [{ variant_id: 'b' }, { variant_id: 'a', quantity: 2 }, { variant_id: 'b', quantity: 1 }] }, now)
    expect(r.ok && r.link.lines).toEqual([{ variant_id: 'a', quantity: 2 }, { variant_id: 'b', quantity: 2 }])
    expect(r.ok && r.link.uses).toBe('multi')
  })
  it.each([
    [{ kind: 'gift' }, 'INVALID_KIND'],
    [{ kind: 'amount', concept: 'ok concept', amount_cents: 999 }, 'INVALID_AMOUNT'],
    [{ kind: 'amount', concept: 'ok concept', amount_cents: 5_000_001 }, 'INVALID_AMOUNT'],
    [{ kind: 'amount', concept: 'ok concept', amount_cents: 1500.5 }, 'INVALID_AMOUNT'],
    [{ kind: 'amount', concept: 'no', amount_cents: 5000 }, 'INVALID_CONCEPT'],
    [{ kind: 'amount', concept: 'ok concept', amount_cents: 5000, uses: 'multi' }, 'INVALID_USES'],
    [{ kind: 'products', lines: [] }, 'EMPTY_LINK'],
    [{ kind: 'products', lines: [{ variant_id: 'a', quantity: 0 }] }, 'INVALID_QUANTITY'],
    [{ kind: 'products', lines: [{ variant_id: 'a', quantity: 600 }, { variant_id: 'a', quantity: 600 }] }, 'INVALID_QUANTITY'],
    [{ kind: 'products', lines: [{ variant_id: 'a' }], expires_in_days: LINK_MAX_DAYS + 1 }, 'INVALID_EXPIRY'],
    [{ kind: 'products', lines: [{ variant_id: 'a' }], expires_in_days: 0 }, 'INVALID_EXPIRY'],
  ])('refuses %j with %s', (body, code) => {
    const r = validatePaymentLinkInput(body, now)
    expect(!r.ok && r.code).toBe(code)
  })
})

describe('tokens', () => {
  it('are 43-char base64url and never repeat', () => {
    const a = newPaymentLinkToken(), b = newPaymentLinkToken()
    expect(isTokenShaped(a)).toBe(true)
    expect(a).not.toBe(b)
  })
  it('anything else is not token-shaped', () => {
    for (const v of ['', 'plink_01ABC', 'a'.repeat(42), 'a'.repeat(44), 'a/'.repeat(21) + 'a', 42, null]) {
      expect(isTokenShaped(v)).toBe(false)
    }
  })
})

describe('derivePaymentLinkState', () => {
  const link = (over: Record<string, unknown> = {}) => ({ status: 'pending', uses: 'single', expires_at: new Date('2026-11-01T00:00:00Z'), ...over })
  it('pending until it expires; expired is derived, never stored', () => {
    expect(derivePaymentLinkState(link(), now)).toBe('pending')
    expect(derivePaymentLinkState(link({ expires_at: now }), now)).toBe('expired')
  })
  it('a paid single-use link is paid, even after its expiry', () => {
    expect(derivePaymentLinkState(link({ status: 'paid', expires_at: new Date(0) }), now)).toBe('paid')
  })
  it('a multi-use link stays open after a payment', () => {
    expect(derivePaymentLinkState(link({ status: 'paid', uses: 'multi' }), now)).toBe('pending')
  })
  it('cancelled wins over everything', () => {
    expect(derivePaymentLinkState(link({ status: 'cancelled', expires_at: new Date(0) }), now)).toBe('cancelled')
  })
})
