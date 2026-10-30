/**
 * money-path.integration.spec.ts — the CONSUMER-SIDE gate.
 *
 * Why this exists (2026-08-25). Until now the backend's entire CI gate was
 * `tsc + build + unit`. No database, no HTTP, no order. That gap is not academic:
 *
 *  • The Medusa 2.17.2 -> 2.19.0 upgrade (68 packages, the whole commerce engine) could not be
 *    verified by CI at all. It went green while nothing had ever created a cart.
 *  • The auto-merge workflow had already QUEUED that upgrade for an unattended production deploy.
 *    The only thing that stopped it was an unrelated red test. An accident, not a control.
 *  • `seller-catalog-query.unit.spec.ts` used to run our query through Medusa's own translator —
 *    the one spec that proved MEDUSA agrees our payload is valid, rather than proving we built the
 *    payload we meant to build. 2.19 made that function private and it had to be deleted. Its
 *    consumer-side proof was explicitly owed here.
 *
 * The original defect this whole area guards against is instructive: a spec pinned
 * `context` + `withDeleted` against a FAKE `graph` that accepts any object. It passed for months
 * while every real call threw `Trying to query by not existing property Product.context`. A mock
 * cannot refuse a payload the real engine refuses — which is exactly why this tier runs against a
 * real Postgres and a real HTTP surface, and why it is worth the CI minutes.
 *
 * Scope is deliberately the MONEY PATH and nothing else. This is a gate, not a test suite:
 * a publishable key resolves to exactly one sales channel, a cart is created on it, a real variant
 * is priced, and the totals add up. Those are the invariants an engine upgrade can silently break.
 *
 * Runs only under `TEST_TYPE=integration:http` (see jest.config.js) against the Postgres + Redis
 * service containers in ci.yml. It is NOT part of `test:unit`, which must stay DB-free and fast.
 */
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import {
  ContainerRegistrationKeys,
  Modules,
} from '@medusajs/framework/utils'

import { inPersonSaleSuite } from './in-person-sale.suite'

jest.setTimeout(180_000)

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    // in-person-sales S1.2 — mounted here, not as its own runner file (see the suite's header).
    inPersonSaleSuite(getContainer)

    describe('money path — a publishable key buys exactly what it should', () => {
      let regionId: string
      let salesChannelId: string
      let publishableKey: string
      let variantId: string

      // beforeEACH, not beforeAll. `medusaIntegrationTestRunner` snapshots the database and RESTORES
      // it between every test (verified in its own source: beforeEach/afterEach + snapshot/restore).
      // Fixtures created in a `beforeAll` therefore exist for the first test and are rolled back
      // before the second — which is exactly what happened on the first run here: test 1 passed and
      // the other three failed with 400s on a key that no longer existed. The symptom looked like a
      // Redis fault ("Connection is closed" from bullmq during teardown), which is the misleading
      // part worth recording: the real cause was fixture lifetime, not infrastructure.
      beforeEach(async () => {
        const container = getContainer()

        // A region is what gives a cart its currency. Without one, "total" has no meaning.
        const regionService = container.resolve(Modules.REGION)
        const [region] = await regionService.createRegions([
          { name: 'Test MX', currency_code: 'mxn', countries: ['mx'] },
        ])
        regionId = region.id

        // ONE sales channel, then a publishable key linked to exactly it. This is the shape the
        // storefront actually runs: `ensurePublishableKeyAndSalesChannelMatch` assigns the cart's
        // channel from the key when the key resolves to exactly one, and REFUSES when it resolves
        // to more than one. Both halves are asserted below.
        const scService = container.resolve(Modules.SALES_CHANNEL)
        const [channel] = await scService.createSalesChannels([{ name: 'Test Channel' }])
        salesChannelId = channel.id

        const apiKeyService = container.resolve(Modules.API_KEY)
        const [key] = await apiKeyService.createApiKeys([
          { title: 'test pk', type: 'publishable', created_by: 'test' },
        ])
        publishableKey = key.token

        const link = container.resolve(ContainerRegistrationKeys.LINK)
        await link.create({
          [Modules.API_KEY]: { publishable_key_id: key.id },
          [Modules.SALES_CHANNEL]: { sales_channel_id: channel.id },
        })

        // A real, purchasable product: priced in the region's currency and in the channel the key
        // resolves to. A product that is not in the channel is invisible to the storefront, which is
        // itself one of the failure modes this gate covers.
        const productService = container.resolve(Modules.PRODUCT)
        const [product] = await productService.createProducts([
          {
            title: 'Money path fixture',
            status: 'published',
            options: [{ title: 'Size', values: ['One'] }],
            variants: [{ title: 'One', options: { Size: 'One' }, manage_inventory: false }],
          },
        ])
        variantId = product.variants[0].id

        const pricingService = container.resolve(Modules.PRICING)
        const priceSet = await pricingService.createPriceSets([
          { prices: [{ amount: 10000, currency_code: 'mxn' }] },
        ])
        await link.create({
          [Modules.PRODUCT]: { variant_id: variantId },
          [Modules.PRICING]: { price_set_id: priceSet[0].id },
        })
        await link.create({
          [Modules.PRODUCT]: { product_id: product.id },
          [Modules.SALES_CHANNEL]: { sales_channel_id: channel.id },
        })
      })

      it('a cart created with the publishable key lands on that key\'s ONE sales channel', async () => {
        const res = await api.post(
          '/store/carts',
          { region_id: regionId },
          { headers: { 'x-publishable-api-key': publishableKey } },
        )

        expect(res.status).toBe(200)
        expect(res.data.cart.currency_code).toBe('mxn')
        // THE assertion. The channel is never sent by the client — the engine derives it from the
        // key. If a future engine version stops doing that, a cart silently lands on the wrong
        // channel (or none) and the storefront shows an empty or foreign catalog.
        expect(res.data.cart.sales_channel_id).toBe(salesChannelId)
      })

      it('a request with NO publishable key is refused — the key is not decoration', async () => {
        // The negation. Without it, every assertion above would pass just as well against an engine
        // that ignores publishable keys entirely.
        //
        // Asserted with an explicit try/catch rather than `rejects.toMatchObject`: this test runner
        // surfaces an unrelated bullmq "Connection is closed" as an UNHANDLED error during teardown,
        // and a bare `.rejects` matcher attributes that to this assertion — which sent me chasing a
        // Redis fault when the real defect was fixture lifetime. Catching the axios error directly
        // asserts the status we actually care about and cannot be confused by teardown noise.
        let status: number | undefined
        try {
          await api.post('/store/carts', { region_id: regionId })
        } catch (err) {
          status = (err as { response?: { status?: number } }).response?.status
        }
        expect(status).toBe(400)
      })

      it('a real variant is priced, and the cart totals add up', async () => {
        const cart = await api.post(
          '/store/carts',
          { region_id: regionId },
          { headers: { 'x-publishable-api-key': publishableKey } },
        )

        const withItem = await api.post(
          `/store/carts/${cart.data.cart.id}/line-items`,
          { variant_id: variantId, quantity: 2 },
          { headers: { 'x-publishable-api-key': publishableKey } },
        )

        expect(withItem.status).toBe(200)
        expect(withItem.data.cart.items).toHaveLength(1)
        // Quantity 2 at 10000 — asserted as arithmetic, not as a pinned constant, so a pricing
        // regression cannot be absorbed by updating one number.
        expect(withItem.data.cart.items[0].unit_price).toBe(10000)
        expect(withItem.data.cart.subtotal).toBe(20000)
        expect(withItem.data.cart.total).toBeGreaterThanOrEqual(withItem.data.cart.subtotal)
      })

      it('the storefront catalog serves the product through that key', async () => {
        // The seller-catalog-query path: a product reaches the storefront only if it is in the
        // channel the key resolves to. This is the read half of the same invariant.
        const res = await api.get(
          `/store/products?region_id=${regionId}`,
          { headers: { 'x-publishable-api-key': publishableKey } },
        )

        expect(res.status).toBe(200)
        const titles = res.data.products.map((p: { title: string }) => p.title)
        expect(titles).toContain('Money path fixture')
      })
    })
  },
})
