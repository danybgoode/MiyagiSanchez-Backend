import { listingSaleFacts } from '../route'

/**
 * listing-readiness S1.2: the storefront's activation gate reads a draft's type and delivery mode here, because the
 * public listing read cannot see drafts (it failed open on every draft activation).
 */
describe('listingSaleFacts', () => {
  it('returns the type and delivery mode the gate needs', () => {
    expect(listingSaleFacts({ listing_type: 'service', delivery_mode: 'arranged', unit_cost: 5 }))
      .toEqual({ listing_type: 'service', delivery_mode: 'arranged', is_event: false, priced: false })
  })
  it('defaults an untyped product to product with no delivery mode', () => {
    expect(listingSaleFacts(null)).toEqual({ listing_type: 'product', delivery_mode: null, is_event: false, priced: false })
    expect(listingSaleFacts({ delivery_mode: 'teleport' })).toEqual({ listing_type: 'product', delivery_mode: null, is_event: false, priced: false })
  })
  it('the Medusa product type wins over the metadata key, as on the public listing shape', () => {
    expect(listingSaleFacts({ listing_type: 'product' }, 'service').listing_type).toBe('service')
    expect(listingSaleFacts({ listing_type: 'rental' }, null).listing_type).toBe('rental')
  })
  it('never echoes the rest of the metadata bag', () => {
    expect(Object.keys(listingSaleFacts({ listing_type: 'product', secret: 'x' })).sort()).toEqual(['delivery_mode', 'is_event', 'listing_type', 'priced'])
  })
})

describe('listingSaleFacts · event + priced (coordinated-sales-readiness S1.2)', () => {
  it('a SEATED event (event block + a seat-managed variant) is an event; no seats is not', () => {
    const seats = [{ manage_inventory: true, prices: [] }]
    expect(listingSaleFacts({ attrs: { event_date: '2026-12-01' } }, null, seats).is_event).toBe(true)
    expect(listingSaleFacts({ attrs: { venue_name: 'Teatro' } }, null, seats).is_event).toBe(true)
    expect(listingSaleFacts({ attrs: { event_date: '2026-12-01' } }).is_event).toBe(false)
    expect(listingSaleFacts({ attrs: { event_date: '  ' } }, null, seats).is_event).toBe(false)
  })
  it('priced = a positive amount on some variant; null, 0 and missing are not', () => {
    expect(listingSaleFacts({}, null, [{ prices: [{ amount: 25000 }] }]).priced).toBe(true)
    expect(listingSaleFacts({}, null, [{ prices: [{ amount: 0 }] }]).priced).toBe(false)
    expect(listingSaleFacts({}, null, [{ prices: [] }]).priced).toBe(false)
    expect(listingSaleFacts({}, null, undefined).priced).toBe(false)
  })
})
