import { checkFulfillmentMethod, sellerShippingInput, FULFILLMENT_METHOD_INVALID_MESSAGE } from '../fulfillment-method-guard'

/** A carrier-only physical product must not be bought as 'digital'/'local_pickup' to skip shipping. */
const shipper = { localPickup: false, pickupSpots: [], hasLiveShipping: true }
const physical = [{ listingType: 'product', deliveryMode: 'carrier' as const }]
const run = (method: string, over: Record<string, unknown> = {}) =>
  checkFulfillmentMethod({ method, products: physical, seller: shipper, arrangedOnlyEnabled: true, market: 'mx', ...over } as any)

describe('checkFulfillmentMethod', () => {
  it('accepts shipping on a shippable product', () => expect(run('shipping')).toEqual({ ok: true }))
  it.each(['digital', 'local_pickup', 'rental', 'service'])('refuses %s on a carrier-only physical product', (m) => {
    expect(run(m)).toEqual({ ok: false, status: 422, code: 'FULFILLMENT_METHOD_INVALID', message: FULFILLMENT_METHOD_INVALID_MESSAGE })
  })
  it('accepts pickup only when the seller offers it', () => {
    expect(run('local_pickup', { seller: { ...shipper, localPickup: true } })).toEqual({ ok: true })
  })
  it('accepts digital for a digital listing', () => {
    expect(run('digital', { products: [{ listingType: 'digital', deliveryMode: 'carrier' }] })).toEqual({ ok: true })
  })
  it('refuses shipping when the seller has no live shipping', () => {
    expect(run('shipping', { seller: { ...shipper, hasLiveShipping: false } }).ok).toBe(false)
  })
  it('keeps the coordinated fallback (already manual-payment only)', () => {
    expect(run('none')).toEqual({ ok: true })
    expect(run('coord')).toEqual({ ok: true })
  })
  it('every product in a bundle must offer the method', () => {
    expect(run('shipping', { products: [...physical, { listingType: 'digital', deliveryMode: 'carrier' }] }).ok).toBe(false)
  })
  it('fails closed when the products could not be hydrated', () => {
    expect(run('shipping', { products: null }).ok).toBe(false)
  })
  it('derives seller inputs as checkout-options does', () => {
    const meta = { settings: { shipping: { local_pickup: true, pickup_spots: [{ name: 'a' }], origin_address: { street: 's', city: 'c', state: 'x', postal_code: '1' } } } }
    expect(sellerShippingInput(meta, false)).toEqual({ localPickup: true, pickupSpots: [{ name: 'a' }], hasLiveShipping: true })
    expect(sellerShippingInput({}, false).hasLiveShipping).toBe(false)
  })
})
