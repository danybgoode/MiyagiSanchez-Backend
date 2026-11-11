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
  cartItems: Array<{ product_id?: string | null; quantity?: number | null }>
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

  if (offer.checkout_expires_at) {
    const exp = Date.parse(offer.checkout_expires_at)
    if (!Number.isFinite(exp) || exp <= input.now.getTime()) return invalid()
  }

  // Single-item, quantity-1 cart for the offer's own listing.
  const items = input.cartItems
  if (items.length !== 1) return invalid()
  const qty = Number(items[0].quantity ?? 1)
  if (qty !== 1) return invalid()
  if (!offer.listing_medusa_product_id || items[0].product_id !== offer.listing_medusa_product_id) return invalid()

  const agreed = agreedAmountCents(offer)
  if (agreed === null || agreed !== amount) return invalid()

  // Buyer identity: a verified Clerk caller must be the offer's buyer; otherwise the buyer's
  // email must match. A mismatching Clerk id is never rescued by an email.
  if (offer.buyer_clerk_user_id && input.clerkUserId) {
    if (offer.buyer_clerk_user_id !== input.clerkUserId) return invalid()
  } else {
    const want = (offer.buyer_email ?? '').trim().toLowerCase()
    const known = input.buyerEmails.map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean)
    if (!want || !known.includes(want)) return invalid()
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
