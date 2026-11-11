/**
 * event-seats.suite.ts — merchant-panel-gaps S1.1 (D1–D3): an event listing's
 * «Lugares disponibles» is REAL tracked Medusa inventory, against a real Postgres.
 *
 * What a mock cannot prove and this does: that the create route's `quantity` ends
 * up as a managed variant with a stock level at a location the SELLING channel can
 * see, that the number the storefront reads (Σ stocked − reserved over the product's
 * managed variants — lib/listings.ts) is the seat count, and that the engine itself
 * refuses the seat after the last one on THE variant the cart buys
 * (`productVariants[0]` when no variant is named — lib/cart.ts:234).
 *
 * A SUITE mounted inside money-path.integration.spec.ts's one runner (two runner
 * files in one jest process break each other — see in-person-sale.suite.ts).
 */
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { addToCartWorkflow, completeCartWorkflow, createCartWorkflow, listShippingOptionsForCartWorkflow, createPaymentCollectionForCartWorkflow, createRegionsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../src/modules/seller'
import { setupFulfillmentInfrastructure } from '../../src/api/store/_utils/fulfillment'
import { createSellerProduct } from '../../src/api/store/_utils/seller-product-create'
import { updateSellerProduct } from '../../src/api/store/_utils/seller-product-update'

const EVENT = { event_date: '2026-12-01', event_time: '20:00', venue_name: 'Teatro Pequeño' }

export function eventSeatsSuite(getContainer: () => any) {
  describe('event seats — Lugares disponibles is tracked inventory the engine enforces', () => {
    let sellerId: string
    let regionId: string
    let channelId: string
    let marketplaceId: string

    // These four are process-wide: save them once and restore after every test, so the
    // money-path suite that runs after this one never inherits an event fixture's ids (codex review #230).
    const ENV_KEYS = ['MEDUSA_MXN_REGION_ID', 'MEDUSA_MX_OPERATING_CHANNEL_ID', 'MEDUSA_SALES_CHANNEL_ID', 'MEDUSA_STOCK_LOCATION_ID'] as const
    const savedEnv: Record<string, string | undefined> = {}
    beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k] })
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
      }
    })

    beforeEach(async () => {
      const container = getContainer()
      const { result: [region] } = await createRegionsWorkflow(container).run({
        input: { regions: [{ name: 'México seats', currency_code: 'mxn', countries: ['mx'], payment_providers: ['pp_cash_cash'] }] },
      })
      regionId = region.id
      const [operating, marketplace] = await container.resolve(Modules.SALES_CHANNEL)
        .createSalesChannels([{ name: 'seats operating' }, { name: 'seats marketplace' }])
      channelId = operating.id
      marketplaceId = marketplace.id
      const [location] = await container.resolve(Modules.STOCK_LOCATION).createStockLocations([{ name: 'Seats MX' }])
      // Only the OPERATING channel is linked to the location up front. The create path
      // must link the marketplace channel itself (provisionVariantInventory), and the
      // update path must link both for a listing that was never provisioned.
      await container.resolve(ContainerRegistrationKeys.LINK).create({
        [Modules.SALES_CHANNEL]: { sales_channel_id: operating.id },
        [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      })
      process.env.MEDUSA_MXN_REGION_ID = region.id
      process.env.MEDUSA_MX_OPERATING_CHANNEL_ID = operating.id
      process.env.MEDUSA_SALES_CHANNEL_ID = marketplace.id
      process.env.MEDUSA_STOCK_LOCATION_ID = location.id
      await setupFulfillmentInfrastructure(container as any)
      const sellers: any = container.resolve(SELLER_MODULE)
      const [seller] = await sellers.createSellers([
        { slug: 'teatro-pequeno', name: 'Teatro Pequeño', clerk_user_id: 'user_teatro', metadata: { operating_market: 'mx' } },
      ])
      sellerId = seller.id
    })

    async function productView(container: any, productId: string) {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'product',
        fields: [
          'id',
          'variants.id', 'variants.manage_inventory',
          'variants.inventory_items.inventory.location_levels.stocked_quantity',
          'variants.inventory_items.inventory.location_levels.reserved_quantity',
        ],
        filters: { id: productId },
      })
      const variants = (data[0] as any).variants as any[]
      // The storefront's own arithmetic (lib/listings.ts): Σ stocked − reserved over MANAGED variants.
      const available = variants
        .filter((v) => v.manage_inventory)
        .flatMap((v) => v.inventory_items ?? [])
        .flatMap((ii: any) => ii.inventory?.location_levels ?? [])
        .reduce((sum: number, l: any) => sum + (Number(l.stocked_quantity) - Number(l.reserved_quantity)), 0)
      return { variants, available, managed: variants.some((v) => v.manage_inventory) }
    }

    async function tryAdd(container: any, variantId: string, quantity: number, channel = channelId): Promise<'added' | 'refused'> {
      const { result: cart } = await createCartWorkflow(container).run({
        input: { region_id: regionId, sales_channel_id: channel, currency_code: 'mxn' },
      })
      try {
        await addToCartWorkflow(container).run({
          input: { cart_id: cart.id, items: [{ variant_id: variantId, quantity }] },
        })
        return 'added'
      } catch {
        return 'refused'
      }
    }

    it('create with Cupo 2: managed variant, 2 available, 2 tickets addable, a 3rd refused by the engine', async () => {
      const container = getContainer()
      const created = await createSellerProduct(container, sellerId, {
        title: 'Obra de teatro', listing_type: 'service', price_cents: 15000, quantity: 2, attrs: EVENT,
      })
      expect(created.ok).toBe(true)
      const productId = (created as { product_id: string }).product_id

      const view = await productView(container, productId)
      expect(view.variants).toHaveLength(1)            // the variant the cart buys IS the seated one
      expect(view.variants[0].manage_inventory).toBe(true)
      expect(view.available).toBe(2)                    // → ticketQuantityCap({ available: 2 }) === 2
      expect(await tryAdd(container, view.variants[0].id, 3)).toBe('refused')
      expect(await tryAdd(container, view.variants[0].id, 2)).toBe('added')
    })

    // resolveDefaultShippingProfileId caches the profile id at MODULE level, and other suites in this
    // process create their own default profile first — so a product made here can end up with no
    // profile the cart's options match. Link it to the profile the options are built on, which is
    // what production has (one default profile, options + products both on it).
    async function optionForProduct(container: any, cartId: string, productId: string): Promise<string> {
      const opts = (await listShippingOptionsForCartWorkflow(container).run({ input: { cart_id: cartId } })).result as any[]
      const option = opts.find((o) => o.name === 'miyagi-entrega-digital')
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      await knex.raw(
        'update product_shipping_profile set shipping_profile_id = ? where product_id = ? and deleted_at is null',
        [option.shipping_profile_id, productId],
      )
      return option.id
    }

    // Reserve-at-COMPLETION is where the engine actually takes the seats: adding to a cart
    // reserves nothing. Same shape as the in-person suite's payCart (cash provider).
    // Split in two so a test can ADD for several buyers first and COMPLETE them afterwards.
    async function prepareCart(container: any, productId: string, variantId: string, quantity: number): Promise<string> {
      const { result: cart } = await createCartWorkflow(container).run({
        input: { region_id: regionId, sales_channel_id: channelId, currency_code: 'mxn', shipping_address: { country_code: 'mx', first_name: 'A', last_name: 'B', address_1: 'x', city: 'x', postal_code: '1' } as any },
      })
      await addToCartWorkflow(container).run({ input: { cart_id: cart.id, items: [{ variant_id: variantId, quantity }] } })
      await container.resolve(Modules.CART).addShippingMethods(cart.id, [{
        name: 'Entregado en persona', amount: 0,
        shipping_option_id: await optionForProduct(container, cart.id, productId), data: {},
      }])
      const { result: pc } = await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cart.id } })
      await container.resolve(Modules.PAYMENT).createPaymentSession((pc as any).id, {
        provider_id: 'pp_cash_cash', data: {}, amount: (pc as any).amount, currency_code: 'mxn', context: {},
      })
      return cart.id
    }

    async function complete(container: any, cartId: string): Promise<'completed' | string> {
      try {
        await completeCartWorkflow(container).run({ input: { id: cartId } })
        return 'completed'
      } catch (e) {
        return `refused: ${(e as Error).message}`
      }
    }

    async function buy(container: any, productId: string, variantId: string, quantity: number): Promise<'completed' | string> {
      try {
        return await complete(container, await prepareCart(container, productId, variantId, quantity))
      } catch (e) {
        return `refused: ${(e as Error).message}`
      }
    }

    it('the real race: Cupo 2, A and B each ADD 2 while seats are free; A completes, B is refused by the reservation', async () => {
      const container = getContainer()
      const created = await createSellerProduct(container, sellerId, {
        title: 'Carrera por el cupo', listing_type: 'service', price_cents: 15000, quantity: 2, attrs: EVENT,
      })
      const productId = (created as { product_id: string }).product_id
      const variantId = (await productView(container, productId)).variants[0].id

      // Both adds succeed: nothing is reserved until completion, so each cart sees 2 free seats.
      const cartA = await prepareCart(container, productId, variantId, 2)
      const cartB = await prepareCart(container, productId, variantId, 2)
      expect((await productView(container, productId)).available).toBe(2)

      expect(await complete(container, cartA)).toBe('completed')
      expect((await productView(container, productId)).available).toBe(0)

      // reserveInventoryStep → the inventory module: NOT_ALLOWED «Not enough stock available for item …».
      expect(await complete(container, cartB)).toMatch(/^refused: .*Not enough stock/)
      expect((await productView(container, productId)).available).toBe(0)   // B took nothing
    })

    it('Cupo 2, buyer A completes 2 tickets: buyer B cannot add or complete even 1 (cross-buyer oversell)', async () => {
      const container = getContainer()
      const created = await createSellerProduct(container, sellerId, {
        title: 'Cupo compartido', listing_type: 'service', price_cents: 15000, quantity: 2, attrs: EVENT,
      })
      const productId = (created as { product_id: string }).product_id
      const variantId = (await productView(container, productId)).variants[0].id

      expect(await buy(container, productId, variantId, 2)).toBe('completed')
      const after = await productView(container, productId)
      expect(after.available).toBe(0)                   // the 2 seats are now reserved/sold
      expect(await tryAdd(container, variantId, 1)).toBe('refused')
      expect(await buy(container, productId, variantId, 1)).toMatch(/^refused: .*required inventory/)
    })

    it('a refused seat edit writes nothing: a negative quantity alongside a new title leaves the title alone', async () => {
      const container = getContainer()
      const created = await createSellerProduct(container, sellerId, {
        title: 'Titulo original', listing_type: 'service', price_cents: 15000, quantity: 3, attrs: EVENT,
      })
      const productId = (created as { product_id: string }).product_id
      const sellers: any = container.resolve(SELLER_MODULE)
      const [seller] = await sellers.listSellers({ id: sellerId })
      const r = await updateSellerProduct(container, productId, { title: 'Titulo nuevo', quantity: -3 }, seller)
      expect(r).toMatchObject({ ok: false, status: 422 })
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'product', fields: ['title'], filters: { id: productId } })
      expect((data[0] as any).title).toBe('Titulo original')
      expect((await productView(container, productId)).available).toBe(3)
    })

    it('a quantity on a non-event service is refused before its new title is written', async () => {
      const container = getContainer()
      const created = await createSellerProduct(container, sellerId, {
        title: 'Servicio plano', listing_type: 'service', price_cents: 15000,
      })
      const productId = (created as { product_id: string }).product_id
      const sellers: any = container.resolve(SELLER_MODULE)
      const [seller] = await sellers.listSellers({ id: sellerId })
      const r = await updateSellerProduct(container, productId, { title: 'Cambiado', quantity: 5 }, seller)
      expect(r).toMatchObject({ ok: false, status: 422 })
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'product', fields: ['title'], filters: { id: productId } })
      expect((data[0] as any).title).toBe('Servicio plano')
    })

    it('an event with NO Cupo stays untracked (today\'s behaviour is unchanged)', async () => {
      const container = getContainer()
      const created = await createSellerProduct(container, sellerId, {
        title: 'Sin cupo', listing_type: 'service', price_cents: 15000, attrs: EVENT,
      })
      const view = await productView(container, (created as { product_id: string }).product_id)
      expect(view.managed).toBe(false)
    })

    it('a negative Cupo is refused and nothing is created', async () => {
      const container = getContainer()
      const result = await createSellerProduct(container, sellerId, {
        title: 'Negativo', listing_type: 'service', price_cents: 15000, quantity: -1, attrs: EVENT,
      })
      expect(result).toMatchObject({ ok: false, status: 422 })
    })

    it('editing an existing untracked event to add Cupo turns tracking on and the engine enforces it', async () => {
      const container = getContainer()
      const created = await createSellerProduct(container, sellerId, {
        title: 'Evento viejo', listing_type: 'service', price_cents: 15000, attrs: EVENT,
      })
      const productId = (created as { product_id: string }).product_id
      expect((await productView(container, productId)).managed).toBe(false)

      const sellers: any = container.resolve(SELLER_MODULE)
      const [seller] = await sellers.listSellers({ id: sellerId })
      const updated = await updateSellerProduct(container, productId, { quantity: 1 }, seller)
      expect(updated.ok).toBe(true)

      const view = await productView(container, productId)
      expect(view.variants[0].manage_inventory).toBe(true)
      expect(view.available).toBe(1)
      // Bought through the MARKETPLACE channel, which was never linked to the stock
      // location: the update path must have linked it, or the seat cannot be reserved.
      expect(await tryAdd(container, view.variants[0].id, 2, marketplaceId)).toBe('refused')
      expect(await tryAdd(container, view.variants[0].id, 1, marketplaceId)).toBe('added')
    })
  })
}
