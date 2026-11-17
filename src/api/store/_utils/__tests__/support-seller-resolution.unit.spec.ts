import {
  findSellerById,
  findSellerLinkedToProduct,
  resolveSellerForCheckout,
} from '../support-seller-resolution'
import { sellerRowEnforcement } from '../../../../lib/seller-status'

function sellerServiceWith(sellers: Array<{ id: string }>) {
  return {
    listSellers: jest.fn(async (filters?: Record<string, unknown>) => {
      if (filters?.id) return sellers.filter((seller) => seller.id === filters.id)
      return sellers
    }),
  }
}

// The `.graph` shape the engine really answers with. The previous fake was a legacy
// `remoteQuery(...)` returning `{ data }` — the shape the code expected, not the one the engine
// returns (a bare array) — so the owner lookup passed here while finding nobody live.
function remoteQueryWithLinks(links: Record<string, string[]>) {
  const ownerOf = (productId: string) =>
    Object.entries(links).find(([, ids]) => ids.includes(productId))?.[0] ?? null
  return {
    graph: jest.fn(async (query: { entity: string; filters: { id: string | string[] } }) => {
      if (query.entity === 'product') {
        const ids = ([] as string[]).concat(query.filters.id)
        // A product with no row (unknown id) is simply absent, as from the engine.
        return { data: ids.map((id) => ({ id, seller: ownerOf(id) ? { id: ownerOf(id) } : null })) }
      }
      const sellerId = query.filters.id as string
      return { data: [{ id: sellerId, products: (links[sellerId] ?? []).map((id) => ({ id })) }] }
    }),
  }
}

describe('resolveSellerForCheckout', () => {
  it('uses support product metadata before a stale caller seller id', async () => {
    const sellerService = sellerServiceWith([{ id: 'seller_support' }, { id: 'seller_stale' }])
    const remoteQuery = remoteQueryWithLinks({})

    await expect(resolveSellerForCheckout({
      sellerService,
      remoteQuery,
      productId: 'prod_support',
      bodySellerId: 'seller_stale',
      productMetadata: { support_seller_id: 'seller_support' },
      isSupportCheckout: true,
    })).resolves.toMatchObject({ id: 'seller_support' })
  })

  it('falls back to the Medusa product link when caller seller id is from the wrong domain', async () => {
    const sellerService = sellerServiceWith([{ id: 'seller_real' }])
    const remoteQuery = remoteQueryWithLinks({ seller_real: ['prod_support'] })

    await expect(resolveSellerForCheckout({
      sellerService,
      remoteQuery,
      productId: 'prod_support',
      bodySellerId: 'supabase_shop_id',
      productMetadata: {},
      isSupportCheckout: true,
    })).resolves.toMatchObject({ id: 'seller_real' })
  })

  it('keeps the fast path for a valid Medusa seller id', async () => {
    const sellerService = sellerServiceWith([{ id: 'seller_fast' }])
    const remoteQuery = remoteQueryWithLinks({})

    await expect(resolveSellerForCheckout({
      sellerService,
      remoteQuery,
      productId: 'prod_ordinary',
      bodySellerId: 'seller_fast',
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toMatchObject({ id: 'seller_fast' })
  })
})

describe('a caller-named seller is a hint, never who gets paid', () => {
  const sellers = [{ id: 'seller_owner' }, { id: 'seller_stranger' }]

  it('keeps the named seller when it owns every product in the cart', async () => {
    await expect(resolveSellerForCheckout({
      sellerService: sellerServiceWith(sellers),
      remoteQuery: remoteQueryWithLinks({ seller_owner: ['prod_a', 'prod_b'] }),
      productId: 'prod_a',
      cartProductIds: ['prod_a', 'prod_b'],
      bodySellerId: 'seller_owner',
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toMatchObject({ id: 'seller_owner' })
  })

  it('pays the real owner when another shop is named for its product', async () => {
    await expect(resolveSellerForCheckout({
      sellerService: sellerServiceWith(sellers),
      remoteQuery: remoteQueryWithLinks({ seller_owner: ['prod_a'], seller_stranger: ['prod_own'] }),
      productId: 'prod_a',
      cartProductIds: ['prod_a'],
      bodySellerId: 'seller_stranger',
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toMatchObject({ id: 'seller_owner' })
  })

  it('a named shop owning only ONE of the cart\'s products is not kept, and nobody is paid', async () => {
    // Paying the first line's owner would let the caller choose by ordering lines (codex + pr-reviewer, PR 238).
    await expect(resolveSellerForCheckout({
      sellerService: sellerServiceWith(sellers),
      remoteQuery: remoteQueryWithLinks({ seller_owner: ['prod_a'], seller_stranger: ['prod_own'] }),
      productId: 'prod_own',
      cartProductIds: ['prod_own', 'prod_a'],
      bodySellerId: 'seller_stranger',
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toBeNull()
  })

  it('a cart linked to two shops resolves to nobody (start-checkout refuses it)', async () => {
    await expect(resolveSellerForCheckout({
      sellerService: sellerServiceWith(sellers),
      remoteQuery: remoteQueryWithLinks({ seller_owner: ['prod_a'], seller_stranger: ['prod_own'] }),
      productId: 'prod_own',
      cartProductIds: ['prod_own', 'prod_a'],
      bodySellerId: undefined,
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toBeNull()
  })

  it('an unlinked product adds no constraint: the named shop is kept (today\'s behaviour)', async () => {
    await expect(resolveSellerForCheckout({
      sellerService: sellerServiceWith(sellers),
      remoteQuery: remoteQueryWithLinks({}),
      productId: 'prod_orphan',
      cartProductIds: ['prod_orphan'],
      bodySellerId: 'seller_stranger',
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toMatchObject({ id: 'seller_stranger' })
  })

  it('finds the owner when no seller is named', async () => {
    await expect(resolveSellerForCheckout({
      sellerService: sellerServiceWith(sellers),
      remoteQuery: remoteQueryWithLinks({ seller_owner: ['prod_a'] }),
      productId: 'prod_a',
      productMetadata: {},
      isSupportCheckout: false,
    })).resolves.toMatchObject({ id: 'seller_owner' })
  })
})

describe('the checkout seller projection must carry `status`', () => {
  /**
   * tenant-lifecycle-admin · D2b. `start-checkout` now refuses a non-active seller
   * using the STRICT reader, where an absent `status` is a refusal. That is correct
   * for an enforcement seam — and it means that if either resolution helper ever
   * narrows its projection with a `select:`, every checkout would 409.
   *
   * Named by a cross-family reviewer as the one thing its bounded diff could not
   * verify, and it is the right thing to be nervous about: the blast radius is every
   * sale on the platform. Verified empirically at the time (the internal status route
   * uses the identical `listSellers({ id }, { take: 1 })` shape and returns
   * `status: "active"` for real production sellers), and pinned here so the next edit
   * cannot quietly break it.
   */
  it('neither helper narrows the seller projection', async () => {
    const configs: Array<Record<string, unknown> | undefined> = []
    const sellerService = {
      listSellers: async (_filters?: Record<string, unknown>, config?: Record<string, unknown>) => {
        configs.push(config)
        return [{ id: 'sel_1', status: 'active' }]
      },
    }

    await findSellerById(sellerService, 'sel_1')
    await findSellerLinkedToProduct(
      sellerService,
      { graph: async () => ({ data: [] }) },
      'prod_1',
    )

    expect(configs.length).toBeGreaterThan(0)
    for (const config of configs) {
      // A `select` here would drop `status` and 409 every checkout.
      expect(config?.select).toBeUndefined()
      expect(config?.fields).toBeUndefined()
    }
  })

  it('a full row from those helpers carries a status the strict reader accepts', () => {
    expect(sellerRowEnforcement({ status: 'active' } as { status?: unknown }))
      .toEqual({ present: true, admits: true })
  })
})
