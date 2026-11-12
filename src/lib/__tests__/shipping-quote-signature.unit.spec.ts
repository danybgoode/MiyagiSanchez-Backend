import {
  checkShippingQuote,
  shippingQuoteKey,
  signShippingRate,
  verifyShippingQuote,
  SHIPPING_QUOTE_INVALID_MESSAGE,
  SHIPPING_QUOTE_TTL_MS,
  type QuoteBinding,
  type SignedRateFields,
} from '../shipping-quote-signature'

/**
 * The shipping-price tamper guarantee: checkout charges a shipping amount only when the rates
 * route signed exactly that rate for those products and that destination. Before this,
 * `shipping_quote.amount_cents: 1` paid one centavo of shipping.
 */
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const key = shippingQuoteKey({ JWT_SECRET: 'unit-test-secret', NODE_ENV: 'test' })!
const rate: SignedRateFields = { rate_id: 'r1', carrier: 'dhl', service: 'express', amount_cents: 18000, currency: 'MXN' }
const binding: QuoteBinding = { productIds: ['prod_b', 'prod_a'], postalCode: '06700' }
const token = signShippingRate(key, rate, binding, NOW)!
const quote = (over: Record<string, unknown> = {}) => ({ ...rate, signature: token, ...over })
const check = (q: any, b: QuoteBinding = binding, now = NOW + 1000, k: Buffer | null = key) => checkShippingQuote(k, q, b, now)

describe('shipping quote signature', () => {
  it('accepts the rate exactly as signed', () => {
    expect(check(quote())).toEqual({ ok: true })
  })
  it('ignores product order, duplicates and postcode formatting', () => {
    expect(check(quote(), { productIds: ['prod_a', 'prod_b', 'prod_a'], postalCode: ' 06 700 ' })).toEqual({ ok: true })
  })
  it('refuses a forged amount (the original bug: 1 centavo of shipping)', () => {
    const r: any = check(quote({ amount_cents: 1 }))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(422)
    expect(r.code).toBe('SHIPPING_QUOTE_INVALID')
    expect(r.message).toBe(SHIPPING_QUOTE_INVALID_MESSAGE)
  })
  it.each([
    ['rate_id', 'r2'],
    ['carrier', 'fedex'],
    ['service', 'economy'],
    ['currency', 'USD'],
  ])('refuses a changed %s', (field, value) => {
    expect((check(quote({ [field]: value })) as any).ok).toBe(false)
  })
  it('refuses a missing or malformed signature', () => {
    expect((check(quote({ signature: undefined })) as any).reason).toBe('missing')
    expect((check(quote({ signature: 'nope' })) as any).reason).toBe('malformed')
    expect((check(quote({ signature: `${NOW + 5}.${'A'.repeat(43)}` })) as any).reason).toBe('mismatch')
  })
  it('refuses a rate quoted for other goods or another destination', () => {
    expect((check(quote(), { ...binding, productIds: ['prod_a'] }) as any).ok).toBe(false)
    expect((check(quote(), { ...binding, postalCode: '44100' }) as any).ok).toBe(false)
  })
  it('refuses once expired, and not before', () => {
    expect(check(quote(), binding, NOW + SHIPPING_QUOTE_TTL_MS - 1)).toEqual({ ok: true })
    expect((check(quote(), binding, NOW + SHIPPING_QUOTE_TTL_MS + 1) as any).reason).toBe('expired')
  })
  it('refuses an expiry the caller edited (exp is signed)', () => {
    const [, mac] = token.split('.')
    expect((check(quote({ signature: `${NOW + 99 * 60_000}.${mac}` })) as any).reason).toBe('mismatch')
  })
  it('refuses a token signed under another secret', () => {
    const other = shippingQuoteKey({ JWT_SECRET: 'someone-else', NODE_ENV: 'test' })!
    expect((check(quote(), binding, NOW + 1000, other) as any).ok).toBe(false)
  })
  it('fails closed with no key, and in production on a missing or default secret', () => {
    expect(shippingQuoteKey({ NODE_ENV: 'production' })).toBeNull()
    expect(shippingQuoteKey({ JWT_SECRET: 'supersecret', NODE_ENV: 'production' })).toBeNull()
    expect(signShippingRate(null, rate, binding, NOW)).toBeNull()
    expect((check(quote(), binding, NOW + 1000, null) as any).reason).toBe('no_key')
    expect(shippingQuoteKey({ JWT_SECRET: 'supersecret', NODE_ENV: 'development' })).not.toBeNull()
  })
  it('verifyShippingQuote rejects a non-string token', () => {
    expect(verifyShippingQuote(key, 42, rate, binding, NOW)).toEqual({ ok: false, reason: 'missing' })
  })
})
