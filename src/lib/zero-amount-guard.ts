/**
 * Checkout refuses to charge an item amount of zero or less.
 *
 * Why: start-checkout resolves the item amount from several sources (cart total, offer,
 * support, rental, coupon, bundle). A free Evento, an unpriced listing or a 100% coupon left a
 * final amount of 0 and the public store API happily built a $0 order. The decision reads the
 * FINAL amount the route is about to charge, not any flag in the request body (a body flag is
 * something the caller can name — see LEARNINGS «a guard that exempts on request-body flags»).
 *
 * Server-built carts (counter sale / payment link) are exempt because OUR routes price them:
 * a payment link refuses < LINK_MIN_AMOUNT_CENTS (1000) and a counter sale is rung up from
 * the merchant's own variants, with its own claim/total checks. The exemption is the
 * server's claim lookup (`serverCartSource`), never a body field.
 */
export const ZERO_AMOUNT_MESSAGE = 'Este anuncio no tiene un precio para cobrar.'
export const COUPON_ZERO_MESSAGE = 'Este cupón deja el total en $0 y no se puede cobrar.'

export function checkItemAmount(
  finalItemCents: number,
  serverCartSource: 'in_person' | 'payment_link' | null,
  /** What the coupon took off. When the item amount BEFORE it was positive, the coupon caused the $0. */
  couponDiscountCents = 0,
  amountBeforeCouponCents = 0,
): { ok: true } | { ok: false; status: 422; code: 'ZERO_AMOUNT'; message: string } {
  if (serverCartSource) return { ok: true }
  if (!Number.isFinite(finalItemCents) || finalItemCents <= 0) {
    const byCoupon = couponDiscountCents > 0 && amountBeforeCouponCents > 0
    return { ok: false, status: 422, code: 'ZERO_AMOUNT', message: byCoupon ? COUPON_ZERO_MESSAGE : ZERO_AMOUNT_MESSAGE }
  }
  return { ok: true }
}
