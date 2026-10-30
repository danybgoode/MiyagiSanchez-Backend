/**
 * In-person sale — the PURE half (in-person-sales epic, D3/D4/D5).
 *
 * Validation, the canonical payload hash and the claim-outcome decision live here
 * so the money rules are tested without a database. The I/O shell is
 * `in-person-sale-apply.ts`; it must not re-decide anything this file decides.
 *
 * Order of operations, cited from the lock: validate (here, pure) → claim (insert
 * the unique row) → apply (cart → order). Validation goes first because it needs
 * nothing; a claim made for a payload that can never succeed would only have to be
 * cleaned up.
 */
import { createHash } from 'node:crypto'

export type InPersonSaleKind = 'cash' | 'card' | 'transfer'

export interface InPersonSaleLine {
  variant_id: string
  quantity: number
}

export interface InPersonSaleInput {
  client_id: string
  kind: InPersonSaleKind
  lines: InPersonSaleLine[]
  /** Cash only: what the buyer handed over, in centavos. Absent ⇒ exact amount. */
  tendered_cents: number | null
  /** Offline sync (S3): the sale happened earlier, without signal. */
  offline: boolean
  /** When the sale was rung up (device clock, ISO). Defaults to now. */
  sold_at: string | null
  /** Optional address for a receipt. Never required, never invented. */
  buyer_email: string | null
}

export const SOLD_AT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const SOLD_AT_MAX_SKEW_MS = 5 * 60 * 1000

// D3 caps. 50 lines is far beyond a stall sale and bounds the work one request can ask for.
export const MAX_LINES = 50
export const MAX_QUANTITY = 999

// RFC 4122 shape, any version — `crypto.randomUUID` mints v4, older devices may not.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ValidationResult =
  | { ok: true; sale: InPersonSaleInput }
  | { ok: false; code: string; message: string }

function fail(code: string, message: string): ValidationResult {
  return { ok: false, code, message }
}

/**
 * Validate and canonicalise a request body. Duplicate variant lines are MERGED
 * (two taps on the same product are one line of quantity 2), so the payload hash
 * below cannot differ between two spellings of the same sale.
 */
export function validateInPersonSale(body: unknown, now: Date = new Date()): ValidationResult {
  if (!body || typeof body !== 'object') return fail('INVALID_BODY', 'Falta la venta.')
  const b = body as Record<string, unknown>

  const clientId = typeof b.client_id === 'string' ? b.client_id.trim().toLowerCase() : ''
  if (!UUID_RE.test(clientId)) return fail('INVALID_CLIENT_ID', 'client_id debe ser un UUID.')

  const kind = b.kind ?? 'cash'
  if (kind !== 'cash' && kind !== 'card' && kind !== 'transfer') {
    return fail('INVALID_KIND', 'Método de cobro no válido.')
  }

  if (!Array.isArray(b.lines) || b.lines.length === 0) return fail('EMPTY_SALE', 'La venta no tiene productos.')
  const merged = new Map<string, number>()
  for (const raw of b.lines) {
    const line = (raw ?? {}) as Record<string, unknown>
    const variantId = typeof line.variant_id === 'string' ? line.variant_id.trim() : ''
    const qty = line.quantity
    if (!variantId) return fail('INVALID_LINE', 'Cada producto necesita su variante.')
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      return fail('INVALID_QUANTITY', `La cantidad debe ser un entero entre 1 y ${MAX_QUANTITY}.`)
    }
    merged.set(variantId, (merged.get(variantId) ?? 0) + qty)
  }
  if (merged.size > MAX_LINES) return fail('TOO_MANY_LINES', `Máximo ${MAX_LINES} productos por venta.`)
  for (const q of merged.values()) {
    if (q > MAX_QUANTITY) return fail('INVALID_QUANTITY', `La cantidad debe ser un entero entre 1 y ${MAX_QUANTITY}.`)
  }
  const lines = [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([variant_id, quantity]) => ({ variant_id, quantity }))

  let tendered: number | null = null
  if (b.tendered_cents != null) {
    if (kind !== 'cash') return fail('TENDERED_NOT_CASH', 'Solo el efectivo lleva monto recibido.')
    const t = b.tendered_cents
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) {
      return fail('INVALID_TENDERED', 'El monto recibido debe estar en centavos enteros.')
    }
    tendered = t
  }

  const offline = b.offline === true
  // D11: only cash can be rung up without signal; card and transfer need the network.
  if (offline && kind !== 'cash') return fail('OFFLINE_NOT_CASH', 'Sin señal solo se puede cobrar en efectivo.')

  let soldAt: string | null = null
  if (b.sold_at != null) {
    const d = typeof b.sold_at === 'string' ? new Date(b.sold_at) : null
    if (!d || Number.isNaN(d.getTime())) return fail('INVALID_SOLD_AT', 'Fecha de venta no válida.')
    // An offline sale syncs within days, and phone clocks drift a little: anything older
    // than 30 days or more than 5 minutes ahead is not a counter sale's real time
    // (verifier, PR 460 — sold_at was unbounded).
    if (d.getTime() < now.getTime() - SOLD_AT_MAX_AGE_MS || d.getTime() > now.getTime() + SOLD_AT_MAX_SKEW_MS) {
      return fail('INVALID_SOLD_AT', 'La fecha de la venta no es válida.')
    }
    soldAt = d.toISOString()
  }

  let buyerEmail: string | null = null
  if (b.buyer_email != null && b.buyer_email !== '') {
    const e = typeof b.buyer_email === 'string' ? b.buyer_email.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(e) || e.length > 254) return fail('INVALID_EMAIL', 'Correo no válido.')
    buyerEmail = e
  }

  return {
    ok: true,
    sale: { client_id: clientId, kind, lines, tendered_cents: tendered, offline, sold_at: soldAt, buyer_email: buyerEmail },
  }
}

/**
 * The fingerprint of WHAT was sold. Deliberately excludes `tendered_cents`,
 * `sold_at` and `buyer_email`: a resend of the same sale with a corrected cash
 * amount or receipt address is still the same sale, while a different set of
 * products under a reused client_id is not.
 */
export function inPersonPayloadHash(sale: Pick<InPersonSaleInput, 'kind' | 'lines'>): string {
  const canonical = JSON.stringify({ kind: sale.kind, lines: sale.lines.map((l) => [l.variant_id, l.quantity]) })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * The cash a counter must hand back, or the amount still owed. Integer centavos.
 * `tendered == null` means "they paid the exact amount".
 */
export function cashChange(totalCents: number, tenderedCents: number | null): { change_cents: number; short_cents: number } {
  if (tenderedCents == null) return { change_cents: 0, short_cents: 0 }
  const diff = tenderedCents - totalCents
  return diff >= 0 ? { change_cents: diff, short_cents: 0 } : { change_cents: 0, short_cents: -diff }
}

/** A claim younger than this is an in-flight request; older is presumed dead and may be taken over (D4). */
export const CLAIM_STALE_MS = 60_000

export interface ExistingClaim {
  status: string
  payload_hash: string
  order_id: string | null
  cart_id: string | null
  claimed_at: Date | string
  claim_token?: string
}

export type ClaimOutcome =
  | { action: 'replay'; order_id: string }
  /** A card/transfer sale whose cart is built and waits for its payment (S2, D9/D10). */
  | { action: 'awaiting'; cart_id: string }
  | { action: 'reject_reused'; }
  | { action: 'in_progress' }
  | { action: 'takeover'; cart_id: string | null }
  | { action: 'reject_closed'; status: string }

/**
 * What to do when the claim insert hit the unique index — i.e. this client_id was
 * seen before. Pure; `now` is injected so the stale boundary is testable.
 *
 * The payload check comes FIRST: a reused client_id carrying a different sale must
 * never be answered with someone else's order, even a completed one.
 */
export function decideExistingClaim(existing: ExistingClaim, payloadHash: string, now: Date): ClaimOutcome {
  if (existing.payload_hash !== payloadHash) return { action: 'reject_reused' }
  if (existing.status === 'completed' && existing.order_id) return { action: 'replay', order_id: existing.order_id }
  // Waiting is a settled state, not an in-flight one: the cart exists and the buyer is
  // paying. A resend (a reload, a lost answer) gets the same cart back — never a second
  // cart, which would mean a second checkout the buyer could also pay.
  if (existing.status === 'awaiting_payment' && existing.cart_id) return { action: 'awaiting', cart_id: existing.cart_id }
  if (existing.status === 'cancelled' || existing.status === 'failed') {
    return { action: 'reject_closed', status: existing.status }
  }
  const claimedAt = new Date(existing.claimed_at).getTime()
  if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < CLAIM_STALE_MS) return { action: 'in_progress' }
  return { action: 'takeover', cart_id: existing.cart_id }
}

/**
 * Which payment providers may complete a counter cart of each kind (in-person-sales
 * D5/D9/D10). Enforced in `completeCartWorkflow`'s validate hook, BEFORE the order
 * exists: a buyer holding a card sale's cart id can switch its session to the cash
 * provider through the public payment-session route and complete it — an order with
 * no money behind it, stock reserved and revenue booked (codex security lens, PR 218).
 */
export const COUNTER_ALLOWED_PROVIDERS: Readonly<Record<InPersonSaleKind, ReadonlySet<string>>> = {
  cash: new Set(['pp_cash_cash']),
  card: new Set(['pp_stripe-connect_stripe-connect', 'pp_mercadopago_mercadopago']),
  transfer: new Set(['pp_manual_manual']),
}

/** The providers among `providerIds` a counter cart of `kind` may NOT complete on. */
export function disallowedCounterProviders(kind: string, providerIds: string[]): string[] {
  const allowed = COUNTER_ALLOWED_PROVIDERS[kind as InPersonSaleKind]
  if (!allowed) return [...providerIds]
  return providerIds.filter((id) => !allowed.has(id))
}

/**
 * Does a cart still hold exactly the sale its claim recorded? Lines are compared by the
 * same canonical hash as the claim (merged by variant, sorted); the total — when the
 * claim recorded one — must match to the centavo, which also catches a promotion code
 * added through the public cart routes (codex security lens, PR 218).
 */
export function counterCartMatchesClaim(
  cart: { total?: unknown; items: Array<{ variant_id?: string | null; quantity?: unknown }> },
  claim: { kind: string; payload_hash: string; total_cents?: unknown },
): boolean {
  const merged = new Map<string, number>()
  for (const it of cart.items ?? []) {
    const v = typeof it?.variant_id === 'string' ? it.variant_id : ''
    const q = Number(it?.quantity)
    if (!v || !Number.isInteger(q) || q < 1) return false
    merged.set(v, (merged.get(v) ?? 0) + q)
  }
  if (merged.size === 0) return false
  const lines = [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([variant_id, quantity]) => ({ variant_id, quantity }))
  if (inPersonPayloadHash({ kind: claim.kind as InPersonSaleKind, lines }) !== claim.payload_hash) return false
  if (typeof claim.total_cents === 'number') {
    return Math.round(Number(cart.total ?? NaN)) === claim.total_cents
  }
  return true
}

/**
 * Which public store requests would MUTATE a cart or its payment — the routes a counter
 * cart must refuse once the merchant rang it up (in-person-sales D8, codex rounds 5–9:
 * every attack on a counter sale began with someone holding its cart id calling these).
 *
 * Returns the cart id the request targets, `{ collectionId }` for the payment-session
 * route (the caller resolves its cart), `{ bodyCart: true }` for collection creation
 * (cart id in the body), or null when the request is not a cart mutation. Our own
 * routes that must keep working on counter carts are excluded by name: completion (the
 * webhook and the transfer path), start-checkout and mp-authorize (both guard counter
 * carts themselves). Reads are never mutations.
 */
export type CartMutationTarget = { cartId: string } | { collectionId: string } | { bodyCart: true } | null

const OPEN_CART_ACTIONS = new Set(['complete', 'start-checkout', 'mp-authorize'])

export function cartMutationTarget(method: string, path: string): CartMutationTarget {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null
  const clean = path.split('?')[0].replace(/\/+$/, '')
  const pc = clean.match(/^\/store\/payment-collections\/([^/]+)\/payment-sessions$/)
  if (pc) return { collectionId: pc[1] }
  if (clean === '/store/payment-collections') return { bodyCart: true }
  const c = clean.match(/^\/store\/carts\/([^/]+)(?:\/([^/]+))?/)
  if (!c) return null
  if (c[2] && OPEN_CART_ACTIONS.has(c[2])) return null
  return { cartId: c[1] }
}

export interface OversoldLinePlan {
  variant_id: string
  quantity: number
  /** Units actually taken out of stock (never below zero available). */
  decrement: number
  /** Units sold that stock no longer had: the merchant sold more than the system knew. */
  shortfall: number
}

/**
 * D12 — an OFFLINE cash sale already happened at the stall, so at sync it is recorded
 * even when stock ran out meanwhile (an online sale took the last unit). Stock is
 * decremented only as far as it goes (`available` = stocked − reserved, never below
 * zero) and the rest is recorded as a shortfall the inbox flags. `available` null means
 * the variant does not manage inventory: nothing to decrement, nothing short.
 */
export function planOversoldDecrement(
  lines: Array<{ variant_id: string; quantity: number }>,
  available: Record<string, number | null>,
): OversoldLinePlan[] {
  return lines.map((l) => {
    const a = available[l.variant_id]
    if (a == null) return { variant_id: l.variant_id, quantity: l.quantity, decrement: 0, shortfall: 0 }
    const decrement = Math.max(0, Math.min(l.quantity, Math.floor(a)))
    return { variant_id: l.variant_id, quantity: l.quantity, decrement, shortfall: l.quantity - decrement }
  })
}
