/**
 * A shipping price is charged ONLY when this server quoted it.
 *
 * Why this exists: start-checkout used to charge `shipping_quote.amount_cents` exactly as the
 * request body sent it (through the storefront proxy or straight at the public store API), so a
 * buyer could name their own shipping price — a forged amount reached Stripe and Mercado Pago
 * as a line item. The quote is now signed when /store/envia/rates issues it and checked again
 * when checkout starts; the amount, the carrier and the rate id cannot be changed in between.
 *
 * What the signature binds (all of it, or the token does not verify):
 *   rate_id, carrier, service, amount_cents, currency  — the rate itself
 *   products   — the sorted, de-duplicated Medusa product ids the rate was quoted for
 *   postal     — the destination postal code, normalised
 *   exp        — expiry (ms since epoch)
 * There is NO cart id: the buyer's checkout page asks for rates before any cart exists (the cart
 * is built only when they press pay), so the cart id is not knowable at quote time. Products +
 * destination are what start-checkout can see on the cart it is charging, and a rate quoted for
 * other goods or another postcode is refused.
 *
 * Key: HKDF-SHA256 derived from the backend's existing JWT_SECRET with the label
 * `shipping-quote-v1` — no new secret on the VM. The label keeps this key independent of every
 * other use of JWT_SECRET, so a token signed here is never valid anywhere else (or vice versa).
 * `medusa-config.ts` falls back to the literal 'supersecret' when JWT_SECRET is unset; signing
 * with a publicly known key would be no signature at all, so in production a missing or default
 * secret yields NO key and the caller fails closed (rates carry no signature -> checkout refuses).
 *
 * Pure: the secret, clock and inputs are all passed in, so the unit spec needs no server.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'crypto'

export const SHIPPING_QUOTE_INVALID_MESSAGE = 'Vuelve a elegir el envío.'
export const SHIPPING_QUOTE_TTL_MS = 30 * 60 * 1000
const KEY_LABEL = 'shipping-quote-v1'
const DEFAULT_SECRET = 'supersecret'

export type SignedRateFields = {
  rate_id: string
  carrier: string
  service: string
  amount_cents: number
  currency: string
}

export type QuoteBinding = {
  productIds: Array<string | null | undefined>
  postalCode: string | null | undefined
}

/** The HMAC key, or null when no trustworthy secret exists (fail closed). */
export function shippingQuoteKey(env: Record<string, string | undefined>): Buffer | null {
  const secret = env.JWT_SECRET
  if (!secret) {
    return env.NODE_ENV === 'production' ? null : Buffer.from(hkdf(DEFAULT_SECRET))
  }
  if (secret === DEFAULT_SECRET && env.NODE_ENV === 'production') return null
  return Buffer.from(hkdf(secret))
}

function hkdf(secret: string): ArrayBuffer {
  return hkdfSync('sha256', secret, '', KEY_LABEL, 32)
}

function normalizePostal(p: string | null | undefined): string {
  return String(p ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeProducts(ids: QuoteBinding['productIds']): string[] {
  return Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))).sort()
}

function mac(key: Buffer, rate: SignedRateFields, binding: QuoteBinding, exp: number): Buffer {
  // JSON array, not string concatenation: no delimiter ambiguity between adjacent fields.
  const payload = JSON.stringify([
    1,
    rate.rate_id,
    rate.carrier,
    rate.service,
    rate.amount_cents,
    String(rate.currency).toUpperCase(),
    normalizeProducts(binding.productIds),
    normalizePostal(binding.postalCode),
    exp,
  ])
  return createHmac('sha256', key).update(payload).digest()
}

/** Token = `<exp>.<base64url hmac>`. Null when there is no key. */
export function signShippingRate(
  key: Buffer | null,
  rate: SignedRateFields,
  binding: QuoteBinding,
  nowMs: number,
  ttlMs: number = SHIPPING_QUOTE_TTL_MS,
): string | null {
  if (!key) return null
  const exp = nowMs + ttlMs
  return `${exp}.${mac(key, rate, binding, exp).toString('base64url')}`
}

export type ShippingQuoteVerdict = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' | 'no_key' }

export function verifyShippingQuote(
  key: Buffer | null,
  token: unknown,
  rate: SignedRateFields,
  binding: QuoteBinding,
  nowMs: number,
): ShippingQuoteVerdict {
  if (!key) return { ok: false, reason: 'no_key' }
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' }
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!m) return { ok: false, reason: 'malformed' }
  const exp = Number(m[1])
  const given = Buffer.from(m[2], 'base64url')
  const want = mac(key, rate, binding, exp)
  // Signature first, then expiry: a forged token must not learn anything from the expiry branch.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'mismatch' }
  if (exp <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true }
}

export type ShippingQuoteInput = {
  rate_id?: unknown
  carrier?: unknown
  service?: unknown
  amount_cents?: unknown
  currency?: unknown
  signature?: unknown
}

/**
 * The decision start-checkout makes: a quote the caller sent is chargeable only if its
 * signature verifies against the very fields that would be charged. The fields are compared as
 * the route will USE them (same coercions as `normalizeShippingQuote`), so a value that only
 * normalises into a different amount cannot slip past a signature over the original.
 */
export function checkShippingQuote(
  key: Buffer | null,
  quote: ShippingQuoteInput,
  binding: QuoteBinding,
  nowMs: number,
):
  | { ok: true }
  | { ok: false; status: 422; code: 'SHIPPING_QUOTE_INVALID'; message: string; reason: string } {
  const rate: SignedRateFields = {
    rate_id: String(quote.rate_id ?? '').slice(0, 500),
    carrier: String(quote.carrier ?? '').slice(0, 60),
    service: String(quote.service ?? '').slice(0, 120),
    amount_cents: Math.max(0, Math.round(Number(quote.amount_cents ?? 0))),
    currency: String(quote.currency ?? 'MXN').toUpperCase().slice(0, 3),
  }
  const v = verifyShippingQuote(key, quote.signature, rate, binding, nowMs)
  if (v.ok) return { ok: true }
  return { ok: false, status: 422, code: 'SHIPPING_QUOTE_INVALID', message: SHIPPING_QUOTE_INVALID_MESSAGE, reason: v.reason }
}
