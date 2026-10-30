/**
 * in-person-sale.suite.ts — the counter's money path against a REAL
 * Postgres (in-person-sales epic, S1.2 · D2–D5).
 *
 * The pure claim decision is unit-tested in `src/lib/__tests__/in-person-sale.unit.spec.ts`.
 * What only a real database can prove is here: that the unique index really makes a
 * concurrent replay ONE order, that the cart path really reserves stock and captures
 * the cash, and that another seller's variant never reaches a cart.
 *
 * It calls `recordInPersonSale` — the same core the Clerk route calls — because the
 * route's only extra step is resolving the seller from a Clerk JWT, which this runner
 * has no issuer for. The seller id passed here is what that resolution returns.
 */
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createProductsWorkflow, createInventoryLevelsWorkflow, createRegionsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../src/modules/seller'
import { IN_PERSON_MODULE } from '../../src/modules/in-person'
import { setupFulfillmentInfrastructure } from '../../src/api/store/_utils/fulfillment'
import { recordInPersonSale } from '../../src/lib/in-person-sale-apply'
import { validateInPersonSale } from '../../src/lib/in-person-sale'
import { getProductAvailableQuantity } from '../../src/api/store/_utils/inventory'


const uuid = () => crypto.randomUUID()

/**
 * A SUITE, not a spec file. It is mounted inside `money-path.integration.spec.ts`'s one
 * `medusaIntegrationTestRunner`: two runner files in the same `--runInBand` jest process
 * broke the money-path suite with "Loaders for module Stock_location failed: Method
 * Map.prototype.set called on incompatible receiver" (verifier, PR #214). One runner,
 * one app boot, both suites.
 */
export function inPersonSaleSuite(getContainer: () => any) {
    describe('in-person cash sale — one real order, exactly once', () => {
      let sellerId: string
      let otherSellerId: string
      let productId: string
      let variantId: string
      let otherVariantId: string
      let channelId: string

      async function makeProduct(container: any, sellerKey: string, title: string, locationId: string, profileId: string) {
        const { result } = await createProductsWorkflow(container).run({
          input: {
            products: [{
              title,
              status: 'published',
              shipping_profile_id: profileId,
              sales_channels: [{ id: channelId }],
              options: [{ title: 'Talla', values: ['Única'] }],
              variants: [{
                title: 'Única',
                options: { Talla: 'Única' },
                manage_inventory: true,
                prices: [{ amount: 15000, currency_code: 'mxn' }],
              }],
            }],
          },
        })
        const product = result[0]
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: 'variant',
          fields: ['id', 'inventory_items.inventory_item_id'],
          filters: { id: product.variants[0].id },
        })
        await createInventoryLevelsWorkflow(container).run({
          input: {
            inventory_levels: [{
              inventory_item_id: (data[0] as any).inventory_items[0].inventory_item_id,
              location_id: locationId,
              stocked_quantity: 5,
            }],
          },
        })
        const link = container.resolve(ContainerRegistrationKeys.LINK)
        await link.create({
          [SELLER_MODULE]: { seller_id: sellerKey },
          [Modules.PRODUCT]: { product_id: product.id },
        })
        return product
      }

      beforeEach(async () => {
        const container = getContainer()
        // Through the WORKFLOW: `payment_providers` is a region↔provider LINK the workflow
        // writes; the module's createRegions silently ignores it. The provider must be
        // enabled in the region or completeCartWorkflow refuses the session (as live).
        const { result: [region] } = await createRegionsWorkflow(container).run({
          input: { regions: [{ name: 'México', currency_code: 'mxn', countries: ['mx'], payment_providers: ['pp_cash_cash'] }] },
        })
        const [channel] = await container.resolve(Modules.SALES_CHANNEL).createSalesChannels([{ name: 'MX operating' }])
        channelId = channel.id
        const [location] = await container.resolve(Modules.STOCK_LOCATION).createStockLocations([{ name: 'MX' }])
        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.SALES_CHANNEL]: { sales_channel_id: channel.id },
          [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
        })
        // D1 resolves the channel and region from the market env, exactly as in production.
        process.env.MEDUSA_MXN_REGION_ID = region.id
        process.env.MEDUSA_MX_OPERATING_CHANNEL_ID = channel.id
        process.env.MEDUSA_STOCK_LOCATION_ID = location.id

        await setupFulfillmentInfrastructure(container as any)
        const [profile] = await container.resolve(Modules.FULFILLMENT).listShippingProfiles({ type: 'default' })

        const sellers: any = container.resolve(SELLER_MODULE)
        const [mine, theirs] = await sellers.createSellers([
          { slug: 'puesto-de-ana', name: 'Puesto de Ana', clerk_user_id: 'user_ana', metadata: { operating_market: 'mx' } },
          { slug: 'otra-tienda', name: 'Otra tienda', clerk_user_id: 'user_otra', metadata: { operating_market: 'mx' } },
        ])
        sellerId = mine.id
        otherSellerId = theirs.id

        const product = await makeProduct(container, sellerId, 'Taza de barro', location.id, profile.id)
        productId = product.id
        variantId = product.variants[0].id
        const other = await makeProduct(container, otherSellerId, 'Ajena', location.id, profile.id)
        otherVariantId = other.variants[0].id
      })

      const sale = (over: Record<string, unknown> = {}) => {
        const r = validateInPersonSale({ client_id: uuid(), kind: 'cash', lines: [{ variant_id: variantId, quantity: 2 }], tendered_cents: 50000, ...over })
        if (!r.ok) throw new Error(r.code)
        return r.sale
      }

      it('records one order on the operating channel, cash captured, stock reserved, change right', async () => {
        const container = getContainer()
        const before = await getProductAvailableQuantity(container as any, productId)

        const r = await recordInPersonSale(container as any, sellerId, sale())
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
        expect(r.status).toBe(201)
        expect(r.body.total_cents).toBe(30000)
        expect(r.body.change_cents).toBe(20000)
        expect(r.body.replayed).toBe(false)

        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: 'order',
          fields: ['id', 'sales_channel_id', 'customer.has_account', 'customer.metadata', 'metadata', 'payment_collections.payments.captured_at'],
          filters: { id: r.body.order_id },
        })
        const order = data[0] as any
        expect(order.sales_channel_id).toBe(channelId)
        // D6 (as built): Medusa's cart creates a GUEST customer from the email, exactly as
        // every guest checkout does. What must never exist is an account or a Clerk link.
        expect(order.customer?.has_account ?? false).toBe(false)
        expect(order.customer?.metadata?.clerk_user_id ?? null).toBeNull()
        expect(order.metadata.source).toBe('in_person')
        expect(order.metadata.payment_method).toBe('cash')
        expect(order.metadata.payment_received).toBe(true)
        expect(order.payment_collections[0].payments[0].captured_at).toBeTruthy()

        expect(await getProductAvailableQuantity(container as any, productId)).toBe((before ?? 0) - 2)
      })

      it('a replay of the same client_id returns the SAME order and reserves nothing more', async () => {
        const container = getContainer()
        const s = sale()
        const first = await recordInPersonSale(container as any, sellerId, s)
        const again = await recordInPersonSale(container as any, sellerId, { ...s, tendered_cents: 30000 })
        if (!first.ok || !again.ok) throw new Error('expected both to succeed')
        expect(again.body.order_id).toBe(first.body.order_id)
        expect(again.body.replayed).toBe(true)
        expect(again.status).toBe(200)
        // The change of the captured sale, not of this retry's amount.
        expect(again.body.change_cents).toBe(first.body.change_cents)
        expect(await getProductAvailableQuantity(container as any, productId)).toBe(3)
      })

      it('two CONCURRENT calls with one client_id make exactly one order', async () => {
        const container = getContainer()
        const s = sale()
        const results = await Promise.all([
          recordInPersonSale(container as any, sellerId, s),
          recordInPersonSale(container as any, sellerId, s),
        ])
        const created = results.filter((r) => r.ok && r.status === 201)
        // The loser either sees the in-flight claim (409 IN_PROGRESS) or, if the winner
        // finished first, a replay of the same order. Never a second order.
        expect(created).toHaveLength(1)
        for (const r of results) {
          if (r.ok) expect(r.body.order_id).toBe((created[0] as any).body.order_id)
          else expect(r.code).toBe('IN_PROGRESS')
        }
        const claims = await (container.resolve(IN_PERSON_MODULE) as any).listInPersonSales({ seller_id: sellerId, client_id: s.client_id })
        expect(claims).toHaveLength(1)
        expect(await getProductAvailableQuantity(container as any, productId)).toBe(3)
      })

      it('two retries that both find ONE stale claim make exactly one order (cross-review #214)', async () => {
        const container = getContainer()
        const s = sale()
        // A claim whose owner died before building a cart: stale, no cart recorded.
        await (container.resolve(IN_PERSON_MODULE) as any).createInPersonSales({
          seller_id: sellerId,
          client_id: s.client_id,
          kind: 'cash',
          status: 'claimed',
          payload_hash: require('../../src/lib/in-person-sale').inPersonPayloadHash(s),
          claimed_at: new Date(0),
          claim_token: 'dead-owner',
        })
        const results = await Promise.all([
          recordInPersonSale(container as any, sellerId, s),
          recordInPersonSale(container as any, sellerId, s),
        ])
        const succeeded = results.filter((r) => r.ok)
        expect(succeeded).toHaveLength(1)
        for (const r of results) if (!r.ok) expect(r.code).toBe('IN_PROGRESS')
        expect(await getProductAvailableQuantity(container as any, productId)).toBe(3)
      })

      it("a typed receipt email never attaches the order to that buyer's account (security lens #214)", async () => {
        const container = getContainer()
        const [registered] = await (container.resolve(Modules.CUSTOMER) as any).createCustomers([
          { email: 'compradora@ejemplo.mx', has_account: true, metadata: { clerk_user_id: 'user_compradora' } },
        ])
        const r = await recordInPersonSale(container as any, sellerId, sale({ buyer_email: 'compradora@ejemplo.mx' }))
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', fields: ['id', 'email', 'customer_id', 'metadata'], filters: { id: r.body.order_id },
        })
        const order = data[0] as any
        expect(order.customer_id).not.toBe(registered.id)
        expect(order.email).toBe('mostrador@sin-correo.miyagisanchez.com')
        expect(order.metadata.in_person.receipt_email).toBe('compradora@ejemplo.mx')
      })

      it('the same client_id with a DIFFERENT sale is refused, not answered with the first order', async () => {
        const container = getContainer()
        const s = sale()
        await recordInPersonSale(container as any, sellerId, s)
        const other = await recordInPersonSale(container as any, sellerId, { ...s, lines: [{ variant_id: variantId, quantity: 1 }] })
        expect(!other.ok && other.code).toBe('CLIENT_ID_REUSED')
      })

      it("another seller's variant is refused before any claim or cart", async () => {
        const container = getContainer()
        const s = sale({ lines: [{ variant_id: variantId, quantity: 1 }, { variant_id: otherVariantId, quantity: 1 }] })
        const r = await recordInPersonSale(container as any, sellerId, s)
        expect(r.ok).toBe(false)
        expect(!r.ok && r.code).toBe('VARIANT_NOT_OWNED')
        expect(!r.ok && (r.details as any).variant_ids).toEqual([otherVariantId])
        const claims = await (container.resolve(IN_PERSON_MODULE) as any).listInPersonSales({ seller_id: sellerId })
        expect(claims).toHaveLength(0)
      })

      it('short cash is refused before an order exists, and a corrected resend completes', async () => {
        const container = getContainer()
        const s = sale({ tendered_cents: 20000 })
        const short = await recordInPersonSale(container as any, sellerId, s)
        expect(!short.ok && short.code).toBe('TENDERED_SHORT')
        const fixed = await recordInPersonSale(container as any, sellerId, { ...s, tendered_cents: 30000 })
        if (!fixed.ok) throw new Error(`${fixed.code}: ${fixed.message}`)
        expect(fixed.body.change_cents).toBe(0)
        // The resend CREATED the order, so it is not a replay (D4).
        expect(fixed.body.replayed).toBe(false)
        expect(fixed.status).toBe(201)
      })

      it('more than the stock on hand is refused online (OUT_OF_STOCK) and the claim is closed', async () => {
        const container = getContainer()
        const s = sale({ lines: [{ variant_id: variantId, quantity: 6 }], tendered_cents: null })
        const r = await recordInPersonSale(container as any, sellerId, s)
        expect(!r.ok && r.code).toBe('OUT_OF_STOCK')
        const again = await recordInPersonSale(container as any, sellerId, s)
        expect(!again.ok && again.code).toBe('SALE_CLOSED')
      })
    })
}
