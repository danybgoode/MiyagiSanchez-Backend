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
import { addToCartWorkflow, createCartWorkflow, createRegionsWorkflow } from '@medusajs/medusa/core-flows'
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
        input: { regions: [{ name: 'México seats', currency_code: 'mxn', countries: ['mx'] }] },
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
