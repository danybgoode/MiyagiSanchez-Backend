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
import { getInPersonSaleStatus, cancelInPersonSale } from '../../src/lib/in-person-sale-status'
import { createPaymentLink, cancelPaymentLink } from '../../src/lib/payment-link-apply'
import { buildPaymentLinkCart, holdSingleUseLink, publicPaymentLink, recordLinkOrder } from '../../src/lib/payment-link-cart'
import { completeCartWorkflow, createPaymentCollectionForCartWorkflow } from '@medusajs/medusa/core-flows'


const uuid = () => crypto.randomUUID()

/**
 * A SUITE, not a spec file. It is mounted inside `money-path.integration.spec.ts`'s one
 * `medusaIntegrationTestRunner`: two runner files in the same `--runInBand` jest process
 * broke the money-path suite with "Loaders for module Stock_location failed: Method
 * Map.prototype.set called on incompatible receiver" (verifier, PR #214). One runner,
 * one app boot, both suites.
 */
export function inPersonSaleSuite(getContainer: () => any, api: any) {
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
          input: { regions: [{ name: 'México', currency_code: 'mxn', countries: ['mx'], payment_providers: ['pp_cash_cash', 'pp_manual_manual'] }] },
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
        // Product creation (the payment-link «Cobro libre» product) also attaches the MX
        // marketplace channel and fails closed without it — as production is configured.
        const [marketplace] = await container.resolve(Modules.SALES_CHANNEL).createSalesChannels([{ name: 'MX marketplace' }])
        process.env.MEDUSA_SALES_CHANNEL_ID = marketplace.id
        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.SALES_CHANNEL]: { sales_channel_id: marketplace.id },
          [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
        })
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

      // RAW available (stocked − reserved), never clamped — getProductAvailableQuantity
      // floors at 0 and would hide a negative level (verifier, PR 220).
      async function stockedOf(container: any, vId: string): Promise<number> {
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'variant',
          fields: ['inventory_items.inventory.location_levels.stocked_quantity', 'inventory_items.inventory.location_levels.reserved_quantity'],
          filters: { id: vId },
        })
        const lvl = (data[0] as any).inventory_items[0].inventory.location_levels[0]
        return Number(lvl.stocked_quantity) - Number(lvl.reserved_quantity)
      }

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

      it('an OFFLINE cash sale past the stock is recorded anyway and flagged (D12), exactly once', async () => {
        const container = getContainer()
        const s = sale({ lines: [{ variant_id: variantId, quantity: 7 }], tendered_cents: null, offline: true, sold_at: new Date(Date.now() - 3600_000).toISOString() })
        const r = await recordInPersonSale(container as any, sellerId, s)
        if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
        expect(r.status).toBe(201)
        expect(r.body.total_cents).toBe(7 * 15000)
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', fields: ['id', 'metadata'], filters: { id: r.body.order_id },
        })
        const meta = (data[0] as any).metadata
        expect(meta.source).toBe('in_person')
        expect(meta.payment_received).toBe(true)
        expect(meta.in_person.offline).toBe(true)
        expect(meta.oversold.lines).toEqual([{ variant_id: variantId, quantity: 7, decrement: 5, shortfall: 2 }])
        // Stock went to zero, not below — read RAW (getProductAvailableQuantity clamps at 0
        // and would hide a negative level; verifier, PR 220).
        expect(await stockedOf(container, variantId)).toBe(0)
        // A resend from the device's queue returns the same order and takes nothing more.
        const again = await recordInPersonSale(container as any, sellerId, s)
        if (!again.ok) throw new Error(again.code)
        expect(again.body.order_id).toBe(r.body.order_id)
        expect(again.body.replayed).toBe(true)
        expect(await stockedOf(container, variantId)).toBe(0)
      })

      it('a stale claim whose fallback already recorded the order ADOPTS it — even after a restock (verifier, PR 220)', async () => {
        const container = getContainer()
        const knex: any = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const s = sale({ lines: [{ variant_id: variantId, quantity: 7 }], tendered_cents: null, offline: true })
        const first = await recordInPersonSale(container as any, sellerId, s)
        if (!first.ok) throw new Error(first.code)
        // Simulate the crash window: order recorded, claim never settled, now stale.
        await knex.raw(
          `update in_person_sale set status = 'claimed', order_id = null, claimed_at = to_timestamp(0) where seller_id = ? and client_id = ?`,
          [sellerId, s.client_id])
        // Restock: on the plain cart path this resend would now SUCCEED as a second order.
        const { data: inv } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'variant', fields: ['inventory_items.inventory_item_id'], filters: { id: variantId },
        })
        const itemId = (inv[0] as any).inventory_items[0].inventory_item_id
        const [lvl] = await (container.resolve(Modules.INVENTORY) as any).listInventoryLevels({ inventory_item_id: itemId })
        await (container.resolve(Modules.INVENTORY) as any).adjustInventory(itemId, lvl.location_id, 10)
        const before = await stockedOf(container, variantId)
        const again = await recordInPersonSale(container as any, sellerId, s)
        if (!again.ok) throw new Error(`${again.code}: ${again.message}`)
        expect(again.body.order_id).toBe(first.body.order_id)
        expect(again.body.replayed).toBe(true)
        expect(await stockedOf(container, variantId)).toBe(before)
        const orders = await knex.raw(
          `select id from "order" where metadata->'in_person'->>'client_id' = ? and deleted_at is null`, [s.client_id])
        expect(orders.rows).toHaveLength(1)
      })

      it('more than the stock on hand is refused online (OUT_OF_STOCK) and the claim is closed', async () => {
        const container = getContainer()
        const s = sale({ lines: [{ variant_id: variantId, quantity: 6 }], tendered_cents: null })
        const r = await recordInPersonSale(container as any, sellerId, s)
        expect(!r.ok && r.code).toBe('OUT_OF_STOCK')
        const again = await recordInPersonSale(container as any, sellerId, s)
        expect(!again.ok && again.code).toBe('SALE_CLOSED')
      })

      // ── S2 · card and transfer (D9/D10) ─────────────────────────────────────
      // Completes the cart on the cash provider — exactly what the session-swap exploit
      // does, which is why the card case below must be REFUSED.
      async function payCart(container: any, cartId: string) {
        await container.resolve(Modules.CART).addShippingMethods(cartId, [{
          name: 'Entregado en persona', amount: 0, shipping_option_id: (await container.resolve(Modules.FULFILLMENT).listShippingOptions({}))[0].id, data: {},
        }])
        const { result: pc } = await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cartId } })
        await container.resolve(Modules.PAYMENT).createPaymentSession((pc as any).id, {
          provider_id: 'pp_cash_cash', data: {}, amount: (pc as any).amount, currency_code: 'mxn', context: {},
        })
        await completeCartWorkflow(container).run({ input: { id: cartId } })
      }

      it('a card sale builds ONE cart and waits; a resend returns the same cart', async () => {
        const container = getContainer()
        const s = sale({ kind: 'card', tendered_cents: null })
        const first = await recordInPersonSale(container as any, sellerId, s)
        if (!first.ok) throw new Error(`${first.code}: ${first.message}`)
        expect(first.status).toBe(201)
        expect(first.body.status).toBe('awaiting_payment')
        expect(first.body.order_id).toBeNull()
        expect(first.body.total_cents).toBe(30000)
        const again = await recordInPersonSale(container as any, sellerId, s)
        if (!again.ok) throw new Error(again.code)
        expect(again.body.cart_id).toBe(first.body.cart_id)
        expect(again.body.replayed).toBe(true)

        const status = await getInPersonSaleStatus(container as any, sellerId, s.client_id)
        expect(status?.state).toBe('awaiting_payment')
        // Another seller cannot read it.
        expect(await getInPersonSaleStatus(container as any, otherSellerId, s.client_id)).toBeNull()
      })

      it('a card cart CANNOT be completed on the cash provider — no order, no stock (codex security lens, PR 218)', async () => {
        // The session-swap exploit: anyone holding the cart id can switch its session to
        // pp_cash_cash (region-enabled) and complete it. The completeCart validate hook
        // refuses before an order exists.
        const container = getContainer()
        const before = await getProductAvailableQuantity(container as any, productId)
        const s = sale({ kind: 'card', tendered_cents: null })
        const r = await recordInPersonSale(container as any, sellerId, s)
        if (!r.ok) throw new Error(r.code)
        let refused: string | null = null
        try { await payCart(container, r.body.cart_id!) } catch (e) { refused = String((e as Error).message) }
        // Refused by the recorded-checkout rule or the provider rule, whichever runs first.
        expect(refused).toMatch(/no recorded checkout|cannot be completed with pp_cash_cash/)
        const status = await getInPersonSaleStatus(container as any, sellerId, s.client_id)
        expect(status?.state).toBe('awaiting_payment')
        expect(status?.order_id).toBeNull()
        expect(await getProductAvailableQuantity(container as any, productId)).toBe(before)
      })

      it('a cancel never wins while a checkout is being opened, and a cancelled sale cannot start one (codex, PR 218)', async () => {
        const container = getContainer()
        const knex: any = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const s = sale({ kind: 'card', tendered_cents: null })
        const r = await recordInPersonSale(container as any, sellerId, s)
        if (!r.ok) throw new Error(r.code)
        // start-checkout's opening write (same SQL condition) has just won: no session yet.
        await knex.raw(
          `update in_person_sale set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('checkout_started_at', now())
            where cart_id = ? and status = 'awaiting_payment'`, [r.body.cart_id])
        const cancel = await cancelInPersonSale(container as any, sellerId, s.client_id)
        expect(!cancel.ok && cancel.code).toBe('IN_PROGRESS')

        // A fresh sale cancelled first: start-checkout's opening condition can no longer match.
        const s2 = sale({ kind: 'card', tendered_cents: null })
        const r2 = await recordInPersonSale(container as any, sellerId, s2)
        if (!r2.ok) throw new Error(r2.code)
        const c2 = await cancelInPersonSale(container as any, sellerId, s2.client_id)
        expect(c2.ok && c2.status.state).toBe('cancelled')
        const open = await knex.raw(
          `update in_person_sale set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('checkout_started_at', now())
            where cart_id = ? and status = 'awaiting_payment' and (metadata->>'checkout_started_at') is null returning id`,
          [r2.body.cart_id])
        expect(open.rows).toHaveLength(0)
      })

      it('a CANCELLED transfer cannot be completed into an order afterwards (codex security lens, PR 218)', async () => {
        const container = getContainer()
        const s = sale({ kind: 'transfer', tendered_cents: null })
        const r = await recordInPersonSale(container as any, sellerId, s)
        if (!r.ok) throw new Error(r.code)
        const c = await cancelInPersonSale(container as any, sellerId, s.client_id)
        expect(c.ok && c.status.state).toBe('cancelled')
        const cartId = r.body.cart_id!
        await container.resolve(Modules.CART).addShippingMethods(cartId, [{
          name: 'Entregado en persona', amount: 0,
          shipping_option_id: (await container.resolve(Modules.FULFILLMENT).listShippingOptions({}))[0].id, data: {},
        }])
        const { result: pc } = await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cartId } })
        await container.resolve(Modules.PAYMENT).createPaymentSession((pc as any).id, {
          provider_id: 'pp_manual_manual', data: {}, amount: (pc as any).amount, currency_code: 'mxn', context: {},
        })
        let refused: string | null = null
        try { await completeCartWorkflow(container).run({ input: { id: cartId } }) } catch (e) { refused = String((e as Error).message) }
        expect(refused).toMatch(/was closed/)
      })

      it('a counter cart cannot be edited or re-paid through Medusa\'s public routes (COUNTER_CART_LOCKED)', async () => {
        const container = getContainer()
        const [key] = await (container.resolve(Modules.API_KEY) as any).createApiKeys([{ title: 'pk', type: 'publishable', created_by: 't' }])
        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.API_KEY]: { publishable_key_id: key.id },
          [Modules.SALES_CHANNEL]: { sales_channel_id: channelId },
        })
        const headers = { 'x-publishable-api-key': key.token }
        const s = sale({ kind: 'card', tendered_cents: null })
        const r = await recordInPersonSale(container as any, sellerId, s)
        if (!r.ok) throw new Error(r.code)
        const status = async (fn: () => Promise<unknown>) => {
          try { await fn(); return 200 } catch (e) { return (e as any)?.response?.status }
        }
        expect(await status(() => api.post(`/store/carts/${r.body.cart_id}/line-items`, { variant_id: variantId, quantity: 1 }, { headers }))).toBe(409)
        expect(await status(() => api.post(`/store/carts/${r.body.cart_id}`, { metadata: { source: null } }, { headers }))).toBe(409)
        expect(await status(() => api.post('/store/payment-collections', { cart_id: r.body.cart_id }, { headers }))).toBe(409)
        // Reading it is fine.
        expect(await status(() => api.get(`/store/carts/${r.body.cart_id}`, { headers }))).toBe(200)
      })

      it('an unpaid card sale cancels, and a cancelled sale cannot be resent', async () => {
        const container = getContainer()
        const s = sale({ kind: 'card', tendered_cents: null })
        await recordInPersonSale(container as any, sellerId, s)
        const cancel = await cancelInPersonSale(container as any, sellerId, s.client_id)
        expect(cancel.ok && cancel.status.state).toBe('cancelled')
        const again = await recordInPersonSale(container as any, sellerId, s)
        expect(!again.ok && again.code).toBe('SALE_CLOSED')
      })

      // ── S4 · payment links (D13–D15) ──────────────────────────────────────────
      async function payOnManual(container: any, cartId: string) {
        await container.resolve(Modules.CART).addShippingMethods(cartId, [{
          name: 'Entrega', amount: 0, shipping_option_id: (await container.resolve(Modules.FULFILLMENT).listShippingOptions({}))[0].id, data: {},
        }])
        const { result: pc } = await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cartId } })
        await container.resolve(Modules.PAYMENT).createPaymentSession((pc as any).id, {
          provider_id: 'pp_manual_manual', data: {}, amount: (pc as any).amount, currency_code: 'mxn', context: {},
        })
        const { result } = await completeCartWorkflow(container).run({ input: { id: cartId } })
        return (result as any).id as string
      }
      async function linkRow(container: any, id: string) {
        const [row] = await (container.resolve(IN_PERSON_MODULE) as any).listPaymentLinks({ id }, { take: 1 })
        return row
      }

      it('a free-amount link: server-priced cart on the hidden product, paid once, then closed', async () => {
        const container = getContainer()
        const made = await createPaymentLink(container as any, sellerId, { kind: 'amount', concept: 'Anticipo pastel', amount_cents: 80000 })
        if (!made.ok) throw new Error(`${made.code}: ${made.message}`)
        const view = await publicPaymentLink(container as any, made.body.token)
        if (!view.ok) throw new Error(view.code)
        expect(view.body).toMatchObject({ state: 'pending', kind: 'amount', concept: 'Anticipo pastel', total_cents: 80000 })
        expect(JSON.stringify(view.body)).not.toContain(sellerId)

        const cart = await buildPaymentLinkCart(container as any, made.body.token)
        if (!cart.ok) throw new Error(`${cart.code}: ${cart.message}`)
        expect(cart.body.total_cents).toBe(80000)
        const orderId = await payOnManual(container, cart.body.cart_id)
        expect(orderId).toBeTruthy()
        // The order is the seller's (its line is on a product the seller owns).
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: 'order', fields: ['id', 'total', 'items.title', 'items.product_id'], filters: { id: orderId },
        })
        expect((data[0] as any).items[0].title).toBe('Anticipo pastel')
        expect(Math.round(Number((data[0] as any).total))).toBe(80000)

        // A «Pago directo» order is NOT money yet: the link records it but stays open
        // (verifier, PR 221) — anyone with the token could otherwise close it for free.
        await recordLinkOrder(container as any, orderId)
        let row = await linkRow(container, made.body.id)
        expect(row.status).toBe('pending')
        expect(row.paid_order_ids).toEqual([orderId])
        // The seller confirms («Ya me llegó») → now the single-use link is paid and closed.
        await container.resolve(Modules.ORDER).updateOrders(orderId, { metadata: { payment_received: true } })
        await recordLinkOrder(container as any, orderId)
        row = await linkRow(container, made.body.id)
        expect(row.status).toBe('paid')
        expect(row.paid_order_ids).toEqual([orderId])
        const again = await buildPaymentLinkCart(container as any, made.body.token)
        expect(!again.ok && again.code).toBe('LINK_PAID')
      })

      it('a single-use link holds ONE payable checkout at a time (codex, PR 221)', async () => {
        const container = getContainer()
        const made = await createPaymentLink(container as any, sellerId, { kind: 'amount', concept: 'Anticipo boda', amount_cents: 50000 })
        if (!made.ok) throw new Error(made.code)
        const a = await buildPaymentLinkCart(container as any, made.body.token)
        const b = await buildPaymentLinkCart(container as any, made.body.token)
        if (!a.ok || !b.ok) throw new Error('two openers both get a cart')
        expect(await holdSingleUseLink(container as any, made.body.id, a.body.cart_id, 60_000)).toBe(true)
        // The second buyer cannot open a payable checkout while the first holds it…
        expect(await holdSingleUseLink(container as any, made.body.id, b.body.cart_id, 60_000)).toBe(false)
        // …the holder can renew…
        expect(await holdSingleUseLink(container as any, made.body.id, a.body.cart_id, 60_000)).toBe(true)
        // …and an expired hold frees the link.
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION).raw(
          `update payment_link set metadata = metadata || jsonb_build_object('hold_until', (now() - interval '1 second')::text) where id = ?`, [made.body.id])
        expect(await holdSingleUseLink(container as any, made.body.id, b.body.cart_id, 60_000)).toBe(true)
      })

      it('link carts are server-owned: locked against public edits, refused when closed or changed (verifier, PR 221)', async () => {
        const container = getContainer()
        // 1) The public cart routes refuse a link cart.
        const [key] = await (container.resolve(Modules.API_KEY) as any).createApiKeys([{ title: 'pk', type: 'publishable', created_by: 't' }])
        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.API_KEY]: { publishable_key_id: key.id },
          [Modules.SALES_CHANNEL]: { sales_channel_id: channelId },
        })
        const made = await createPaymentLink(container as any, sellerId, { kind: 'products', lines: [{ variant_id: variantId, quantity: 1 }] })
        if (!made.ok) throw new Error(made.code)
        const cart = await buildPaymentLinkCart(container as any, made.body.token)
        if (!cart.ok) throw new Error(cart.code)
        let status: number | undefined
        try {
          await api.post(`/store/carts/${cart.body.cart_id}/line-items`, { variant_id: variantId, quantity: 3 }, { headers: { 'x-publishable-api-key': key.token } })
          status = 200
        } catch (e) { status = (e as any)?.response?.status }
        expect(status).toBe(409)

        // 2) A cart changed behind the routes (module write) cannot complete.
        await (container.resolve(Modules.CART) as any).addLineItems(cart.body.cart_id, [{ variant_id: variantId, quantity: 1, title: 'x', unit_price: 1 }])
        let refused: string | null = null
        try { await payOnManual(container, cart.body.cart_id) } catch (e) { refused = String((e as Error).message) }
        expect(refused).toMatch(/changed after it was built/)

        // 3) A CANCELLED link's cart cannot be completed on the manual provider.
        const made2 = await createPaymentLink(container as any, sellerId, { kind: 'amount', concept: 'Seña', amount_cents: 20000 })
        if (!made2.ok) throw new Error(made2.code)
        const cart2 = await buildPaymentLinkCart(container as any, made2.body.token)
        if (!cart2.ok) throw new Error(cart2.code)
        await cancelPaymentLink(container as any, sellerId, made2.body.id)
        refused = null
        try { await payOnManual(container, cart2.body.cart_id) } catch (e) { refused = String((e as Error).message) }
        expect(refused).toMatch(/payment link is closed/)
      })

      it('a multi-use product link gives every opener a fresh cart', async () => {
        const container = getContainer()
        const made = await createPaymentLink(container as any, sellerId, { kind: 'products', uses: 'multi', lines: [{ variant_id: variantId, quantity: 1 }] })
        if (!made.ok) throw new Error(made.code)
        const a = await buildPaymentLinkCart(container as any, made.body.token)
        const b = await buildPaymentLinkCart(container as any, made.body.token)
        if (!a.ok || !b.ok) throw new Error('expected two carts')
        expect(a.body.cart_id).not.toBe(b.body.cart_id)
        expect(a.body.total_cents).toBe(15000)
      })

      it('expired and cancelled links cannot be paid; another seller cannot cancel a link', async () => {
        const container = getContainer()
        const made = await createPaymentLink(container as any, sellerId, { kind: 'amount', concept: 'Envío especial', amount_cents: 25000 })
        if (!made.ok) throw new Error(made.code)
        expect(await cancelPaymentLink(container as any, otherSellerId, made.body.id)).toMatchObject({ ok: false, status: 404 })
        const c = await cancelPaymentLink(container as any, sellerId, made.body.id)
        expect(c.ok && c.body.state).toBe('cancelled')
        expect(await buildPaymentLinkCart(container as any, made.body.token)).toMatchObject({ ok: false, code: 'LINK_CANCELLED' })

        const old = await createPaymentLink(container as any, sellerId, { kind: 'amount', concept: 'Viejo', amount_cents: 25000 })
        if (!old.ok) throw new Error(old.code)
        await (container.resolve(IN_PERSON_MODULE) as any).updatePaymentLinks({ id: old.body.id, expires_at: new Date(Date.now() - 1000) })
        expect(await buildPaymentLinkCart(container as any, old.body.token)).toMatchObject({ ok: false, code: 'LINK_EXPIRED' })
      })

      it("a product link refuses another seller's variant", async () => {
        const container = getContainer()
        const r = await createPaymentLink(container as any, sellerId, { kind: 'products', lines: [{ variant_id: otherVariantId }] })
        expect(!r.ok && r.code).toBe('VARIANT_NOT_OWNED')
      })
    })
}
