/**
 * shipping-quote-checkout.suite.ts — a shipping rate travels from `/store/envia/rates`
 * to `/store/carts/:id/start-checkout` over real HTTP, against a real Postgres.
 *
 * Why (checkout-trust-hardening, 2026-11-12). Start-checkout used to charge whatever
 * shipping amount the request body named. It now charges a rate only when the rates
 * route's HMAC signature verifies over the very fields charged, bound to the cart's
 * products and the destination postcode. The sign and verify halves are unit-tested
 * separately (`shipping-quote-signature.unit.spec.ts`); nothing proved the two ROUTES
 * agree — that the binding the rates route signs is the binding start-checkout checks.
 * A drift there (a product id read from a different field, a postcode normalised on one
 * side only) fails closed for every real buyer while every unit test stays green.
 * Carriers are off in production, so the first real shipped checkout would have been
 * the first time the two halves met.
 *
 * Correos is the carrier used: it is quoted from a local tariff, so the whole path runs
 * without calling Envía. Its rate is signed by the same `signRates` as Envía's.
 *
 * Mounted inside `money-path.integration.spec.ts`'s one runner (see in-person-sale.suite.ts
 * for why there is only one runner). Flags are forced through the `flagOverrides` map
 * that spec installs: without Golden Frijoles in CI every flag is its compile default,
 * and `shipping.correos_enabled` defaults OFF.
 */
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createProductsWorkflow, createRegionsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../src/modules/seller'
import { setupFulfillmentInfrastructure } from '../../src/api/store/_utils/fulfillment'

const ENV_KEYS = ['MEDUSA_MXN_REGION_ID', 'MEDUSA_MX_OPERATING_CHANNEL_ID', 'MEDUSA_SALES_CHANNEL_ID', 'MEDUSA_STOCK_LOCATION_ID'] as const

const BUYER_ADDRESS = {
  name: 'Ana Compradora',
  phone: '5512345678',
  line1: 'Calle Roble',
  ext_number: '12',
  line2: 'Centro',
  city: 'Cuauhtémoc',
  state: 'Ciudad de México',
  state_code: 'CMX',
  postal_code: '06000',
}

const ITEM_CENTS = 25000
const OWNER_CLABE = '012180001234567891'
const STRANGER_CLABE = '002180009876543210'

type SignedRate = {
  rateId: string
  carrier: string
  service: string
  amountCents: number
  currency: string
  deliveryEstimate: number | null
  deliveryLabel: string | null
  signature: string | null
}

/** The storefront's mapping of a rate into the checkout body (lib/cart.ts `startCheckout`). */
function quoteFrom(rate: SignedRate) {
  return {
    rate_id: rate.rateId,
    carrier: rate.carrier,
    service: rate.service,
    amount_cents: rate.amountCents,
    currency: rate.currency,
    delivery_estimate: rate.deliveryEstimate,
    delivery_label: rate.deliveryLabel,
    signature: rate.signature,
  }
}

async function statusOf(p: Promise<unknown>): Promise<{ status?: number; data?: any }> {
  // try/catch, not `.rejects`: see money-path.integration.spec.ts on teardown noise.
  try {
    const r = (await p) as { status: number; data: any }
    return { status: r.status, data: r.data }
  } catch (err) {
    const res = (err as { response?: { status?: number; data?: any } }).response
    return { status: res?.status, data: res?.data }
  }
}

export function shippingQuoteCheckoutSuite(
  getContainer: () => any,
  api: any,
  flagOverrides: Map<string, boolean>,
) {
  describe('shipping rate → checkout — the signed rate is the charged rate', () => {
    const savedEnv: Record<string, string | undefined> = {}
    beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k] })
    afterAll(() => {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
      }
    })
    afterEach(() => flagOverrides.clear())

    let headers: Record<string, string>
    let regionId: string
    let productId: string
    let variantId: string
    let otherProductId: string
    let otherVariantId: string
    let sellerId: string
    let strangerId: string
    let strangerVariantId: string

    async function makeProduct(container: any, sellerId: string, title: string, channelIds: string[], profileId: string) {
      const { result: [product] } = await createProductsWorkflow(container).run({
        input: {
          products: [{
            title,
            status: 'published',
            shipping_profile_id: profileId,
            sales_channels: channelIds.map((id) => ({ id })),
            metadata: { listing_type: 'product' },
            options: [{ title: 'Talla', values: ['Única'] }],
            variants: [{
              title: 'Única',
              options: { Talla: 'Única' },
              manage_inventory: false,
              prices: [{ amount: ITEM_CENTS, currency_code: 'mxn' }],
            }],
          }],
        },
      })
      await container.resolve(ContainerRegistrationKeys.LINK).create({
        [SELLER_MODULE]: { seller_id: sellerId },
        [Modules.PRODUCT]: { product_id: product.id },
      })
      return product
    }

    beforeEach(async () => {
      // Rebuilt per test: the runner restores the database between tests (money-path spec header).
      flagOverrides.set('shipping.correos_enabled', true)
      const container = getContainer()

      const { result: [region] } = await createRegionsWorkflow(container).run({
        input: { regions: [{ name: 'México', currency_code: 'mxn', countries: ['mx'], payment_providers: ['pp_manual_manual'] }] },
      })
      regionId = region.id
      const channels = container.resolve(Modules.SALES_CHANNEL)
      const [operating] = await channels.createSalesChannels([{ name: 'MX operating' }])
      const [marketplace] = await channels.createSalesChannels([{ name: 'MX marketplace' }])
      const [location] = await container.resolve(Modules.STOCK_LOCATION).createStockLocations([{ name: 'MX' }])
      const link = container.resolve(ContainerRegistrationKeys.LINK)
      for (const ch of [operating, marketplace]) {
        await link.create({
          [Modules.SALES_CHANNEL]: { sales_channel_id: ch.id },
          [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
        })
      }
      process.env.MEDUSA_MXN_REGION_ID = region.id
      process.env.MEDUSA_MX_OPERATING_CHANNEL_ID = operating.id
      process.env.MEDUSA_SALES_CHANNEL_ID = marketplace.id
      process.env.MEDUSA_STOCK_LOCATION_ID = location.id

      const [key] = await container.resolve(Modules.API_KEY).createApiKeys([
        { title: 'storefront pk', type: 'publishable', created_by: 'test' },
      ])
      await link.create({
        [Modules.API_KEY]: { publishable_key_id: key.id },
        [Modules.SALES_CHANNEL]: { sales_channel_id: marketplace.id },
      })
      headers = { 'x-publishable-api-key': key.token }

      await setupFulfillmentInfrastructure(container as any)
      const [profile] = await container.resolve(Modules.FULFILLMENT).listShippingProfiles({ type: 'default' })

      // A seller that ships by Correos from a complete origin and takes bank transfer
      // («Pago directo»): the one payment rail that needs no Stripe or Mercado Pago account.
      const [seller] = await container.resolve(SELLER_MODULE).createSellers([{
        slug: 'taller-de-luz',
        name: 'Taller de Luz',
        clerk_user_id: 'user_luz',
        metadata: {
          operating_market: 'mx',
          settings: {
            shipping: {
              correos_enabled: true,
              envia_enabled: false,
              origin_address: { name: 'Taller de Luz', street: 'Av. Juárez', number: '5', colonia: 'Centro', city: 'Puebla', state: 'Puebla', state_code: 'PUE', postal_code: '72000' },
            },
            checkout: { bank_transfer: { enabled: true, clabe: OWNER_CLABE, bank_name: 'BBVA', account_holder: 'Luz' } },
          },
        },
      }])

      sellerId = seller.id
      // Another shop on the platform, with its own bank account and NO claim on these products.
      const [stranger] = await container.resolve(SELLER_MODULE).createSellers([{
        slug: 'tienda-ajena',
        name: 'Tienda ajena',
        clerk_user_id: 'user_ajena',
        metadata: {
          operating_market: 'mx',
          settings: {
            shipping: {
              correos_enabled: true,
              origin_address: { name: 'Ajena', street: 'Calle 1', number: '1', colonia: 'Centro', city: 'León', state: 'Guanajuato', state_code: 'GUA', postal_code: '37000' },
            },
            checkout: { bank_transfer: { enabled: true, clabe: STRANGER_CLABE } },
          },
        },
      }])
      strangerId = stranger.id

      const product = await makeProduct(container, seller.id, 'Lámpara de barro', [marketplace.id, operating.id], profile.id)
      productId = product.id
      variantId = product.variants[0].id
      const other = await makeProduct(container, seller.id, 'Jarrón', [marketplace.id, operating.id], profile.id)
      otherProductId = other.id
      otherVariantId = other.variants[0].id
      const strangerOwn = await makeProduct(container, stranger.id, 'Llavero ajeno', [marketplace.id, operating.id], profile.id)
      strangerVariantId = strangerOwn.variants[0].id
    })

    async function quote(productIds: string[], postal = BUYER_ADDRESS.postal_code): Promise<SignedRate> {
      const res = await api.post('/store/envia/rates', {
        items: productIds,
        address: { ...BUYER_ADDRESS, postal_code: postal },
      }, { headers })
      expect(res.status).toBe(200)
      const correos = (res.data.rates as SignedRate[]).find((r) => r.carrier === 'correos_mx')
      expect(correos).toBeDefined()
      return correos!
    }

    async function cartWith(variantIds: string[]): Promise<string> {
      const cart = await api.post('/store/carts', { region_id: regionId, email: 'ana@example.com' }, { headers })
      for (const v of variantIds) {
        await api.post(`/store/carts/${cart.data.cart.id}/line-items`, { variant_id: v, quantity: 1 }, { headers })
      }
      return cart.data.cart.id
    }

    function startCheckout(cartId: string, body: Record<string, unknown>) {
      return api.post(`/store/carts/${cartId}/start-checkout`, {
        provider: 'manual',
        manual_sub_type: 'clabe',
        fulfillment_method: 'shipping',
        shipping_address: BUYER_ADDRESS,
        // The storefront sends the listing's shop as `seller_id` (lib/cart.ts).
        seller_id: sellerId,
        ...body,
      }, { headers })
    }

    async function chargedOf(cartId: string) {
      const { data: [cart] } = await getContainer().resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'cart',
        fields: ['id', 'metadata', 'shipping_methods.amount', 'payment_collection.amount'],
        filters: { id: cartId },
      })
      return cart as any
    }

    it('a signed Correos rate is charged exactly: shipping method + payment collection', async () => {
      const rate = await quote([productId])
      // The rates route signs every rate it returns; an unsigned one could never be charged.
      expect(typeof rate.signature).toBe('string')
      expect(rate.amountCents).toBeGreaterThan(0)

      const cartId = await cartWith([variantId])
      const res = await statusOf(startCheckout(cartId, { shipping_quote: quoteFrom(rate) }))
      // toMatchObject on the whole response: a refusal prints its message, not just "422".
      expect(res).toMatchObject({ status: 200, data: { payment_method: 'manual' } })

      const cart = await chargedOf(cartId)
      expect(cart.shipping_methods.map((m: any) => Number(m.amount))).toEqual([rate.amountCents])
      // Arithmetic, not a pinned constant: item price + the signed shipping, nothing else.
      expect(Number(cart.payment_collection.amount)).toBe(ITEM_CENTS + rate.amountCents)
      expect(cart.metadata.shipping_amount_cents).toBe(rate.amountCents)
      expect(cart.metadata.shipping_carrier).toBe('correos_mx')
    })

    it('a bundle quote for two products checks out a cart of those two products', async () => {
      // Binding is the SET of product ids; the rates route signs `items` in request order and
      // start-checkout reads them from cart lines — the order must not matter.
      const rate = await quote([otherProductId, productId])
      const cartId = await cartWith([variantId, otherVariantId])
      const res = await statusOf(startCheckout(cartId, { shipping_quote: quoteFrom(rate) }))
      expect(res).toMatchObject({ status: 200 })
      const cart = await chargedOf(cartId)
      expect(Number(cart.payment_collection.amount)).toBe(2 * ITEM_CENTS + rate.amountCents)
    })

    it('a lowered amount on a signed rate is refused and nothing is charged', async () => {
      const rate = await quote([productId])
      const cartId = await cartWith([variantId])
      const res = await statusOf(startCheckout(cartId, { shipping_quote: { ...quoteFrom(rate), amount_cents: 1 } }))
      expect(res.status).toBe(422)
      expect(res.data.code).toBe('SHIPPING_QUOTE_INVALID')
      const cart = await chargedOf(cartId)
      expect(cart.payment_collection ?? null).toBeNull()
      expect(cart.shipping_methods ?? []).toHaveLength(0)
    })

    it('a rate quoted to another postcode is refused', async () => {
      const rate = await quote([productId], '72000')
      const cartId = await cartWith([variantId])
      const res = await statusOf(startCheckout(cartId, { shipping_quote: quoteFrom(rate) }))
      expect(res.status).toBe(422)
      expect(res.data.code).toBe('SHIPPING_QUOTE_INVALID')
    })

    it('a rate quoted for one product is refused on a cart of another', async () => {
      const rate = await quote([productId])
      const cartId = await cartWith([otherVariantId])
      const res = await statusOf(startCheckout(cartId, { shipping_quote: quoteFrom(rate) }))
      expect(res.status).toBe(422)
      expect(res.data.code).toBe('SHIPPING_QUOTE_INVALID')
    })

    it('an unsigned rate is refused', async () => {
      const rate = await quote([productId])
      const cartId = await cartWith([variantId])
      const res = await statusOf(startCheckout(cartId, { shipping_quote: { ...quoteFrom(rate), signature: undefined } }))
      expect(res.status).toBe(422)
      expect(res.data.code).toBe('SHIPPING_QUOTE_INVALID')
    })

    it('shipping chosen with no rate at all is refused, not charged as free', async () => {
      const cartId = await cartWith([variantId])
      const res = await statusOf(startCheckout(cartId, {}))
      expect(res).toMatchObject({ status: 400 })
      const cart = await chargedOf(cartId)
      expect(cart.payment_collection ?? null).toBeNull()
    })

    it('without a seller_id the product\'s own seller is found and paid', async () => {
      // Agents and older clients send no seller_id; checkout falls back to the seller that owns
      // the product. That lookup returned no products for every seller until 2026-11-17 (it read
      // `{ data }` from a call that returns a bare array), so such a checkout always failed.
      const rate = await quote([productId])
      const cartId = await cartWith([variantId])
      const res = await statusOf(startCheckout(cartId, { seller_id: undefined, shipping_quote: quoteFrom(rate) }))
      expect(res).toMatchObject({ status: 200, data: { manual_payment: { spei: { clabe: OWNER_CLABE } } } })
    })

    it('naming another shop as seller_id never sends the payment to that shop', async () => {
      // The money goes to the seller checkout resolves. A caller who names their own shop for
      // someone else's product must not be paid for it while the owner sees the order.
      const rate = await quote([productId])
      const cartId = await cartWith([variantId])
      const res = await statusOf(startCheckout(cartId, { seller_id: strangerId, shipping_quote: quoteFrom(rate) }))
      // Unconditional (codex, PR 238): a refusal must not pass this test — the owner is paid.
      expect(res).toMatchObject({ status: 200, data: { manual_payment: { spei: { clabe: OWNER_CLABE } } } })
    })

    it('a cart holding two shops\' products is refused, whichever line comes first', async () => {
      // The receiver used to be the owner of the FIRST cart line, so a caller could put a cheap
      // product of their own first and be paid for someone else's (codex security + pr-reviewer, PR 238).
      const cartId = await cartWith([strangerVariantId, variantId])
      for (const seller_id of [strangerId, sellerId, undefined]) {
        const res = await statusOf(startCheckout(cartId, { seller_id, fulfillment_method: 'local_pickup' }))
        expect(res).toMatchObject({ status: 409, data: { code: 'CART_MIXED_SELLERS' } })
      }
      const cart = await chargedOf(cartId)
      expect(cart.payment_collection ?? null).toBeNull()
    })

    it('with Correos switched off the rates route quotes nothing to sign (the negation)', async () => {
      // Proves the override is what turns Correos on, so the tests above are not
      // passing against a route that would quote regardless.
      flagOverrides.set('shipping.correos_enabled', false)
      const res = await api.post('/store/envia/rates', { items: [productId], address: BUYER_ADDRESS }, { headers })
      expect(res.status).toBe(200)
      expect(res.data.rates).toEqual([])
    })
  })
}
