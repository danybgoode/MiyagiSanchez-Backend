import { listingSaleFacts } from '../route'

/**
 * listing-readiness S1.2: the storefront's activation gate reads a draft's type and delivery mode here, because the
 * public listing read cannot see drafts (it failed open on every draft activation).
 */
describe('listingSaleFacts', () => {
  it('returns the type and delivery mode the gate needs', () => {
    expect(listingSaleFacts({ listing_type: 'service', delivery_mode: 'arranged', unit_cost: 5 }))
      .toEqual({ listing_type: 'service', delivery_mode: 'arranged' })
  })
  it('defaults an untyped product to product with no delivery mode', () => {
    expect(listingSaleFacts(null)).toEqual({ listing_type: 'product', delivery_mode: null })
    expect(listingSaleFacts({ delivery_mode: 'teleport' })).toEqual({ listing_type: 'product', delivery_mode: null })
  })
  it('the Medusa product type wins over the metadata key, as on the public listing shape', () => {
    expect(listingSaleFacts({ listing_type: 'product' }, 'service').listing_type).toBe('service')
    expect(listingSaleFacts({ listing_type: 'rental' }, null).listing_type).toBe('rental')
  })
  it('never echoes the rest of the metadata bag', () => {
    expect(Object.keys(listingSaleFacts({ listing_type: 'product', secret: 'x' })).sort()).toEqual(['delivery_mode', 'listing_type'])
  })
})
