/**
 * Event seats (merchant-panel-gaps S1.1, D1/D2). One predicate decides "does this
 * listing carry managed inventory" for create, update and backfill; an event is
 * stockable only with the event block AND a provided quantity.
 */
const writes: Array<{ kind: string; input?: any }> = []

jest.mock('@medusajs/medusa/core-flows', () => ({
  createProductsWorkflow: jest.fn(() => ({
    run: jest.fn(async (input) => {
      writes.push({ kind: 'create-product', input })
      return { result: [{ id: 'prod_ev', variants: [{ id: 'variant_ev' }] }] }
    }),
  })),
  updateProductsWorkflow: jest.fn(() => ({
    run: jest.fn(async (input) => {
      writes.push({ kind: 'publish-product', input })
      return { result: [{ id: 'prod_ev' }] }
    }),
  })),
}))
jest.mock('../../../../lib/flags', () => ({ isEnabled: jest.fn(async () => false) }))
// Keep the REAL predicate + validator; stub only the I/O around them.
jest.mock('../inventory', () => ({
  ...jest.requireActual('../inventory'),
  resolveStockLocationId: jest.fn(async () => 'sloc_mx'),
  provisionVariantInventory: jest.fn(async (_scope, input) => {
    writes.push({ kind: 'provision-inventory', input })
    return { ok: true }
  }),
  setVariantAvailableQuantity: jest.fn(async (_s, variant, locationId, quantity) => {
    writes.push({ kind: 'set-available', input: { variantId: variant.id, locationId, quantity } })
    return { stocked: quantity, reserved: 0 }
  }),
  ensureSalesChannelLocationLink: jest.fn(async (_s, channelId, locationId) => {
    writes.push({ kind: 'link-channel', input: { channelId, locationId } })
  }),
}))
jest.mock('../fulfillment', () => ({ resolveDefaultShippingProfileId: jest.fn(async () => 'sp_default') }))

import { hasEventBlock, isStockableListingType, validateSeatQuantity } from '../inventory'
import { createSellerProduct } from '../seller-product-create'
import { updateSellerProduct } from '../seller-product-update'

const EVENT = { event_date: '2026-12-01', venue_name: 'Teatro' }
const seller = { id: 'sel_mx', slug: 'teatro', metadata: { operating_market: 'mx' } }

function createScope() {
  const service = {
    listSellers: async () => [seller],
    listProductCategories: async () => [],
    listProductTypes: async () => [],
    create: async (input: any) => { writes.push({ kind: 'link-seller', input }) },
  }
  return { resolve: () => service } as any
}

describe('the ONE stock predicate', () => {
  it('product listings are always stockable (unchanged)', () => {
    expect(isStockableListingType('product')).toBe(true)
    expect(isStockableListingType(undefined)).toBe(true)
  })
  it.each(['service', 'digital'])('a %s is stockable only as an event WITH a quantity', (type) => {
    expect(isStockableListingType(type, { attrs: EVENT, quantity: 40 })).toBe(true)
    expect(isStockableListingType(type, { attrs: { venue_name: 'Foro' }, quantity: 0 })).toBe(true)
    expect(isStockableListingType(type, { attrs: EVENT })).toBe(false)
    expect(isStockableListingType(type, { attrs: EVENT, quantity: null })).toBe(false)
    expect(isStockableListingType(type, { attrs: {}, quantity: 40 })).toBe(false)
    expect(isStockableListingType(type, { attrs: { event_date: '  ' }, quantity: 40 })).toBe(false)
    expect(isStockableListingType(type)).toBe(false)
  })
  it('rental and subscription never take seats', () => {
    expect(isStockableListingType('rental', { attrs: EVENT, quantity: 5 })).toBe(false)
    expect(isStockableListingType('subscription', { attrs: EVENT, quantity: 5 })).toBe(false)
  })
  it('hasEventBlock reads a date or a venue', () => {
    expect(hasEventBlock({ event_date: '2026-12-01' })).toBe(true)
    expect(hasEventBlock({ venue_name: 'Foro' })).toBe(true)
    expect(hasEventBlock(null)).toBe(false)
  })
})

describe('validateSeatQuantity — negatives refused, zero allowed (Agotado)', () => {
  it('refuses negative, NaN and non-numbers; allows 0 and positives', () => {
    expect(validateSeatQuantity(-1).ok).toBe(false)
    expect(validateSeatQuantity(Number.NaN).ok).toBe(false)
    expect(validateSeatQuantity('5').ok).toBe(false)
    expect(validateSeatQuantity(0).ok).toBe(true)
    expect(validateSeatQuantity(40).ok).toBe(true)
  })
})

describe('createSellerProduct — an event with seats', () => {
  const OLD_ENV = process.env
  beforeAll(() => {
    process.env = {
      ...OLD_ENV,
      MEDUSA_SALES_CHANNEL_ID: 'sc_mx_marketplace',
      MEDUSA_MX_OPERATING_CHANNEL_ID: 'sc_mx_operating',
      MEDUSA_STOCK_LOCATION_ID: 'sloc_mx',
    }
  })
  afterAll(() => { process.env = OLD_ENV })
  beforeEach(() => { writes.length = 0 })

  it('Cupo 40 creates a MANAGED variant and provisions 40 available', async () => {
    const result = await createSellerProduct(createScope(), seller.id, {
      title: 'Obra', listing_type: 'service', price_cents: 15000, quantity: 40, attrs: EVENT,
    })
    expect(result).toEqual({ ok: true, product_id: 'prod_ev' })
    const productInput = writes.find((w) => w.kind === 'create-product')?.input?.input?.products?.[0]
    expect(productInput.variants[0].manage_inventory).toBe(true)
    expect(writes.find((w) => w.kind === 'provision-inventory')?.input).toMatchObject({
      variantId: 'variant_ev', locationId: 'sloc_mx', quantity: 40,
    })
  })

  it('an event with NO quantity stays unmanaged (unchanged behaviour)', async () => {
    await createSellerProduct(createScope(), seller.id, {
      title: 'Obra', listing_type: 'service', price_cents: 15000, attrs: EVENT,
    })
    const productInput = writes.find((w) => w.kind === 'create-product')?.input?.input?.products?.[0]
    expect(productInput.variants[0].manage_inventory).toBe(false)
    expect(writes.some((w) => w.kind === 'provision-inventory')).toBe(false)
  })

  it('a negative Cupo is refused with a plain message before any write', async () => {
    const result = await createSellerProduct(createScope(), seller.id, {
      title: 'Obra', listing_type: 'service', price_cents: 15000, quantity: -3, attrs: EVENT,
    })
    expect(result).toEqual({ ok: false, status: 422, message: expect.stringMatching(/negativos/) })
    expect(writes).toEqual([])
  })

  it('a plain service with a quantity but no event block still has no stock', async () => {
    await createSellerProduct(createScope(), seller.id, {
      title: 'Clase', listing_type: 'service', price_cents: 15000, quantity: 9,
    })
    const productInput = writes.find((w) => w.kind === 'create-product')?.input?.input?.products?.[0]
    expect(productInput.variants[0].manage_inventory).toBe(false)
  })
})

describe('updateSellerProduct — an event listing first gets seats', () => {
  beforeEach(() => { writes.length = 0 })

  function updateScope(product: any) {
    const productService = {
      updateProducts: async () => {},
      updateProductVariants: async (id: string, patch: any) => { writes.push({ kind: 'update-variant', input: { id, patch } }) },
    }
    const sellerService = { listSellers: async () => [seller] }
    return {
      resolve: (key: string) => {
        if (key === 'remoteQuery') return { graph: async () => ({ data: [product] }) }
        if (key === 'seller') return sellerService
        return productService
      },
    } as any
  }
  const eventProduct = (manage: boolean) => ({
    id: 'prod_ev', metadata: { listing_type: 'service', attrs: EVENT }, type: { value: 'service' },
    variants: [{ id: 'variant_ev', sku: 's', title: 'Default', manage_inventory: manage }],
    sales_channels: [{ id: 'sc_a' }, { id: 'sc_b' }],
  })

  it('flips manage_inventory on, links every channel to the location, sets available', async () => {
    const result = await updateSellerProduct(updateScope(eventProduct(false)), 'prod_ev', { quantity: 25 }, seller as any)
    expect(result.ok).toBe(true)
    expect(writes.find((w) => w.kind === 'update-variant')?.input).toEqual({ id: 'variant_ev', patch: { manage_inventory: true } })
    expect(writes.filter((w) => w.kind === 'link-channel').map((w) => w.input.channelId)).toEqual(['sc_a', 'sc_b'])
    expect(writes.find((w) => w.kind === 'set-available')?.input).toEqual({ variantId: 'variant_ev', locationId: 'sloc_mx', quantity: 25 })
  })

  it('a retry on an already-managed event still links its channels (repairs a partial first attempt)', async () => {
    const result = await updateSellerProduct(updateScope(eventProduct(true)), 'prod_ev', { quantity: 10 }, seller as any)
    expect(result.ok).toBe(true)
    expect(writes.filter((w) => w.kind === 'link-channel').map((w) => w.input.channelId)).toEqual(['sc_a', 'sc_b'])
    expect(writes.some((w) => w.kind === 'update-variant')).toBe(false)
  })

  it('a negative Cupo on update is refused and nothing is written', async () => {
    const result = await updateSellerProduct(updateScope(eventProduct(true)), 'prod_ev', { quantity: -1 }, seller as any)
    expect(result).toMatchObject({ ok: false, status: 422, message: expect.stringMatching(/negativos/) })
    expect(writes.some((w) => w.kind === 'set-available')).toBe(false)
  })

  it('a plain service (no event block) still gets the old 422', async () => {
    const plain = { ...eventProduct(false), metadata: { listing_type: 'service' } }
    const result = await updateSellerProduct(updateScope(plain), 'prod_ev', { quantity: 5 }, seller as any)
    expect(result).toMatchObject({ ok: false, status: 422, message: 'Only physical products can have a stock quantity' })
  })
})
