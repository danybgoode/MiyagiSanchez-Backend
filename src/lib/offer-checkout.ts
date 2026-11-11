/**
 * A checkout may charge a negotiated price ONLY when that price is a real, accepted offer.
 *
 * Why this exists: start-checkout used to take `offer_amount_cents` straight from the request
 * body for any ordinary cart and charge it. Nothing tied it to an offer, so anyone could POST
 * `offer_amount_cents: 1` (directly, or through the storefront proxy that forwards the body)
 * and pay one centavo for any listing.
 *
 * The rules mirror the storefront's own offer rail (apps/storefront):
 *  - the agreed state is `status = 'accepted'` (lib/offer-respond.ts accept; buyer-respond
 *    counter-accept both write it);
 *  - the agreed price is `counter_amount_cents ?? offer_amount_cents`
 *    (app/api/stripe/checkout/route.ts:68-69 — a counter the buyer accepted overrides the offer);
 *  - after accept the only live deadline is `checkout_expires_at` (the 24h payment window);
 *    `expires_at` is the seller-response deadline and no longer applies once accepted.
 *
 * Refusing (422) is the safe default over silently charging the listing price: a buyer who
 * negotiated a price must never be quietly billed more than they agreed, and a forged amount
 * must never be quietly "corrected" into a sale that looks legitimate.
 *
 * Pure decision + an injected lookup, so it is unit-testable with no Supabase.
 */

export const OFFER_INVALID_MESSAGE = 'Esta oferta no es válida para este carrito.'
export const OFFER_UNAVAILABLE_MESSAGE = 'No pudimos verificar la oferta. Inténtalo de nuevo en un momento.'

export type OfferRecord = {
  id: string
  status: string | null
  offer_amount_cents: number | null
  counter_amount_cents: number | null
  checkout_expires_at: string | null
  buyer_clerk_user_id: string | null
  buyer_email: string | null
  /** marketplace_listings.medusa_product_id of the offer's listing (null = unmapped). */
  listing_medusa_product_id: string | null
}

/** `null` = the offer does not exist. A THROW = we could not look (unavailable, not "none"). */
export type OfferLookup = (offerId: string) => Promise<OfferRecord | null>

export type OfferCheckoutInput = {
  offerAmountCents: unknown
  offerId: unknown
  cartItems: Array<{ product_id?: string | null; variant?: { product_id?: string | null } | null; quantity?: number | null }>
  /** Verified Clerk id of the caller, if any. */
  clerkUserId: string | null
  /** Every email the request knows for the buyer (cart email, body buyer_email, verified token email). */
  buyerEmails: Array<string | null | undefined>
  now: Date
}

export type OfferCheckoutDecision =
  | { ok: true; amountCents: number | undefined; offerId: string | undefined }
  | { ok: false; status: 422 | 503; code: 'OFFER_INVALID' | 'OFFER_UNAVAILABLE'; message: string }

const invalid = (): OfferCheckoutDecision => ({ ok: false, status: 422, code: 'OFFER_INVALID', message: OFFER_INVALID_MESSAGE })

export function agreedAmountCents(o: Pick<OfferRecord, 'counter_amount_cents' | 'offer_amount_cents'>): number | null {
  const n = o.counter_amount_cents ?? o.offer_amount_cents
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

export async function resolveOfferCheckout(
  input: OfferCheckoutInput,
  lookup: OfferLookup,
): Promise<OfferCheckoutDecision> {
  const hasAmount = input.offerAmountCents !== undefined && input.offerAmountCents !== null
  // No amount override: nothing to verify (a bare offer_id only tags the order for reconciliation,
  // and the server drops it below when it cannot be trusted — see the caller).
  if (!hasAmount) return { ok: true, amountCents: undefined, offerId: undefined }

  if (typeof input.offerId !== 'string' || input.offerId.length === 0) return invalid()
  const amount = input.offerAmountCents
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return invalid()

  let offer: OfferRecord | null
  try {
    offer = await lookup(input.offerId)
  } catch {
    return { ok: false, status: 503, code: 'OFFER_UNAVAILABLE', message: OFFER_UNAVAILABLE_MESSAGE }
  }
  if (!offer) return invalid()

  if (offer.status !== 'accepted') return invalid()

  // A NULL checkout_expires_at is legitimate, not a gap: the storefront leaves it null when the seller
  // has no Stripe account to open a payment window on (apps/storefront/lib/offer-respond.ts:298 initialises
  // `checkoutExpires = null` and sets it only inside the Stripe-enabled branch, ~line 328). Such an offer
  // has no payment deadline to enforce here, so we do not refuse it.
  if (offer.checkout_expires_at) {
    const exp = Date.parse(offer.checkout_expires_at)
    if (!Number.isFinite(exp) || exp <= input.now.getTime()) return invalid()
  }

  // Single-item, quantity-1 cart for the offer's own listing.
  const items = input.cartItems
  if (items.length !== 1) return invalid()
  const qty = Number(items[0].quantity ?? 1)
  if (qty !== 1) return invalid()
  // Same resolution the route uses for the charged item (`item.product_id ?? item.variant?.product_id`).
  const cartProductId = items[0].product_id ?? items[0].variant?.product_id ?? null
  if (!offer.listing_medusa_product_id || cartProductId !== offer.listing_medusa_product_id) return invalid()

  const agreed = agreedAmountCents(offer)
  if (agreed === null || agreed !== amount) return invalid()

  // Buyer identity: ONLY the same VERIFIED Clerk id that made the offer. There is no email path at all —
  // the cart email and body buyer_email are caller-supplied, so an email proves nothing (codex, PR #231).
  // Every offer is made by a signed-in buyer (storefront app/api/offers/route.ts requires currentUser());
  // live, 0 of 3 offers had no buyer_clerk_user_id (2026-11-11), so an offer without one is refused.
  // `input.clerkUserId` comes from extractClerkUserId(req): the token the middleware verified against JWKS.
  if (!offer.buyer_clerk_user_id || !input.clerkUserId || offer.buyer_clerk_user_id !== input.clerkUserId) {
    return invalid()
  }

  return { ok: true, amountCents: agreed, offerId: offer.id }
}

/** The production lookup: Supabase `marketplace_offers` joined to its listing's Medusa product. */
export function supabaseOfferLookup(supabase: {
  from: (t: string) => any
}): OfferLookup {
  return async (offerId) => {
    const { data, error } = await supabase
      .from('marketplace_offers')
      .select(
        'id, status, offer_amount_cents, counter_amount_cents, checkout_expires_at, buyer_clerk_user_id, buyer_email, marketplace_listings(medusa_product_id)',
      )
      .eq('id', offerId)
      .maybeSingle()
    if (error) throw new Error(error.message ?? 'offer lookup failed')
    if (!data) return null
    const l = Array.isArray(data.marketplace_listings) ? data.marketplace_listings[0] : data.marketplace_listings
    return {
      id: data.id,
      status: data.status ?? null,
      offer_amount_cents: data.offer_amount_cents ?? null,
      counter_amount_cents: data.counter_amount_cents ?? null,
      checkout_expires_at: data.checkout_expires_at ?? null,
      buyer_clerk_user_id: data.buyer_clerk_user_id ?? null,
      buyer_email: data.buyer_email ?? null,
      listing_medusa_product_id: l?.medusa_product_id ?? null,
    }
  }
}

// ── One accepted offer opens ONE checkout at a time ─────────────────────────────────────
// resolveOfferCheckout only READS, so two tabs (or two scripts) could each open a discounted
// checkout on one accepted offer. validate (above) → CLAIM (here) → apply (the payment session).
// The claim is a conditional write read back with `.select()` — a read followed by a write is
// a lost update waiting to happen. It uses its OWN column, `checkout_reserved_at`: the existing
// checkout_session_id / checkout_expires_at are written at accept time for the offer's own pay
// link and drive the 24h payment window, so they cannot carry a short reservation.

/**
 * An offer's payment session lives 31 minutes: Stripe refuses an `expires_at` under 30 minutes
 * from when IT receives the request, so exactly 30 would fail on network latency (same reason
 * as COUNTER_CHECKOUT_TTL_MS in start-checkout). The reservation outlives the session by 5
 * minutes, so a reservation can never be reclaimed while its own session could still be paid.
 */
export const OFFER_SESSION_TTL_MS = 31 * 60 * 1000
export const OFFER_RESERVATION_STALE_MS = OFFER_SESSION_TTL_MS + 5 * 60 * 1000
export const OFFER_IN_CHECKOUT_MESSAGE =
  `Ya tienes un pago abierto para esta oferta. Termínalo o inténtalo de nuevo en ${Math.round(OFFER_RESERVATION_STALE_MS / 60000)} minutos.`
/** A manual-payment offer order has no session to expire: the reservation is kept far in the future. */
export const OFFER_RESERVATION_PERMANENT_ISO = '9999-12-31T00:00:00.000Z'

/** Resolves true when this caller won the reservation. A THROW = the claim could not be made. */
/** `writeIso` is the value stored in checkout_reserved_at; `nowIso` is for the offer-expiry condition. */
export type OfferClaim = (offerId: string, writeIso: string, staleBeforeIso: string, nowIso: string) => Promise<boolean>
export type OfferRelease = (offerId: string, reservedAtIso: string) => Promise<void>

export type OfferClaimDecision =
  | { ok: true; reservedAt: string }
  | { ok: false; status: 409 | 503; code: 'OFFER_IN_CHECKOUT' | 'OFFER_UNAVAILABLE'; message: string }

/**
 * `permanent` is for a MANUAL-payment checkout: its order is created immediately and there is no
 * session to expire, so the reservation is CLAIMED with the far-future timestamp up front. (A
 * second write after the order existed could fail or match nothing and silently leave the offer
 * re-checkable-out after the stale window.) The release-on-failure hook keys on the value written,
 * so a manual checkout that fails still frees the offer.
 */
export async function claimOfferForCheckout(offerId: string, now: Date, claim: OfferClaim, opts: { permanent?: boolean } = {}): Promise<OfferClaimDecision> {
  const nowIso = now.toISOString()
  const writeIso = opts.permanent ? OFFER_RESERVATION_PERMANENT_ISO : nowIso
  const staleBeforeIso = new Date(now.getTime() - OFFER_RESERVATION_STALE_MS).toISOString()
  let won: boolean
  try {
    won = await claim(offerId, writeIso, staleBeforeIso, nowIso)
  } catch {
    // Could not claim is NOT "free to pay": never let a checkout through unclaimed.
    return { ok: false, status: 503, code: 'OFFER_UNAVAILABLE', message: OFFER_UNAVAILABLE_MESSAGE }
  }
  if (!won) return { ok: false, status: 409, code: 'OFFER_IN_CHECKOUT', message: OFFER_IN_CHECKOUT_MESSAGE }
  return { ok: true, reservedAt: writeIso }
}

/** Best-effort: a failed release only means the 30-minute stale window frees the offer instead. */
export async function releaseOfferClaim(
  offerId: string,
  reservedAt: string,
  release: OfferRelease,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<boolean> {
  try {
    await release(offerId, reservedAt)
    return true
  } catch (e) {
    log(`[offer-checkout] release of offer ${offerId} failed: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export function supabaseOfferClaim(supabase: { from: (t: string) => any }): OfferClaim {
  return async (offerId, writeIso, staleBeforeIso, nowIso) => {
    const { data, error } = await supabase
      .from('marketplace_offers')
      .update({ checkout_reserved_at: writeIso })
      .eq('id', offerId)
      .eq('status', 'accepted')
      .or(`checkout_reserved_at.is.null,checkout_reserved_at.lt.${staleBeforeIso}`)
      // An expired payment window cannot be reserved. NULL is legitimate (a seller without Stripe has
      // no window — offer-respond.ts initialises it null), so null stays claimable.
      .or(`checkout_expires_at.is.null,checkout_expires_at.gt.${nowIso}`)
      .select('id')
    if (error) throw new Error(error.message ?? 'offer claim failed')
    return Array.isArray(data) && data.length > 0
  }
}

export function supabaseOfferRelease(supabase: { from: (t: string) => any }): OfferRelease {
  return async (offerId, reservedAtIso) => {
    // Only OUR reservation: if a later checkout reclaimed a stale one, its timestamp differs.
    const { error } = await supabase
      .from('marketplace_offers')
      .update({ checkout_reserved_at: null })
      .eq('id', offerId)
      .eq('checkout_reserved_at', reservedAtIso)
    if (error) throw new Error(error.message ?? 'offer release failed')
  }
}
