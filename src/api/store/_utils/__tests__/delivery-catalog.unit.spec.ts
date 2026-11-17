import { buildDeliveryCatalog, isCoordinatedListing, resolveDeliveryModeForWrite } from '../delivery-catalog'

/**
 * Arranged-only delivery · Sprint 1 · S1.1 (backend enforcement).
 * The `shipping.arranged_only_enabled` flag (enablement polarity / default OFF),
 * applied at the single seam that decides delivery_methods + only_coordinated.
 * Pure function — no flag store, no DB, no Medusa. The flag *value* is resolved
 * by src/lib/flags.ts (fail-open); this proves the derivation.
 */

const baseInput = {
  listingType: 'product',
  isDigital: false,
  localPickup: false,
  pickupSpots: [],
  hasLiveShipping: true,
}

describe('buildDeliveryCatalog · flag OFF or delivery_mode carrier ⇒ byte-identical to today', () => {
  it('flag OFF + deliveryMode carrier: shipping present, no coord, onlyCoordinated false', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'carrier', arrangedOnlyEnabled: false,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['shipping'])
    expect(onlyCoordinated).toBe(false)
  })

  it('flag OFF + deliveryMode arranged: arranged is ignored entirely (flag gates it)', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'arranged', arrangedOnlyEnabled: false,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['shipping'])
    expect(onlyCoordinated).toBe(false)
  })

  it('flag ON + deliveryMode carrier (default): unchanged from today', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'carrier', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['shipping'])
    expect(onlyCoordinated).toBe(false)
  })
})

describe('buildDeliveryCatalog · flag ON + deliveryMode arranged', () => {
  it('pushes coord, suppresses shipping, sets onlyCoordinated true', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods).toEqual([
      { id: 'coord', label: 'Entrega acordada con vendedor', note: 'Coordinas fecha, lugar y pago directamente con el vendedor.' },
    ])
    expect(onlyCoordinated).toBe(true)
  })

  it('local_pickup is unaffected by arranged — both can coexist', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'arranged', arrangedOnlyEnabled: true, localPickup: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['local_pickup', 'coord'])
  })

  it('service listing: coord is pushed alongside the existing service method', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput, listingType: 'service', deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['service', 'coord'])
  })

  it('rental listing: coord is pushed alongside the existing rental method', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput, listingType: 'rental', deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['rental', 'coord'])
  })
})

describe('buildDeliveryCatalog · digital-listing defensive guard', () => {
  it('arranged is ignored for a digital listing even with the flag ON (digital path stays intact)', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, isDigital: true, deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['digital'])
    expect(onlyCoordinated).toBe(false)
  })
})

describe('buildDeliveryCatalog · pickup spot mapping (unchanged behavior)', () => {
  it('falls back to instructions when notes is absent', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput,
      deliveryMode: 'carrier',
      arrangedOnlyEnabled: false,
      localPickup: true,
      pickupSpots: [{ name: 'Tienda Centro', instructions: 'Toca el timbre' }],
    })
    const pickup = deliveryMethods.find(m => m.id === 'local_pickup')
    expect(pickup?.pickup_spots?.[0]).toMatchObject({ id: 'Tienda Centro', notes: 'Toca el timbre' })
  })
})

/**
 * Arranged-only delivery · Sprint 2 · S2.2 — regression pinned to the exact hole:
 * service/rental listings were card-payable in production despite
 * OPTION_KEY_BY_METHOD already routing their fulfillment to the coord option,
 * because `onlyCoordinated` only ever looked at the client-supplied
 * `delivery_mode` query param, never `listingType`. This is the canonical fix,
 * shared by checkout-options (via buildDeliveryCatalog) and start-checkout's
 * server-side re-derivation.
 */
describe('isCoordinatedListing · S2.2 regression', () => {
  it('service is coordinated UNCONDITIONALLY — even with the arranged_only flag OFF', () => {
    expect(isCoordinatedListing({ listingType: 'service', deliveryMode: 'carrier', arrangedOnlyEnabled: false, isDigital: false })).toBe(true)
  })

  it('rental is coordinated UNCONDITIONALLY — even with the arranged_only flag OFF', () => {
    expect(isCoordinatedListing({ listingType: 'rental', deliveryMode: 'carrier', arrangedOnlyEnabled: false, isDigital: false })).toBe(true)
  })

  it('a plain product with deliveryMode carrier is never coordinated', () => {
    expect(isCoordinatedListing({ listingType: 'product', deliveryMode: 'carrier', arrangedOnlyEnabled: true, isDigital: false })).toBe(false)
  })

  it('a plain product with deliveryMode arranged is coordinated ONLY when the flag is ON (unchanged S1.1 contract)', () => {
    expect(isCoordinatedListing({ listingType: 'product', deliveryMode: 'arranged', arrangedOnlyEnabled: false, isDigital: false })).toBe(false)
    expect(isCoordinatedListing({ listingType: 'product', deliveryMode: 'arranged', arrangedOnlyEnabled: true, isDigital: false })).toBe(true)
  })

  it('digital listings are never coordinated, even service/rental-typed or arranged', () => {
    expect(isCoordinatedListing({ listingType: 'service', deliveryMode: 'carrier', arrangedOnlyEnabled: false, isDigital: true })).toBe(false)
    expect(isCoordinatedListing({ listingType: 'product', deliveryMode: 'arranged', arrangedOnlyEnabled: true, isDigital: true })).toBe(false)
  })
})

describe('buildDeliveryCatalog · S2.2 — onlyCoordinated for service/rental is unconditional on the flag', () => {
  it('service listing: onlyCoordinated true even with arrangedOnlyEnabled false', () => {
    const { onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, listingType: 'service', deliveryMode: 'carrier', arrangedOnlyEnabled: false,
    })
    expect(onlyCoordinated).toBe(true)
  })

  it('rental listing: onlyCoordinated true even with arrangedOnlyEnabled false', () => {
    const { onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, listingType: 'rental', deliveryMode: 'carrier', arrangedOnlyEnabled: false,
    })
    expect(onlyCoordinated).toBe(true)
  })
})

/**
 * Arranged-only delivery · Sprint 1 · S1.2 (product-write path rule, shared by
 * createSellerProduct + updateSellerProduct).
 */
describe('resolveDeliveryModeForWrite', () => {
  it('defaults product listings to carrier when nothing is requested', () => {
    expect(resolveDeliveryModeForWrite({ listingType: 'product', requested: undefined })).toEqual({ ok: true, value: 'carrier' })
  })

  it('honors an explicit carrier/arranged request for a product listing', () => {
    expect(resolveDeliveryModeForWrite({ listingType: 'product', requested: 'arranged' })).toEqual({ ok: true, value: 'arranged' })
    expect(resolveDeliveryModeForWrite({ listingType: 'product', requested: 'carrier' })).toEqual({ ok: true, value: 'carrier' })
  })

  it('null resets a product listing to the carrier default', () => {
    expect(resolveDeliveryModeForWrite({ listingType: 'product', requested: null })).toEqual({ ok: true, value: 'carrier' })
  })

  it('rejects an invalid value', () => {
    const result = resolveDeliveryModeForWrite({ listingType: 'product', requested: 'coordinated' as any })
    expect(result.ok).toBe(false)
  })

  it('forces service listings to arranged regardless of what was requested', () => {
    expect(resolveDeliveryModeForWrite({ listingType: 'service', requested: 'carrier' })).toEqual({ ok: true, value: 'arranged' })
    expect(resolveDeliveryModeForWrite({ listingType: 'service', requested: undefined })).toEqual({ ok: true, value: 'arranged' })
  })

  it('forces rental listings to arranged regardless of what was requested', () => {
    expect(resolveDeliveryModeForWrite({ listingType: 'rental', requested: 'carrier' })).toEqual({ ok: true, value: 'arranged' })
    expect(resolveDeliveryModeForWrite({ listingType: 'rental', requested: null })).toEqual({ ok: true, value: 'arranged' })
  })
})

describe('isCoordinatedListing · an event ticket is not a coordinated sale (coordinated-sales-readiness D1, 2026-11-16)', () => {
  const base = { deliveryMode: 'carrier' as const, arrangedOnlyEnabled: true, isDigital: false }
  it('🚨 a paid Evento (a service with an event block) takes any rail — it used to refuse every card ticket', () => {
    expect(isCoordinatedListing({ ...base, listingType: 'service', isEvent: true })).toBe(false)
  })
  it('the negation: a plain service and a rental stay manual-only, event flag or not', () => {
    expect(isCoordinatedListing({ ...base, listingType: 'service', isEvent: false })).toBe(true)
    expect(isCoordinatedListing({ ...base, listingType: 'service' })).toBe(true)
    expect(isCoordinatedListing({ ...base, listingType: 'rental', isEvent: true })).toBe(true)
  })
  it('an arranged product stays coordinated even if it somehow carries an event block', () => {
    expect(isCoordinatedListing({ ...base, listingType: 'product', deliveryMode: 'arranged', isEvent: true })).toBe(true)
  })
  it('the catalog stops filtering to manual rails for an event', () => {
    const shared = { isDigital: false, deliveryMode: 'carrier' as const, arrangedOnlyEnabled: true, localPickup: false, pickupSpots: [], hasLiveShipping: false }
    expect(buildDeliveryCatalog({ ...shared, listingType: 'service', isEvent: true }).onlyCoordinated).toBe(false)
    expect(buildDeliveryCatalog({ ...shared, listingType: 'service' }).onlyCoordinated).toBe(true)
  })
})

describe('start-checkout derives "is an event" from the PRODUCT, never the client (coordinated-sales-readiness D1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const route = readFileSync(join(__dirname, '../../carts/[id]/start-checkout/route.ts'), 'utf8')
  it('the COORD guard and the fulfillment guard both read isSeatedEvent(product)', () => {
    expect(route).toContain('const isEvent = isSeatedEvent(p)')
    expect(route).toContain('arrangedOnlyEnabled: arrangedOnlyEnabledForGuard, isDigital: isDigitalItem, isEvent })')
    expect(route).toContain('isEvent: isSeatedEvent(p),')
    expect(route).toContain("fields: ['id', 'metadata', 'type.value', 'variants.manage_inventory', 'variants.allow_backorder'],")
    expect(route).not.toMatch(/req\.body[^\n]*is_event|body\.is_event/)
  })
})

describe('isSeatedEvent · a ticket is an event block AND seats (security lens on PR 237)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isSeatedEvent } = require('../inventory') as typeof import('../inventory')
  const seated = [{ manage_inventory: true }]
  it('an event with seats is a ticket', () => {
    expect(isSeatedEvent({ metadata: { attrs: { event_date: '2026-12-01' } }, variants: seated })).toBe(true)
  })
  it('🚨 an event block with NO seat limit is not — card payments could oversell the venue', () => {
    expect(isSeatedEvent({ metadata: { attrs: { venue_name: 'Teatro' } }, variants: [{ manage_inventory: false }] })).toBe(false)
    expect(isSeatedEvent({ metadata: { attrs: { venue_name: 'Teatro' } } })).toBe(false)
  })
  it('🚨 a BACKORDER variant is not capped seats — it could reserve past the venue (security lens, second pass)', () => {
    const ev = { metadata: { attrs: { event_date: '2026-12-01' } } }
    expect(isSeatedEvent({ ...ev, variants: [{ manage_inventory: true, allow_backorder: true }] })).toBe(false)
    expect(isSeatedEvent({ ...ev, variants: [{ manage_inventory: true }, { manage_inventory: false }] })).toBe(false)
    expect(isSeatedEvent({ ...ev, variants: [] })).toBe(false)
  })
  it('seats without an event block is not an event', () => {
    expect(isSeatedEvent({ metadata: { attrs: {} }, variants: seated })).toBe(false)
    expect(isSeatedEvent(null)).toBe(false)
  })
})
