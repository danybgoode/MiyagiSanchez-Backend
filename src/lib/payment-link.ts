/**
 * Payment links — the PURE half (in-person-sales S4, D13).
 *
 * Validation of what a seller (or their agent) asks for, the token, and the state a
 * link is in. The I/O shell is `payment-link-apply.ts`; the web routes and the MCP
 * internal routes both go through it, so a link made by an agent is validated exactly
 * like one made on the web (S4.4).
 */
import { randomBytes } from 'node:crypto'
import { MAX_LINES, MAX_QUANTITY } from './in-person-sale'

export type PaymentLinkKind = 'products' | 'amount'
export type PaymentLinkUses = 'single' | 'multi'

/** D13: $10 – $50,000 MXN for a free amount. */
export const LINK_MIN_AMOUNT_CENTS = 1_000
export const LINK_MAX_AMOUNT_CENTS = 5_000_000
export const LINK_DEFAULT_DAYS = 7
export const LINK_MAX_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface PaymentLinkInput {
  kind: PaymentLinkKind
  lines: Array<{ variant_id: string; quantity: number }> | null
  concept: string | null
  amount_cents: number | null
  uses: PaymentLinkUses
  expires_at: Date
}

export type LinkValidation =
  | { ok: true; link: PaymentLinkInput }
  | { ok: false; code: string; message: string }

const fail = (code: string, message: string): LinkValidation => ({ ok: false, code, message })

export function validatePaymentLinkInput(body: unknown, now: Date = new Date()): LinkValidation {
  if (!body || typeof body !== 'object') return fail('INVALID_BODY', 'Falta el cobro.')
  const b = body as Record<string, unknown>

  const kind = b.kind
  if (kind !== 'products' && kind !== 'amount') return fail('INVALID_KIND', 'Elige «Productos» o «Cobro libre».')

  const uses = b.uses ?? 'single'
  if (uses !== 'single' && uses !== 'multi') return fail('INVALID_USES', 'Elige un solo pago o varios pagos.')

  const days = b.expires_in_days ?? LINK_DEFAULT_DAYS
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > LINK_MAX_DAYS) {
    return fail('INVALID_EXPIRY', `El link puede durar de 1 a ${LINK_MAX_DAYS} días.`)
  }
  const expires_at = new Date(now.getTime() + days * DAY_MS)

  if (kind === 'amount') {
    // A free amount is ONE charge with a concept: "varios pagos" of the same anticipo
    // is not a thing a stall needs, and multi-use would let one link collect forever.
    if (uses !== 'single') return fail('INVALID_USES', 'Un cobro libre es de un solo pago.')
    const concept = typeof b.concept === 'string' ? b.concept.trim().replace(/\s+/g, ' ') : ''
    if (concept.length < 3 || concept.length > 80) return fail('INVALID_CONCEPT', 'El concepto debe tener de 3 a 80 letras.')
    const amount = b.amount_cents
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('INVALID_AMOUNT', 'El monto debe estar en centavos enteros.')
    if (amount < LINK_MIN_AMOUNT_CENTS || amount > LINK_MAX_AMOUNT_CENTS) {
      return fail('INVALID_AMOUNT', 'El monto debe ser de $10 a $50,000.')
    }
    return { ok: true, link: { kind, lines: null, concept, amount_cents: amount, uses: 'single', expires_at } }
  }

  if (!Array.isArray(b.lines) || b.lines.length === 0) return fail('EMPTY_LINK', 'Elige al menos un producto.')
  const merged = new Map<string, number>()
  for (const raw of b.lines) {
    const line = (raw ?? {}) as Record<string, unknown>
    const variantId = typeof line.variant_id === 'string' ? line.variant_id.trim() : ''
    const qty = line.quantity ?? 1
    if (!variantId) return fail('INVALID_LINE', 'Cada producto necesita su variante.')
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      return fail('INVALID_QUANTITY', `La cantidad debe ser un entero entre 1 y ${MAX_QUANTITY}.`)
    }
    merged.set(variantId, (merged.get(variantId) ?? 0) + qty)
  }
  if (merged.size > MAX_LINES) return fail('TOO_MANY_LINES', `Máximo ${MAX_LINES} productos por link.`)
  const lines = [...merged.entries()]
    .sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0))
    .map(([variant_id, quantity]) => ({ variant_id, quantity }))
  return { ok: true, link: { kind, lines, concept: null, amount_cents: null, uses: uses as PaymentLinkUses, expires_at } }
}

/** 32 random bytes, base64url: 43 characters, never derived from an id (D13). */
export function newPaymentLinkToken(): string {
  return randomBytes(32).toString('base64url')
}

/** A string that could be a token at all — anything else is refused before any lookup. */
export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export type PaymentLinkState = 'pending' | 'paid' | 'expired' | 'cancelled'

/**
 * The state a buyer and the seller see. Expired is derived here, at read time, never
 * stored. A paid SINGLE-use link is paid; a multi-use link stays pending (open) until it
 * expires or is cancelled, whatever it has collected.
 */
export function derivePaymentLinkState(
  link: { status: string; uses: string; expires_at: Date | string },
  now: Date,
): PaymentLinkState {
  if (link.status === 'cancelled') return 'cancelled'
  if (link.status === 'paid' && link.uses === 'single') return 'paid'
  if (new Date(link.expires_at).getTime() <= now.getTime()) return 'expired'
  return 'pending'
}
