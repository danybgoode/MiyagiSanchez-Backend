jest.mock('../../../../lib/flags', () => ({
  isEnabled: jest.fn(async () => true),
}))

import { GET } from '../[id]/route'

/**
 * S2.3 route-level: an OUTAGE must never be served as a REFUSAL.
 *
 * The pure decision is specced next door. What is specced HERE is the one thing a
 * pure function cannot express — the route's mapping from a thrown read to an HTTP
 * status. It matters because the two reads have different failure paths: the
 * product read already answered 503, while the seller-ownership read swallowed its
 * exception and fell through to the uniform 404. So a partial outage (product table
 * reachable, seller link table not) reported every owned-shop-only product as
 * "not found" — indistinguishable from a product that genuinely does not exist, on
 * the money path, with nothing in the response to say otherwise.
 *
 * Three states, never two: absent ⇒ refuse (404); unavailable ⇒ 503 so the caller
 * retries. Found by the cross-agent review on PR 130.
 */

const MARKETPLACE = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const OPERATING = 'sc_01KYWNQ0C0PFFM0K0V2EMC24AP'

function fakeRes() {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { res, out }
}

/** A container whose product read succeeds and whose OWNERSHIP read throws. */
function scopeWithOwnershipOutage() {
  return {
    resolve: () => ({
      graph: async (args: any) => {
        const fields: string[] = args.fields ?? []
        if (fields.some((f) => f.startsWith('seller.'))) {
          throw new Error('relation "seller_product" does not exist')
        }
        return {
          data: [{
            id: 'prod_1',
            status: 'published',
            metadata: {},
            sales_channels: [{ id: OPERATING }],
          }],
        }
      },
    }),
  }
}

describe('checkout-admission route — an ownership-read outage is 503, not 404', () => {
  const OLD = process.env
  beforeAll(() => {
    process.env = {
      ...OLD,
      MEDUSA_SALES_CHANNEL_ID: MARKETPLACE,
      MEDUSA_MX_OPERATING_CHANNEL_ID: OPERATING,
    } as any
  })
  afterAll(() => { process.env = OLD })

  it('returns 503 admission_read_failed when the seller-ownership read throws', async () => {
    const { res, out } = fakeRes()
    await GET(
      { params: { id: 'prod_1' }, query: { market: 'mx' }, scope: scopeWithOwnershipOutage() } as any,
      res,
    )
    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ unavailable: true, reason: 'admission_read_failed' })
    // Explicitly NOT the refusal shape — that is the whole point.
    expect(out.body.message).not.toMatch(/not found/i)
  })
})

/**
 * The storefront's checkout page reads a «Solo mi tienda» product through its shop's
 * own channel, and needs the OWNING shop to do it. Medusa owns that edge, so the
 * admission answer carries it (reported live 2026-11-11: such products 404'd at
 * checkout). Echoed only on admission — a refusal stays the uniform 404.
 */
function scopeWithOwner(seller: Record<string, unknown> | null) {
  return {
    resolve: () => ({
      graph: async (args: any) => {
        const fields: string[] = args.fields ?? []
        if (fields.some((f) => f.startsWith('seller.'))) {
          // Like the real graph: only the SELECTED seller fields come back, so a
          // route that stops selecting `seller.slug` cannot pass this spec.
          const selected = fields.filter((f) => f.startsWith('seller.')).map((f) => f.slice('seller.'.length))
          const projected = seller
            ? Object.fromEntries(Object.entries(seller).filter(([k]) => selected.includes(k)))
            : null
          return { data: [{ id: 'prod_1', seller: projected }] }
        }
        return {
          data: [{
            id: 'prod_1',
            status: 'published',
            metadata: {},
            sales_channels: [{ id: OPERATING }],
          }],
        }
      },
    }),
  }
}

describe('checkout-admission route — an admitted product names its owning shop', () => {
  const OLD = process.env
  beforeAll(() => {
    process.env = {
      ...OLD,
      MEDUSA_SALES_CHANNEL_ID: MARKETPLACE,
      MEDUSA_MX_OPERATING_CHANNEL_ID: OPERATING,
    } as any
  })
  afterAll(() => { process.env = OLD })

  const MX_SELLER = {
    id: 'sel_1',
    slug: 'miel-verduras',
    status: 'active',
    metadata: { operating_market: 'mx' },
  }

  it('returns seller.slug with an admission', async () => {
    const { res, out } = fakeRes()
    await GET({ params: { id: 'prod_1' }, query: { market: 'mx' }, scope: scopeWithOwner(MX_SELLER) } as any, res)
    expect(out.status).toBe(200)
    expect(out.body.admitted).toBe(true)
    expect(out.body.seller).toEqual({ slug: 'miel-verduras' })
  })

  it('a refusal never names the owner (uniform 404)', async () => {
    const { res, out } = fakeRes()
    await GET(
      { params: { id: 'prod_1' }, query: { market: 'mx' }, scope: scopeWithOwner({ ...MX_SELLER, status: 'paused' }) } as any,
      res,
    )
    expect(out.status).toBe(404)
    expect(JSON.stringify(out.body)).not.toContain('miel-verduras')
  })
})
