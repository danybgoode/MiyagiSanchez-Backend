/**
 * start-checkout accepts only a delivery method the listing really offers.
 *
 * Why: `fulfillment_method` came straight from the request body (default 'none') and was never
 * compared with what the listing and seller offer. A carrier-only physical product could be
 * paid by card as 'digital' or 'local_pickup' and skip shipping entirely. The allowed set is
 * re-derived here from the product and seller data with the SAME pure builder the
 * `checkout-options` route uses to build the buyer's choices (buildDeliveryCatalog), so the two
 * can never disagree.
 *
 * 'none' and 'coord' are always accepted HERE because they are the coordinated fallback and
 * start-checkout already refuses them for any non-manual provider (the COORD guard: nothing is
 * charged by us, the buyer settles directly with the seller). Support carts are 'digital' by
 * construction and server-built carts (counter sale / payment link) set their own method, so
 * both are exempt; the caller decides that from server-side facts, never from the body.
 */
import { buildDeliveryCatalog, type DeliveryMode, type PickupSpot } from '../api/store/_utils/delivery-catalog'

export const FULFILLMENT_METHOD_INVALID_MESSAGE = 'Ese método de entrega no está disponible para este anuncio.'

export type GuardProduct = { listingType: string; deliveryMode: DeliveryMode }

export type SellerShippingInput = {
  localPickup: boolean
  pickupSpots: PickupSpot[]
  hasLiveShipping: boolean
}

export type FulfillmentMethodDecision =
  | { ok: true }
  | { ok: false; status: 422; code: 'FULFILLMENT_METHOD_INVALID'; message: string }

const refuse = (): FulfillmentMethodDecision => ({
  ok: false, status: 422, code: 'FULFILLMENT_METHOD_INVALID', message: FULFILLMENT_METHOD_INVALID_MESSAGE,
})

export function checkFulfillmentMethod(input: {
  method: string
  /** Every product in the cart, hydrated from the DB. Incomplete hydration must be passed as `null`. */
  products: GuardProduct[] | null
  seller: SellerShippingInput
  arrangedOnlyEnabled: boolean
  market: 'mx' | 'us'
}): FulfillmentMethodDecision {
  const { method, products, seller } = input
  if (method === 'none' || method === 'coord') return { ok: true }
  if (!products || products.length === 0) return refuse() // cannot verify => fail closed
  for (const p of products) {
    const isDigital = p.listingType === 'digital' || p.listingType === 'print_ad'
    const { deliveryMethods } = buildDeliveryCatalog({
      listingType: p.listingType,
      isDigital,
      deliveryMode: p.deliveryMode,
      arrangedOnlyEnabled: input.arrangedOnlyEnabled,
      localPickup: seller.localPickup,
      pickupSpots: seller.pickupSpots,
      hasLiveShipping: seller.hasLiveShipping,
      market: input.market,
    })
    if (!deliveryMethods.some((m) => m.id === method)) return refuse()
  }
  return { ok: true }
}

/** The seller-side inputs, derived exactly as checkout-options derives them. */
export function sellerShippingInput(
  sellerMetadata: unknown,
  correosSellerEligible: boolean,
): SellerShippingInput {
  const settings = ((sellerMetadata ?? {}) as any).settings ?? {}
  const shipping = (settings.shipping ?? {}) as Record<string, any>
  const localPickup = shipping.local_pickup === true
  const origin = (shipping.origin_address ?? {}) as Record<string, string | null>
  const hasShippingOrigin = !!(origin.street && origin.city && origin.state && origin.postal_code)
  return {
    localPickup,
    pickupSpots: localPickup ? (shipping.pickup_spots ?? []) : [],
    hasLiveShipping: (shipping.envia_enabled !== false || correosSellerEligible) && hasShippingOrigin,
  }
}
