/**
 * POST /store/carts/:id/start-checkout
 *
 * Orchestrates the checkout handoff to Stripe Connect or MercadoPago.
 *
 * 1. Loads the cart and its line items
 * 2. Finds the product's linked seller + seller payment config
 * 3. Creates the external checkout session (Stripe / MP Preference)
 * 4. Creates a Medusa PaymentSession with the external data attached
 * 5. Returns { redirect_url, cart_id, payment_session_id }
 *
 * The frontend redirects the user to redirect_url. On return, the success
 * page calls POST /store/carts/:id/complete which runs authorizePayment.
 */

import Stripe from 'stripe'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { ICartModuleService, IPaymentModuleService, IPromotionModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../../../modules/seller'
import { IN_PERSON_MODULE } from '../../../../../modules/in-person'
import { CHECKOUT_OPEN_STALE_MS, expireCounterCheckout } from '../../../../../lib/in-person-sale-status'
import { counterCartMatchesClaim } from '../../../../../lib/in-person-sale'
import SellerModuleService from '../../../../../modules/seller/service'
import { resolveSellerMpToken, sellerMpConnected, MP_MARKETPLACE_FEE_RATE } from '../../../_utils/mp'
import { resolveShippingOptionIds } from '../../../_utils/fulfillment'
import { isCoordinatedListing, type DeliveryMode } from '../../../_utils/delivery-catalog'
import { isEnabled } from '../../../../../lib/flags'
import { extractClerkUserId, resolveOrCreateBuyerCustomer } from '../../../_utils/clerk-auth'
import { resolveCouponForCheckout, couponErrorMessage } from '../../../_utils/coupons'
import { isSupportProductMetadata, normalizeSupportCheckout, type NormalizedSupportCheckout } from '../../../_utils/support'
import { resolveSellerForCheckout } from '../../../_utils/support-seller-resolution'
import { resolveRentalCheckout, type RentalBooking } from '../../../../../lib/rental-checkout'
import {
  readStripePaymentContext,
  stripeRequestOptions,
  buildStripePaymentContext,
  checkoutRefusalResponse,
  planStripeMarketStrategy,
} from '../../../../../lib/stripe-market-strategy'
import { readSellerOperatingMarket } from '../../../../../lib/seller-market'
import { sellerRowEnforcement } from '../../../../../lib/seller-status'
import { admitUsDelivery } from '../../../_utils/us-delivery-admission'
import { resolveRegionIdForMarket } from '../../../../../lib/market-medusa'

// Maps the buyer's chosen fulfillment method to a seeded Medusa shipping option.
// Medusa's completeCart validation requires a shipping method on the cart when
// items require shipping — even for pickup/coordinated/manual delivery.
const OPTION_KEY_BY_METHOD: Record<string, 'shipping' | 'pickup' | 'digital' | 'coord'> = {
  shipping: 'shipping',
  // Same seeded option as carrier shipping — it IS a shipment to an address. The
  // amount stays 0 because `methodAmount` only carries `shippingCents` for the
  // carrier method, which is exactly the seller-funded $0 rule (D16).
  manual_carrier: 'shipping',
  local_pickup: 'pickup',
  digital: 'digital',
  service: 'coord',
  rental: 'coord',
  coord: 'coord',
  none: 'coord',
}

const SHIPPING_METHOD_LABEL: Record<string, string> = {
  shipping: 'Envío a domicilio',
  pickup: 'Recolección en mano',
  digital: 'Entrega digital',
  coord: 'Entrega acordada',
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

// D8 (in-person-sales): a counter QR checkout expires after ~30 minutes. Stripe refuses
// an `expires_at` under 30 minutes from when IT receives the request, so exactly 30
// would fail on network latency — 31. Mercado Pago uses the same value so both match.
const COUNTER_CHECKOUT_TTL_MS = 31 * 60 * 1000

// Escrow: 3-day auto-confirm window (buyer must confirm delivery; else auto-captured)
const ESCROW_AUTO_CAPTURE_DAYS = 3

type FulfillmentMethod = 'local_pickup' | 'shipping' | 'digital' | 'service' | 'rental' | 'none' | 'coord' | 'manual_carrier'
type EscrowMode = 'off' | 'optional' | 'required'

// ── Bundle discount helpers ───────────────────────────────────────────────────

interface BundleTier {
  min_items: number
  percent_off: number
}

interface BundleSettings {
  enabled?: boolean
  tiers?: BundleTier[]
}

/**
 * Returns the best qualifying tier for `itemCount`, or null if no discount applies.
 * Highest min_items ≤ itemCount wins (Vinted-style tiered %).
 */
function resolveBundleTier(settings: BundleSettings | null | undefined, itemCount: number): BundleTier | null {
  if (!settings?.enabled || !settings.tiers?.length || itemCount < 2) return null
  const qualifying = settings.tiers
    .filter(t => t.min_items >= 2 && t.min_items <= itemCount && t.percent_off > 0 && t.percent_off <= 100)
    .sort((a, b) => b.min_items - a.min_items)
  return qualifying[0] ?? null
}

type CheckoutShippingAddress = {
  name?: string
  phone?: string
  /** Street name only */
  line1?: string
  /** Exterior number */
  ext_number?: string
  /** Interior number (optional) */
  int_number?: string
  /** Colonia */
  line2?: string
  /** Alcaldía / municipio (from CP lookup region_2) */
  city?: string
  state?: string
  /** Envia 2-digit state code */
  state_code?: string
  postal_code?: string
  country?: string
}

type CheckoutShippingQuote = {
  rate_id?: string
  carrier?: string
  service?: string
  amount_cents?: number
  currency?: string
  delivery_estimate?: number | null
  delivery_label?: string | null
}

function medusaAddress(input?: CheckoutShippingAddress | null) {
  if (!input) return null
  const [firstName, ...rest] = (input.name ?? '').trim().split(/\s+/).filter(Boolean)
  // Combine street + exterior number into address_1 for Medusa's single field
  const streetParts = [input.line1, input.ext_number].filter(Boolean)
  const address1 = streetParts.join(' ') || undefined
  // Interior number prepended to colonia in address_2
  const address2Parts = [
    input.int_number ? `Int ${input.int_number}` : '',
    input.line2 ?? '',
  ].filter(Boolean)
  const address2 = address2Parts.join(', ') || undefined
  return {
    first_name: firstName || undefined,
    last_name: rest.join(' ') || undefined,
    phone: input.phone || undefined,
    address_1: address1,
    address_2: address2,
    city: input.city || undefined,
    province: input.state_code || input.state || undefined,
    postal_code: input.postal_code || undefined,
    country_code: (input.country || 'mx').toLowerCase(),
  }
}

function normalizeShippingQuote(input?: CheckoutShippingQuote | null) {
  if (!input) return null
  const amount = Math.max(0, Math.round(Number(input.amount_cents ?? 0)))
  if (!amount || !input.rate_id || !input.carrier || !input.service) return null
  return {
    rate_id: String(input.rate_id).slice(0, 500),
    carrier: String(input.carrier).slice(0, 60),
    service: String(input.service).slice(0, 120),
    amount_cents: amount,
    currency: String(input.currency ?? 'MXN').toUpperCase().slice(0, 3),
    delivery_estimate: input.delivery_estimate ?? null,
    delivery_label: input.delivery_label ? String(input.delivery_label).slice(0, 80) : null,
  }
}

async function loadProductForCheckout(remoteQuery: any, productId?: string | null) {
  if (!productId) return null
  // `type.value` is the authoritative listing-type marker (rental pricing gates on it,
  // falling back to metadata.listing_type) — see resolveRentalCheckout in S1.2.
  if (typeof remoteQuery?.graph === 'function') {
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['id', 'title', 'metadata', 'status', 'type.value'],
      filters: { id: productId },
    })
    return rows?.[0] ?? null
  }

  const { data: rows } = await remoteQuery({
    product: {
      fields: ['id', 'title', 'metadata', 'status', 'type.value'],
      variables: { filters: { id: productId } },
    },
  })
  return rows?.[0] ?? null
}

/**
 * S2.2 — batched sibling of loadProductForCheckout, for the coordinated-payment
 * re-derivation below (checks ALL cart line items, not just the first).
 */
async function loadProductsForCheckout(remoteQuery: any, productIds: string[]) {
  if (!productIds.length) return []
  if (typeof remoteQuery?.graph === 'function') {
    const { data: rows } = await remoteQuery.graph({
      entity: 'product',
      fields: ['id', 'metadata', 'type.value'],
      filters: { id: productIds },
    })
    return rows ?? []
  }

  const { data: rows } = await remoteQuery({
    product: {
      fields: ['id', 'metadata', 'type.value'],
      variables: { filters: { id: productIds } },
    },
  })
  return rows ?? []
}

/**
 * Is `cartId` a cart our server built for this source? Read from the server's own
 * record, never the cart's client-writable metadata (D8).
 */
type CounterClaim = { status: string; kind: string; payload_hash: string; seller_id: string; metadata: Record<string, unknown> | null }

async function serverBuiltCart(req: MedusaRequest, cartId: string): Promise<CounterClaim | null> {
  // payment links register their carts in S4
  const inPerson: any = req.scope.resolve(IN_PERSON_MODULE)
  const [claim] = await inPerson.listInPersonSales({ cart_id: cartId }, { take: 1 })
  return claim
    ? { status: String(claim.status), kind: String(claim.kind), payload_hash: String(claim.payload_hash), seller_id: String(claim.seller_id), metadata: claim.metadata ?? null }
    : null
}

/** The cart still holds exactly the sale the claim recorded (lines and total). */
async function counterCartIntact(req: MedusaRequest, cartId: string, claim: CounterClaim): Promise<boolean> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'cart',
    fields: ['id', 'total', 'items.variant_id', 'items.quantity'],
    filters: { id: cartId },
  })
  const cart = data?.[0] as any
  return counterCartMatchesClaim(
    { total: cart?.total, items: cart?.items ?? [] },
    { kind: claim.kind, payload_hash: claim.payload_hash, total_cents: (claim.metadata as any)?.total_cents },
  )
}

/** Take the one right to open this counter cart's checkout. True only for the winner. */
async function openCounterCheckout(req: MedusaRequest, cartId: string): Promise<string | null> {
  const knex: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const mark = `metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('checkout_started_at', now()::text)`
  const r = await knex.raw(
    `update in_person_sale set ${mark}, updated_at = now()
      where cart_id = ? and status = 'awaiting_payment' and (metadata->>'checkout_started_at') is null
      returning metadata->>'checkout_started_at' as started`,
    [cartId],
  )
  if ((r?.rows?.length ?? 0) > 0) return r.rows[0].started as string
  // A start that died before creating its payment session (a provider error, a crash)
  // must not wedge the sale forever (codex, PR 218): re-open it once it is stale and
  // still has no collection — compare-and-set on the exact mark we read, the same
  // condition cancel uses, so a re-open and a cancel cannot both win.
  const [row] = (await knex.raw(
    `select metadata->>'checkout_started_at' as started from in_person_sale where cart_id = ? and status = 'awaiting_payment'`,
    [cartId],
  ))?.rows ?? []
  const started: string | undefined = row?.started
  if (!started || Date.now() - new Date(started).getTime() < CHECKOUT_OPEN_STALE_MS) return null
  if (await cartHasPaymentCollection(req, cartId)) return null
  const re = await knex.raw(
    `update in_person_sale set ${mark}, updated_at = now()
      where cart_id = ? and status = 'awaiting_payment' and metadata->>'checkout_started_at' = ?
      returning metadata->>'checkout_started_at' as started`,
    [cartId, started],
  )
  return (re?.rows?.[0]?.started as string | undefined) ?? null
}

/**
 * Fence: record which provider checkout this counter sale opened — ONLY if this request
 * still holds the open mark and the sale still awaits payment. A cancel (or a second
 * opener) that won meanwhile makes this fail, and the caller expires what it created.
 * The recorded ref is what cancel expires: the server's own record, never the cart's
 * current session, which the public payment-session route can replace.
 */
async function fenceCounterCheckout(req: MedusaRequest, cartId: string, mark: string, provider: string, ref: string): Promise<boolean> {
  const knex: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const r = await knex.raw(
    `update in_person_sale
        set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('checkout_provider', ?::text, 'checkout_ref', ?::text),
            updated_at = now()
      where cart_id = ? and status = 'awaiting_payment' and metadata->>'checkout_started_at' = ?
      returning id`,
    [provider, ref, cartId, mark],
  )
  return (r?.rows?.length ?? 0) > 0
}

/** Give the open mark back after a failure, so a retry can open at once (owner-conditional). */
async function releaseCounterCheckout(req: MedusaRequest, cartId: string, mark: string): Promise<void> {
  const knex: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  await knex.raw(
    `update in_person_sale set metadata = metadata - 'checkout_started_at', updated_at = now()
      where cart_id = ? and status = 'awaiting_payment' and metadata->>'checkout_started_at' = ?
        and (metadata->>'checkout_ref') is null`,
    [cartId, mark],
  )
}

/** Unlink every payment collection from a counter cart (debris of a dead attempt). */
async function unlinkCartCollection(req: MedusaRequest, cartId: string): Promise<void> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'cart', fields: ['id', 'payment_collection.id'], filters: { id: cartId } })
  const pcId = (data?.[0] as any)?.payment_collection?.id
  if (!pcId) return
  await req.scope.resolve(ContainerRegistrationKeys.LINK).dismiss({
    [Modules.CART]: { cart_id: cartId },
    [Modules.PAYMENT]: { payment_collection_id: pcId },
  })
}

/** Does this cart already carry a payment collection (i.e. a checkout was opened)? */
async function cartHasPaymentCollection(req: MedusaRequest, cartId: string): Promise<boolean> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'cart', fields: ['id', 'payment_collection.id'], filters: { id: cartId } })
  return Boolean((data?.[0] as any)?.payment_collection?.id)
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: cartId } = req.params
  const body = req.body as {
    provider: 'stripe' | 'mercadopago' | 'spei' | 'cash' | 'manual'
    /** For provider 'manual': which structured instruction the buyer chose. */
    manual_sub_type?: 'clabe' | 'cash' | 'dimo'
    buyer_email?: string
    offer_amount_cents?: number   // accepted offer override
    coupon_code?: string          // seller coupon code applied at checkout
    offer_id?: string             // Supabase offer ID for webhook reconciliation
    seller_id?: string            // skip expensive seller scan when caller already knows it
    fulfillment_method?: FulfillmentMethod
    pickup_spot_id?: string
    /** Local pickup: the buyer's proposed appointment (Delivery & Manual-Money Polish S2.1). */
    pickup_appointment?: { date?: string; window?: string }
    /** Rental listing: the buyer's chosen date range. ONLY dates — the total is
     *  recomputed server-side (checkout.rental_pricing_enabled, S1.2). Never an amount. */
    rental?: { check_in?: string; check_out?: string }
    shipping_address?: CheckoutShippingAddress
    shipping_quote?: CheckoutShippingQuote
    escrow?: boolean              // buyer explicitly opts in to escrow when mode='optional'
    origin_domain?: string        // tenant custom domain the buyer came from (own-channel hop)
    support?: {
      amount_cents?: number
      supporter_name?: string
      supporter_email?: string
      message?: string
      visibility?: 'public' | 'private'
      embed_key?: string
      channel?: string
    }
  }

  if (!body.provider || !['stripe', 'mercadopago', 'spei', 'cash', 'manual'].includes(body.provider)) {
    return res.status(400).json({ message: 'provider is required: "stripe", "mercadopago", or "manual"' })
  }

  // Manual payments: one "Pago directo" method (legacy clients may still send
  // 'spei'/'cash'). All route to the unified pp_manual provider and are recorded
  // as metadata.payment_method = 'manual' with a snapshot of ALL the seller's
  // configured instructions (filled in the manual branch below).
  const isManual = body.provider === 'manual' || body.provider === 'spei' || body.provider === 'cash'

  const supportResolution = body.support === undefined ? null : normalizeSupportCheckout(body.support)
  if (supportResolution && !supportResolution.ok) {
    return res.status(422).json({ message: supportResolution.message, code: 'SUPPORT_INVALID' })
  }
  const supportCheckout: NormalizedSupportCheckout | null = supportResolution?.ok ? supportResolution.support : null
  if (supportCheckout && isManual) {
    return res.status(422).json({
      message: 'Los apoyos solo pueden pagarse con Stripe o Mercado Pago.',
      code: 'SUPPORT_PROVIDER_UNSUPPORTED',
    })
  }

  // Own-channel hop: the buyer came from a tenant's custom domain and was sent to
  // the platform for the secure step. We record the origin domain + channel on the
  // cart (→ order metadata) so the success page can return them to their domain and
  // the sale is attributed `custom_domain`. Stored only — never used to build a
  // redirect here (the success page validates it against the verified-domain set
  // before redirecting, so a forged value can't become an open redirect).
  const originDomain = ((): string | null => {
    const raw = (body.origin_domain ?? '').trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!raw || raw.length > 253) return null
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw) ? raw : null
  })()

  // Rule: coordinated delivery (none/coord/service/rental) requires manual payment
  // coordination. Card payments create buyer anxiety when there is no structured
  // delivery path. This is a CHEAP, early, client-trusting pre-check — fails fast
  // for well-behaved clients before any DB call. It is NOT the authoritative
  // guard: a direct API/MCP caller can lie about fulfillment_method, so the real
  // enforcement is the product-data re-derivation below (S2.2), once the cart's
  // actual items are loaded.
  const COORD_MESSAGE = 'Este vendedor coordina la entrega personalmente. El pago debe acordarse junto con la entrega — usa pago directo (SPEI / efectivo).'
  const fulfillmentMethodEarly = supportCheckout ? 'digital' : (body.fulfillment_method ?? 'none')
  if (
    (fulfillmentMethodEarly === 'none' || fulfillmentMethodEarly === 'coord' ||
     fulfillmentMethodEarly === 'service' || fulfillmentMethodEarly === 'rental') &&
    !isManual
  ) {
    return res.status(422).json({ message: COORD_MESSAGE })
  }

  const cartService: ICartModuleService = req.scope.resolve(Modules.CART)
  const paymentService: IPaymentModuleService = req.scope.resolve(Modules.PAYMENT)
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  // ── Load cart ─────────────────────────────────────────────────────────────
  // Only request relations within the cart module. `region` and `items.variant`
  // live in other modules and can't be populated here (MikroORM throws
  // "Entity 'Cart' does not have property 'region'"). Line items already carry
  // denormalized product_id / title / thumbnail, and the cart has currency_code.
  const [cart] = await cartService.listCarts(
    { id: cartId },
    { relations: ['items'] }
  )

  if (!cart) {
    return res.status(404).json({ message: 'Cart not found' })
  }

  // ── Link the buyer's Medusa customer to the cart ──────────────────────────
  // completeCart copies cart.customer_id → order.customer_id, which the buyer
  // order pages (/store/customers/me/orders) use for ownership. Resolve (or
  // create) the ONE canonical customer for this Clerk buyer — keyed by Clerk id
  // (customer.metadata.clerk_user_id) + email — and attach it, so the order is
  // owned by a stable, clerk-linked customer instead of a throwaway guest.
  if (!(cart as any).customer_id) {
    const clerkUserId = extractClerkUserId(req)
    if (clerkUserId) {
      try {
        const customerId = await resolveOrCreateBuyerCustomer(req.scope, {
          clerkUserId,
          email: (cart as any).email ?? body.buyer_email ?? null,
        })
        if (customerId) {
          await cartService.updateCarts(cartId, { customer_id: customerId } as any)
        }
      } catch (e) {
        console.error('[start-checkout] customer link failed:', e)
      }
    }
  }

  if (!cart.items?.length) {
    return res.status(400).json({ message: 'Cart is empty' })
  }

  // ── Server-built carts (in-person-sales D8) ───────────────────────────────
  // A counter sale (`in_person`) or a payment link (`payment_link`) is a cart OUR
  // server routes built and priced. The source is read from the CART's metadata —
  // never the body — because only those routes write it. For such a cart the cart
  // total IS the price: no client offer amount, coupon or bundle can move it.
  //
  // The metadata alone is NOT proof: Medusa's public store routes (POST /store/carts,
  // POST /store/carts/:id) accept client `metadata`, so a buyer could label any cart
  // `in_person`. The source counts only when the server's own record names THIS cart
  // — an `in_person_sale` claim for a counter cart (payment links: S4).
  //
  // So the decision never STARTS from metadata either: clearing `source` must not
  // switch the protections off (codex, PR 218 — a cleared label plus
  // `offer_amount_cents: 1` underpaid a server-priced counter sale). Every cart is
  // looked up in the claim table by id; a cart with a claim IS a counter cart.
  const serverClaim = await serverBuiltCart(req, cartId)
  const serverCartSource: 'in_person' | 'payment_link' | null = serverClaim ? 'in_person' : null
  if (serverCartSource === 'in_person') {
    // A counter cart opens exactly ONE payable checkout, and only while its sale waits
    // for payment: a cancelled sale must not become payable again, and a second call
    // would link a second collection whose session cancel could never expire
    // (verifier + codex, PR 218). The status route reads the one checkout URL back.
    //
    // Atomic: the right to open the checkout is a conditional write on the claim
    // (`checkout_started_at` set only while the sale awaits payment and none was
    // started). Cancel takes the same row with the opposite condition, so a cancel and
    // a checkout racing for one sale cannot both win — a check-then-act here let a
    // cancel land between the check and the provider session (codex, PR 218).
    // The provider must be the one the sale's kind completes on (the same table the
    // completeCart hook enforces): a card sale opened as `manual` would take the one
    // checkout slot with a session completion then refuses — an unpayable sale
    // (codex security lens, PR 218).
    const expectedProvider = serverClaim!.kind === 'card'
      ? (body.provider === 'stripe' || body.provider === 'mercadopago')
      : serverClaim!.kind === 'transfer'
        ? body.provider === 'manual'
        : false
    if (!expectedProvider) {
      return res.status(422).json({ code: 'COUNTER_PROVIDER_MISMATCH', message: 'Este método de pago no corresponde a esta venta.' })
    }
    if (serverClaim!.status !== 'awaiting_payment') {
      return res.status(409).json({ code: 'SALE_CLOSED', message: 'Esta venta ya no se puede cobrar.' })
    }
    if (await cartHasPaymentCollection(req, cartId)) {
      // A collection with a RECORDED checkout is the live one. One with no recorded
      // checkout is debris from an attempt that died between linking it and fencing it
      // (a crash); once that attempt is stale it is unlinked so the sale can be retried
      // (codex, PR 218).
      const meta = (serverClaim!.metadata ?? {}) as Record<string, unknown>
      const started = typeof meta.checkout_started_at === 'string' ? meta.checkout_started_at : null
      const stale = !started || Date.now() - new Date(started).getTime() >= CHECKOUT_OPEN_STALE_MS
      if (meta.checkout_ref || !stale) {
        return res.status(409).json({ code: 'CHECKOUT_EXISTS', message: 'Este cobro ya tiene un pago abierto.' })
      }
      await unlinkCartCollection(req, cartId)
    }
    // The cart must still be EXACTLY what the merchant rang up: anyone holding a cart id
    // can edit its lines or add a promotion through Medusa's public cart routes, and the
    // price below is the cart's (codex security lens, PR 218).
    if (!(await counterCartIntact(req, cartId, serverClaim!))) {
      return res.status(409).json({ code: 'CART_CHANGED', message: 'Esta venta cambió. Vuelve a cobrarla desde el mostrador.' })
    }
    if (supportCheckout) {
      return res.status(422).json({ code: 'COUNTER_PROVIDER_MISMATCH', message: 'Este método de pago no corresponde a esta venta.' })
    }
    // The goods are handed over at the counter: no shipping, rental, escrow or address
    // can ride a counter checkout, whatever the caller sends.
    body.fulfillment_method = 'local_pickup'
    body.shipping_quote = undefined
    body.shipping_address = undefined
    body.rental = undefined
    body.escrow = false
    body.pickup_spot_id = undefined
    body.pickup_appointment = undefined
    // The seller who receives the money is the sale's seller — never a caller-supplied id,
    // which seller resolution would otherwise prefer (codex security lens, PR 218).
    body.seller_id = serverClaim!.seller_id
    //
    // The ONE-checkout guarantee is taken later, AFTER the provider checkout exists
    // (`openCounterCheckout` + `fenceCounterCheckout` below): marking here let any
    // validation failure afterwards wedge the slot, and a stalled request could create a
    // payable QR after a cancel (codex, PR 218).
  }
  const isCounterCart = serverCartSource === 'in_person'
  // Payment links (S4) will resolve their id from their own table, like the claim above.
  const paymentLinkId = null as string | null
  if (serverCartSource) {
    body.offer_amount_cents = undefined
    body.offer_id = undefined
    body.coupon_code = undefined
  }

  const item = cart.items[0] as any
  const productId = item.product_id ?? item.variant?.product_id

  // For multi-item carts, build a combined title (used in payment provider display)
  const allTitles = cart.items.map((i: any) => (i as any).title ?? 'Producto').filter(Boolean)
  const productTitle = allTitles.length > 1
    ? `${allTitles[0]} + ${allTitles.length - 1} más`
    : (allTitles[0] ?? 'Producto')
  const productImage = (item as any).thumbnail ?? null
  const productRecord = await loadProductForCheckout(remoteQuery as any, productId)
  const productMetadata = ((productRecord as any)?.metadata ?? {}) as Record<string, unknown>

  // ── Coordinated-payment re-derivation (S2.2) ──────────────────────────────
  // The authoritative guard: re-derive "must this cart pay manually" from the
  // cart's ACTUAL product data (listing type + stored delivery_mode), not the
  // client-supplied fulfillment_method the early check above trusted. Checks
  // every line item — any single coordinated item forces manual payment for
  // the whole cart. Uses the same canonical isCoordinatedListing() that
  // checkout-options uses, so the two surfaces can never disagree.
  {
    const arrangedOnlyEnabledForGuard = await isEnabled('shipping.arranged_only_enabled')
    const cartProductIds = Array.from(new Set(
      (cart.items ?? []).map((i: any) => i.product_id ?? i.variant?.product_id).filter(Boolean)
    )) as string[]
    const cartProducts = cartProductIds.length
      ? await loadProductsForCheckout(remoteQuery as any, cartProductIds)
      : (productRecord ? [productRecord] : [])
    // Fail CLOSED on incomplete hydration: if remoteQuery returned fewer rows
    // than cart items reference, a coordinated line's product could be exactly
    // the one that silently dropped out of `.some()` below — that must not
    // read as "not coordinated." Missing hydration is treated as coordinated.
    const hydrationIncomplete = cartProductIds.length > 0 && cartProducts.length < cartProductIds.length
    const cartHasCoordinatedItem = hydrationIncomplete || (cartProducts as any[]).some((p) => {
      const meta = (p?.metadata ?? {}) as Record<string, unknown>
      // Mirrors checkout-options' isDigital derivation (route.ts ~line 85) minus
      // the client-supplied `is_digital` query param, which has no server-side
      // equivalent here — no separate `metadata.is_digital` field is ever
      // written (grepped the product write path), so listingType is the only
      // signal available and the two can't diverge in practice.
      const listingType = (p?.type?.value as string | undefined) ?? (meta.listing_type as string | undefined) ?? 'product'
      const deliveryMode: DeliveryMode = meta.delivery_mode === 'arranged' ? 'arranged' : 'carrier'
      const isDigitalItem = listingType === 'digital' || listingType === 'print_ad'
      return isCoordinatedListing({ listingType, deliveryMode, arrangedOnlyEnabled: arrangedOnlyEnabledForGuard, isDigital: isDigitalItem })
    })
    // A counter sale hands the goods over in person, so "delivery is coordinated" has
    // nothing left to coordinate — card by QR is exactly the point (D8).
    if (cartHasCoordinatedItem && !isManual && !isCounterCart) {
      return res.status(422).json({ message: COORD_MESSAGE })
    }
  }

  // ── Rental pricing (server-recomputed total) ──────────────────────────────
  // A rental checkout sends ONLY the date range; the total (nights × rate +
  // deposit) is recomputed here from those dates + the product's own attrs + the
  // listing's variant price. Behind checkout.rental_pricing_enabled (default OFF
  // ⇒ 422 → today's coordination flow). A client-sent amount can NEVER influence
  // this — resolveRentalCheckout takes no amount parameter (tamper guarantee).
  // Trigger on the fulfillment method (not mere `body.rental` presence) so a stray
  // `rental` field on a NORMAL product can never divert its checkout.
  let rentalBooking: RentalBooking | null = null
  if (body.fulfillment_method === 'rental') {
    const listingType =
      (productRecord as any)?.type?.value ??
      (productMetadata.listing_type as string | undefined) ??
      'product'
    const rentalResult = resolveRentalCheckout({
      flagEnabled: await isEnabled('checkout.rental_pricing_enabled'),
      fulfillmentMethod: body.fulfillment_method,
      listingType,
      rental: body.rental,
      rateCents: Math.round(Number((item as any).unit_price ?? 0)),
      attrs: (productMetadata.attrs as Record<string, unknown>) ?? {},
      itemCount: (cart.items ?? []).length,
      quantity: Math.round(Number((item as any).quantity ?? 1)),
    })
    if (!rentalResult.ok) {
      return res.status(422).json({ message: rentalResult.message, code: rentalResult.code })
    }
    rentalBooking = rentalResult.booking
  }

  if (supportCheckout && !isSupportProductMetadata(productMetadata)) {
    return res.status(422).json({
      message: 'Este producto no puede usarse para apoyos.',
      code: 'SUPPORT_PRODUCT_INVALID',
    })
  }

  // ── Find seller for this product ──────────────────────────────────────────
  const seller = await resolveSellerForCheckout({
    sellerService,
    remoteQuery,
    productId,
    bodySellerId: body.seller_id,
    productMetadata,
    isSupportCheckout: !!supportCheckout,
  })

  // ── The selling shop must be ACTIVE (tenant-lifecycle-admin · D2b) ──────────
  //
  // THE authoritative money gate for a pause. `/store/checkout-admission/:id` is an
  // OFFER gate the storefront consults — it cannot bind a caller who skips it, and
  // `POST /store/carts/:id/line-items` enforces no membership of any kind (a
  // pre-existing gap this epic inherits, recorded as owed by the owned-shop epic).
  // This route is different: it is where a cart becomes a payment session, so
  // refusing here means a paused shop cannot be paid regardless of how the cart was
  // assembled — through the storefront, the UCP/MCP surface, or a direct API call.
  //
  // Checked against the seller that would RECEIVE the money, which is the correct
  // authorization subject for "may this shop transact".
  // A seller that does not resolve is NOT treated as paused — that is a different
  // problem with its own handling below, and reporting it as "this shop is paused"
  // would misdescribe it.
  const sellerGate = sellerRowEnforcement(seller)
  if (sellerGate.present && !sellerGate.admits) {
    return res.status(409).json({
      code: 'seller_not_active',
      message: 'Esta tienda no está disponible en este momento.',
    })
  }

  const currency = (cart.currency_code ?? 'mxn').toLowerCase()
  // A plain listCarts may not compute `total`; fall back to summing line items
  // (same unit as cart.total — variant prices are stored as integer cents).
  const itemsTotalCents = (cart.items ?? []).reduce(
    (sum: number, i: any) => sum + Math.round(Number(i.unit_price ?? 0) * Number(i.quantity ?? 1)),
    0,
  )
  // Rental total (server-recomputed) wins over every other source — a client
  // `offer_amount_cents` sent alongside `rental` is ignored (tamper guarantee).
  const rawItemsCents = rentalBooking?.total_cents ?? supportCheckout?.amount_cents ?? body.offer_amount_cents ?? (Math.round(Number(cart.total ?? 0)) || itemsTotalCents)
  const shippingQuote = normalizeShippingQuote(body.shipping_quote)
  const shippingCents = shippingQuote?.amount_cents ?? 0
  // priceCents and checkoutTotalCents are finalized after bundle discount is resolved below

  if (!seller) {
    return res.status(422).json({
      message: 'Este anuncio aún no tiene vendedor registrado.',
      code: 'SELLER_NOT_CONNECTED',
    })
  }

  const sellerMeta = (seller.metadata ?? {}) as Record<string, unknown>
  const sellerSettings = (sellerMeta.settings ?? {}) as Record<string, unknown>
  const supportSettings = (sellerSettings.support ?? {}) as Record<string, unknown>
  if (supportCheckout) {
    const configuredSupportProductId = typeof supportSettings.support_product_id === 'string'
      ? supportSettings.support_product_id
      : null
    const supportCurrency = String(supportSettings.currency ?? cart.currency_code ?? 'MXN').toUpperCase()
    const configuredMinCents = Math.round(Number(supportSettings.custom_min_cents ?? 100))
    const configuredMaxCents = Math.round(Number(supportSettings.custom_max_cents ?? 500_000))
    const minCents = Number.isFinite(configuredMinCents) ? Math.max(100, configuredMinCents) : 100
    const maxCents = Number.isFinite(configuredMaxCents) ? Math.min(500_000, configuredMaxCents) : 500_000

    if (supportSettings.enabled !== true) {
      return res.status(422).json({ message: 'Este vendedor no tiene apoyos activos.', code: 'SUPPORT_DISABLED' })
    }
    if (configuredSupportProductId && configuredSupportProductId !== productId) {
      return res.status(422).json({ message: 'La configuración de apoyos no coincide con este producto.', code: 'SUPPORT_PRODUCT_MISMATCH' })
    }
    if (supportCurrency.toLowerCase() !== currency) {
      return res.status(422).json({ message: 'La moneda del apoyo no coincide con el carrito.', code: 'SUPPORT_CURRENCY_MISMATCH' })
    }
    if (supportCheckout.amount_cents < minCents || supportCheckout.amount_cents > maxCents) {
      return res.status(422).json({
        message: 'El monto de apoyo está fuera de los límites configurados.',
        code: 'SUPPORT_AMOUNT_OUT_OF_RANGE',
      })
    }
  }

  const fulfillmentMethod = supportCheckout ? 'digital' : (body.fulfillment_method ?? 'none')
  if (fulfillmentMethod === 'shipping' && !shippingQuote) {
    return res.status(400).json({ message: 'Selecciona una tarifa de envío para continuar.' })
  }

  // ── US delivery admission (D16) ───────────────────────────────────────────
  // Before the first authoritative write. The seller's own market decides, never a
  // caller-supplied one, and an unreadable market falls back to `mx` — the market
  // whose rules are already in force for every seller on the platform today.
  const sellerMarketRead = readSellerOperatingMarket(seller)
  const admission = admitUsDelivery({
    market: sellerMarketRead.market === 'us' ? 'us' : 'mx',
    fulfillmentMethod,
    provider: body.provider,
    hasClientShippingQuote: body.shipping_quote != null,
    shippingAddress: (cart as any)?.shipping_address ?? null,
  })
  if (!admission.ok) {
    return res.status(admission.status).json({ message: admission.message, code: admission.code })
  }

  // ── Bundle discount (tiered %) ────────────────────────────────────────────
  // Applied to item subtotal only (not shipping). Ignored when buyer has an accepted
  // offer override (offer_amount_cents already reflects an agreed price).
  const bundleSettings = (sellerSettings.bundles ?? null) as BundleSettings | null
  const itemCount = (cart.items ?? []).length
  const bundleTier = body.offer_amount_cents || supportCheckout || rentalBooking || serverCartSource ? null : resolveBundleTier(bundleSettings, itemCount)
  const bundleDiscountCents = bundleTier
    ? Math.round(itemsTotalCents * bundleTier.percent_off / 100)
    : 0

  // ── Coupon code (seller-scoped) ───────────────────────────────────────────
  // Applied on the post-bundle item subtotal. Like the bundle discount, it's
  // ignored when an accepted offer override is present. Validated against the
  // Promotion module + the seller's own coupon_ids; a bad code fails the
  // checkout loudly so the buyer never silently pays full price.
  const postBundleBase = Math.max(0, rawItemsCents - bundleDiscountCents)
  let couponInfo: { code: string; promotion_id: string; discount_cents: number } | null = null
  let couponDiscountCents = 0
  if (body.coupon_code && !body.offer_amount_cents && !supportCheckout && !rentalBooking) {
    const couponIds = Array.isArray((sellerMeta as any).coupon_ids) ? (sellerMeta as any).coupon_ids as string[] : []
    const promotionService = req.scope.resolve(Modules.PROMOTION) as IPromotionModuleService
    // Cart product context so a PRODUCT-SCOPED coupon (bookshop-launchpad S3.3)
    // discounts only its own product's subtotal and is rejected on a cart that
    // doesn't contain it. Non-scoped coupons ignore this.
    const productSubtotals: Record<string, number> = {}
    for (const i of (cart.items ?? []) as any[]) {
      const pid = i.product_id ?? i.variant?.product_id
      if (!pid) continue
      productSubtotals[pid] = (productSubtotals[pid] ?? 0) + Math.round(Number(i.unit_price ?? 0) * Number(i.quantity ?? 1))
    }
    const resolution = await resolveCouponForCheckout(promotionService, body.coupon_code, couponIds, postBundleBase, {
      productIds: Object.keys(productSubtotals),
      productSubtotals,
    })
    if (!resolution.ok) {
      return res.status(422).json({ message: couponErrorMessage(resolution.reason), code: 'COUPON_INVALID' })
    }
    couponDiscountCents = resolution.discount_cents
    couponInfo = { code: resolution.code, promotion_id: resolution.promotion_id, discount_cents: couponDiscountCents }
  }

  // priceCents = item charge after discounts (providers bill this); checkoutTotalCents adds shipping
  const priceCents = Math.max(0, rawItemsCents - bundleDiscountCents - couponDiscountCents)
  const checkoutTotalCents = priceCents + shippingCents

  // ── Escrow mode is resolved early so it can be written to cart metadata before the payment branch
  const checkoutSettings = (sellerSettings.checkout ?? {}) as Record<string, unknown>
  const escrowModeSetting = (checkoutSettings.escrow_mode ?? 'off') as EscrowMode
  // D8 (amended): never escrow a counter sale — the goods are handed over in person, so
  // there is no delivery to confirm, and an authorize-only payment must not read as paid.
  const useEscrow = !serverCartSource && (escrowModeSetting === 'required' || (escrowModeSetting === 'optional' && body.escrow === true))

  // payment_method recorded on the order: 'manual' for all direct payments,
  // otherwise the gateway id.
  const effectivePaymentMethod = isManual ? 'manual' : body.provider
  const supportMetadata = supportCheckout ? {
    kind: 'support',
    amount_cents: supportCheckout.amount_cents,
    currency: currency.toUpperCase(),
    supporter_name: supportCheckout.supporter_name,
    supporter_email: supportCheckout.supporter_email,
    message: supportCheckout.message,
    visibility: supportCheckout.visibility,
    embed_key: supportCheckout.embed_key,
    channel: supportCheckout.channel,
    support_product_id: productId ?? null,
    seller_id: seller.id,
    seller_slug: seller.slug,
  } : null

  // ── Manual instruction snapshot ───────────────────────────────────────────
  // Capture ALL of the seller's configured direct-payment methods so the order /
  // success page + emails show everything at once (buyer chooses how to pay).
  let manualPaymentSnapshot: { spei: unknown; dimo: unknown; cash: unknown } | null = null
  if (isManual) {
    const bankTransfer = (checkoutSettings.bank_transfer ?? {}) as Record<string, unknown>
    const clabe = typeof bankTransfer.clabe === 'string' ? bankTransfer.clabe.replace(/\D/g, '') : ''
    const spei = (bankTransfer.enabled !== false && clabe.length === 18)
      ? { clabe, bank_name: (bankTransfer.bank_name as string | undefined) ?? null, account_holder: (bankTransfer.account_holder as string | undefined) ?? null }
      : null

    const dimoConfig = (checkoutSettings.dimo ?? {}) as Record<string, unknown>
    const dimoPhone = typeof dimoConfig.phone === 'string' ? dimoConfig.phone.replace(/\D/g, '') : ''
    const dimo = (dimoConfig.enabled === true && dimoPhone.length >= 10) ? { phone: dimoPhone } : null

    const cashConfig = (checkoutSettings.cash_pickup ?? {}) as Record<string, unknown>
    const cash = (cashConfig.enabled !== false && fulfillmentMethod === 'local_pickup')
      ? { note: (cashConfig.note as string | undefined) ?? null }
      : null

    if (!spei && !dimo && !cash) {
      return res.status(422).json({
        message: 'Este vendedor no tiene métodos de pago directo configurados. Contáctalo directamente.',
        code: 'SELLER_MANUAL_MISSING',
      })
    }
    manualPaymentSnapshot = { spei, dimo, cash }
  }

  // Pickup appointment (S2.1) — for local pickup, the buyer proposes a date + time
  // window. We persist the initial `propuesta` (proposed_by buyer); the seller confirms
  // or reschedules later (S2.2). State rides order.metadata (Medusa-first, no new table)
  // and the normalizer derives pickup_appointment_state from it for both sides + agents.
  const pickupAppointment =
    fulfillmentMethod === 'local_pickup' && body.pickup_appointment?.date && body.pickup_appointment?.window
      ? {
          spot_id: body.pickup_spot_id ?? null,
          date: String(body.pickup_appointment.date),
          window: String(body.pickup_appointment.window),
          status: 'propuesta',
          proposed_by: 'buyer',
          proposed_at: new Date().toISOString(),
          confirmed_at: null,
        }
      : null

  const checkoutSelection = {
    payment_method: effectivePaymentMethod,
    fulfillment_method: fulfillmentMethod,
    pickup_spot_id: body.pickup_spot_id ?? null,
    pickup_appointment: pickupAppointment,
    has_shipping_address: !!body.shipping_address,
    shipping_quote: shippingQuote,
    escrow_mode: useEscrow ? escrowModeSetting : null,
    ...(bundleTier ? {
      bundle_discount: {
        percent_off: bundleTier.percent_off,
        discount_cents: bundleDiscountCents,
        item_count: itemCount,
        tier_min_items: bundleTier.min_items,
      },
    } : {}),
    ...(couponInfo ? { coupon: couponInfo } : {}),
    ...(supportMetadata ? { support: supportMetadata } : {}),
  }

  try {
    await cartService.updateCarts(cartId, {
      ...(body.shipping_address ? { shipping_address: medusaAddress(body.shipping_address) as any } : {}),
      metadata: {
        ...((cart as any).metadata ?? {}),
        checkout_selection: checkoutSelection,
        payment_method: effectivePaymentMethod,
        ...(manualPaymentSnapshot ? { manual_payment: manualPaymentSnapshot } : {}),
        fulfillment_method: fulfillmentMethod,
        ...(useEscrow ? { escrow_mode: escrowModeSetting } : {}),
        ...(bundleTier ? {
          bundle_discount_pct: bundleTier.percent_off,
          bundle_discount_cents: bundleDiscountCents,
        } : {}),
        // Carried onto the order (cart.metadata → order.metadata) so the
        // order.placed subscriber can register coupon usage exactly once.
        ...(couponInfo ? { coupon: couponInfo } : {}),
        ...(shippingQuote ? {
          shipping_rate_id: shippingQuote.rate_id,
          shipping_carrier: shippingQuote.carrier,
          shipping_service: shippingQuote.service,
          shipping_amount_cents: shippingQuote.amount_cents,
          shipping_currency: shippingQuote.currency,
          shipping_delivery_estimate: shippingQuote.delivery_estimate,
          shipping_delivery_label: shippingQuote.delivery_label,
        } : {}),
        ...(body.pickup_spot_id ? { pickup_spot_id: body.pickup_spot_id } : {}),
        ...(pickupAppointment ? { pickup_appointment: pickupAppointment } : {}),
        // Rental booking block (dates + itemized deposit) — read back by the order
        // normalizer (S1.3) so both sides + agents see the breakdown w/o arithmetic.
        ...(rentalBooking ? { rental_booking: rentalBooking } : {}),
        ...(body.seller_id ? { seller_id: body.seller_id } : {}),
        ...(body.offer_id ? { offer_id: body.offer_id } : {}),
        ...(supportMetadata ? {
          support: supportMetadata,
          support_amount_cents: supportCheckout?.amount_cents,
          support_visibility: supportCheckout?.visibility,
          channel: supportCheckout?.channel,
        } : {}),
        // Own-channel attribution + return target (see originDomain above).
        ...(originDomain ? { origin_domain: originDomain, ...(supportMetadata ? {} : { channel: 'custom_domain' }) } : {}),
      },
    } as any)
  } catch (e) {
    console.error('[start-checkout] cart selection update failed:', e)
  }

  // ── Attach a Medusa shipping method ───────────────────────────────────────
  // completeCart rejects carts whose items require shipping but have no shipping
  // method — this hit every pickup/SPEI/coordinated checkout. We add the seeded
  // option that matches the chosen fulfillment method, with an explicit amount
  // (the quoted rate for shipping, $0 for pickup/coordinated/digital) so we don't
  // depend on the calculated-price provider call.
  try {
    const optionIds = await resolveShippingOptionIds(req.scope)
    const optionKey = OPTION_KEY_BY_METHOD[fulfillmentMethod] ?? 'coord'
    const shippingOptionId = optionIds[optionKey] ?? optionIds.coord
    if (shippingOptionId) {
      const methodAmount = fulfillmentMethod === 'shipping' ? shippingCents : 0
      await (cartService as any).addShippingMethods(cartId, [{
        name: SHIPPING_METHOD_LABEL[optionKey] ?? 'Entrega',
        amount: methodAmount,
        shipping_option_id: shippingOptionId,
        data: {},
      }])
    } else {
      console.warn('[start-checkout] no seeded shipping option found — run /internal/setup-fulfillment')
    }
  } catch (e) {
    console.error('[start-checkout] addShippingMethods failed:', e)
  }

  // D8: a counter or link buyer lands on a neutral thank-you page; the webhook (and the
  // reconcile cron) completes the cart, never this redirect.
  const successUrl = serverCartSource
    ? `${SITE_URL}/pago/listo?cart_id=${cartId}`
    : `${SITE_URL}/payment/success?cart_id=${cartId}`
  const cancelUrl = serverCartSource
    ? `${SITE_URL}/pago/listo?cart_id=${cartId}&estado=cancelado`
    : supportCheckout
    ? `${SITE_URL}/s/${seller.slug}?payment=cancelled`
    : `${SITE_URL}/l/${productId ?? cartId}?payment=cancelled`
  const paymentProductTitle = supportCheckout ? `Apoyo para ${seller.name}` : productTitle
  const paymentProductImage = supportCheckout ? null : productImage

  let providerData: Record<string, unknown> = {}
  let counterMpToken: string | null = null
  let redirectUrl: string | null = null
  let providerId = 'pp_system_default'

  // ── Manual ("Pago directo": SPEI / DiMo / cash) ───────────────────────────
  // Snapshot was already computed + validated above; route to the unified manual
  // provider. Legacy pp_spei/pp_cash remain registered for in-flight orders.
  if (isManual) {
    providerData = {
      payment_method: 'manual',
      manual_payment: manualPaymentSnapshot,
      payment_received: false,
    }
    redirectUrl = null
    providerId = 'pp_manual_manual'
  }

  // ── Stripe Connect ────────────────────────────────────────────────────────
  else if (body.provider === 'stripe') {
    // Platform kill-switch: this is the real enforcement point. The frontend
    // hides Stripe when `checkout.stripe_enabled` is OFF, but agents/UCP and
    // stale in-flight pages POST here directly — so reject before charging.
    // Fail-open: isEnabled → true if the flag store is unreachable.
    if (!(await isEnabled('checkout.stripe_enabled'))) {
      return res.status(422).json({
        message: 'El pago con tarjeta no está disponible en este momento. Usa otro método de pago.',
        code: 'PAYMENT_METHOD_DISABLED',
      })
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (!stripeKey) return res.status(500).json({ message: 'Stripe not configured' })

    const stripeClient = new Stripe(stripeKey, { apiVersion: '2025-09-30.clover' as any })

    // D15 — ONE strategy decision, taken from the SELLER's market before any Stripe
    // call: MX keeps its destination charge in the platform context, US takes a direct
    // charge in the connected-account context. There is no forked checkout below this
    // line; the plan supplies both the payment_intent_data and the request options.
    //
    // `checkoutRefusalResponse` keeps MX's refusal wire contract byte-identical
    // (422 / SELLER_NOT_CONNECTED / same Spanish copy) because the storefront's
    // BuyButton and CheckoutPayButton branch on that literal code. See its comment.
    // The Region cross-check is only a guard if it is actually given both ids. Passing
    // `seller` and the currency alone left `expected_region_id` undefined, which made
    // the check skip silently at the one call site that matters — a guard that cannot
    // fire is decoration. `resolveRegionIdForMarket` returns null when a market has no
    // configured Region, and a null expectation correctly declines to assert a
    // mismatch rather than refusing every checkout in an unconfigured environment.
    const sellerMarketForRegion = readSellerOperatingMarket(seller).market
    const strategy = planStripeMarketStrategy({
      seller,
      cart_currency: currency,
      cart_region_id: cart.region_id ?? null,
      expected_region_id: sellerMarketForRegion
        ? resolveRegionIdForMarket(sellerMarketForRegion, process.env)
        : null,
    })
    if (!strategy.ok) {
      const refusal = checkoutRefusalResponse(strategy)
      return res.status(refusal.status).json(refusal.body)
    }
    const sellerStripeAccountId = strategy.account_id

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: priceCents,
        product_data: {
          name: paymentProductTitle,
          ...(paymentProductImage ? { images: [paymentProductImage] } : {}),
        },
      },
    }]
    if (shippingQuote && shippingCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency,
          unit_amount: shippingCents,
          product_data: {
            name: `Envío - ${shippingQuote.carrier.toUpperCase()} ${shippingQuote.service}`,
          },
        },
      })
    }

    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      // D8: just over Stripe's 30-minute minimum (see COUNTER_CHECKOUT_TTL_MS).
      ...(isCounterCart ? { expires_at: Math.floor((Date.now() + COUNTER_CHECKOUT_TTL_MS) / 1000) } : {}),
      line_items: lineItems,
      // MX: transfer_data + application_fee_amount (destination charge, platform context).
      // US: empty — a direct charge carries no transfer and no application fee; the
      // connected account is addressed through request options instead.
      payment_intent_data: {
        ...strategy.payment_intent_data,
        // Escrow: hold funds until buyer confirms delivery or auto-confirm window elapses
        ...(useEscrow ? { capture_method: 'manual' } : {}),
      },
      customer_email: body.buyer_email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        cart_id: cartId,
        product_id: productId ?? '',
        seller_id: seller?.id ?? '',
        payment_method: 'stripe',
        ...(serverCartSource ? { source: serverCartSource } : {}),
        ...(paymentLinkId ? { payment_link_id: paymentLinkId } : {}),
        fulfillment_method: fulfillmentMethod,
        // Webhook routing context (D15). A direct-charge event must arrive with
        // `event.account` equal to this account; a destination-charge event must
        // carry none. `webhookMatchesPaymentContext` reads exactly these two keys.
        stripe_strategy: strategy.strategy,
        stripe_account_id: strategy.account_id,
        ...(supportMetadata ? {
          checkout_kind: 'support',
          channel: supportMetadata.channel,
          support_amount_cents: String(supportMetadata.amount_cents),
          support_visibility: supportMetadata.visibility,
        } : {}),
        ...(useEscrow ? { escrow_mode: escrowModeSetting } : {}),
        ...(shippingQuote ? {
          shipping_rate_id: shippingQuote.rate_id,
          shipping_carrier: shippingQuote.carrier,
          shipping_service: shippingQuote.service,
          shipping_amount_cents: String(shippingQuote.amount_cents),
          shipping_currency: shippingQuote.currency,
          shipping_delivery_estimate: shippingQuote.delivery_estimate == null ? '' : String(shippingQuote.delivery_estimate),
          shipping_delivery_label: shippingQuote.delivery_label ?? '',
        } : {}),
        ...(body.pickup_spot_id ? { pickup_spot_id: body.pickup_spot_id } : {}),
        ...(body.offer_id ? { offer_id: body.offer_id } : {}),
        // Rental reconciliation (Stripe metadata values must be strings).
        ...(rentalBooking ? {
          rental_check_in: rentalBooking.check_in,
          rental_check_out: rentalBooking.check_out,
          rental_total_cents: String(rentalBooking.total_cents),
          rental_deposit_cents: String(rentalBooking.deposit_cents),
        } : {}),
      },
    }, strategy.request_options)

    providerData = {
      // Durable payment context (D15): every later lifecycle call — capture, cancel,
      // expire, refund, reconcile, webhook — rebuilds its Stripe request context from
      // these keys rather than re-deriving the market from the seller, which may have
      // changed. `stripe_seller_account` is retained as the legacy alias so sessions
      // created before this change still read back correctly.
      ...buildStripePaymentContext(strategy, { stripe_session_id: session.id }),
      stripe_seller_account: sellerStripeAccountId,
      redirect_url: session.url!,
      ...(supportMetadata ? {
        checkout_kind: 'support',
        support: {
          amount_cents: supportMetadata.amount_cents,
          currency: supportMetadata.currency,
          visibility: supportMetadata.visibility,
          channel: supportMetadata.channel,
        },
      } : {}),
      ...(useEscrow ? { escrow_mode: escrowModeSetting } : {}),
    }
    redirectUrl = session.url!
    providerId = 'pp_stripe-connect_stripe-connect'
  }

  // ── MercadoPago ───────────────────────────────────────────────────────────
  else if (body.provider === 'mercadopago') {
    if (!sellerMpConnected(seller)) {
      return res.status(422).json({
        message: 'Este vendedor aún no ha conectado Mercado Pago.',
        code: 'SELLER_MP_NOT_CONNECTED',
      })
    }

    const sellerMpToken = await resolveSellerMpToken(sellerService, seller)
    counterMpToken = sellerMpToken
    if (!sellerMpToken) {
      return res.status(422).json({
        message: 'La conexión de Mercado Pago del vendedor expiró. Pídele que la reconecte.',
        code: 'MP_TOKEN_EXPIRED',
      })
    }

    const mpItems = [{
        id: productId ?? cartId,
        title: paymentProductTitle,
        quantity: 1,
        unit_price: priceCents / 100,
        currency_id: currency.toUpperCase(),
      }]
    if (shippingQuote && shippingCents > 0) {
      mpItems.push({
        id: `${productId ?? cartId}-shipping`,
        title: `Envío - ${shippingQuote.carrier.toUpperCase()} ${shippingQuote.service}`,
        quantity: 1,
        unit_price: shippingCents / 100,
        currency_id: currency.toUpperCase(),
      })
    }

    // 0% platform fee by default (MP marketplace_fee is an absolute amount).
    const marketplaceFee = Math.round(checkoutTotalCents * MP_MARKETPLACE_FEE_RATE) / 100

    // Canonical Checkout Pro marketplace preference — minimal + to MP spec.
    // Deliberately NO `payer`: pre-setting payer.email makes MP lock the email on
    // the hosted page and can leave the "Pagar" button disabled when the buyer
    // pays with a different MP account. Checkout Pro collects the payer itself.
    const prefPayload = {
      items: mpItems,
      ...(marketplaceFee > 0 ? { marketplace_fee: marketplaceFee } : {}),
      notification_url: `${SITE_URL}/api/webhooks/mercadopago?seller_id=${encodeURIComponent(seller.id)}`,
      external_reference: cartId,
      statement_descriptor: 'MIYAGI SANCHEZ',
      back_urls: {
        success: successUrl,
        failure: cancelUrl,
        pending: successUrl,
      },
      auto_return: 'approved',
      // D8: a counter QR is paid within minutes or not at all; an expired preference
      // cannot be paid after the merchant has walked away from the sale.
      ...(isCounterCart ? {
        expires: true,
        expiration_date_to: new Date(Date.now() + COUNTER_CHECKOUT_TTL_MS).toISOString(),
      } : {}),
      metadata: {
        cart_id: cartId,
        product_id: productId ?? '',
        seller_id: seller?.id ?? '',
        payment_method: 'mercadopago',
        ...(serverCartSource ? { source: serverCartSource } : {}),
        ...(paymentLinkId ? { payment_link_id: paymentLinkId } : {}),
        fulfillment_method: fulfillmentMethod,
        ...(supportMetadata ? {
          checkout_kind: 'support',
          channel: supportMetadata.channel,
          support_amount_cents: String(supportMetadata.amount_cents),
          support_visibility: supportMetadata.visibility,
        } : {}),
        ...(shippingQuote ? {
          shipping_rate_id: shippingQuote.rate_id,
          shipping_carrier: shippingQuote.carrier,
          shipping_service: shippingQuote.service,
          shipping_amount_cents: String(shippingQuote.amount_cents),
          shipping_currency: shippingQuote.currency,
          shipping_delivery_estimate: shippingQuote.delivery_estimate == null ? '' : String(shippingQuote.delivery_estimate),
          shipping_delivery_label: shippingQuote.delivery_label ?? '',
        } : {}),
        ...(body.pickup_spot_id ? { pickup_spot_id: body.pickup_spot_id } : {}),
        ...(body.offer_id ? { offer_id: body.offer_id } : {}),
        // Rental reconciliation (kept string-typed to match the Stripe block).
        ...(rentalBooking ? {
          rental_check_in: rentalBooking.check_in,
          rental_check_out: rentalBooking.check_out,
          rental_total_cents: String(rentalBooking.total_cents),
          rental_deposit_cents: String(rentalBooking.deposit_cents),
        } : {}),
      },
    }

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sellerMpToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(prefPayload),
    })
    const pref = await mpRes.json()

    if (!pref.id) {
      console.error('[start-checkout] MP preference creation failed:', pref)
      return res.status(500).json({ message: 'No se pudo crear la preferencia de pago.' })
    }

    const isDev = process.env.NODE_ENV !== 'production'
    const checkoutUrl = isDev ? pref.sandbox_init_point : pref.init_point

    providerData = {
      mp_preference_id: pref.id,
      redirect_url: checkoutUrl,
      ...(supportMetadata ? {
        checkout_kind: 'support',
        support: {
          amount_cents: supportMetadata.amount_cents,
          currency: supportMetadata.currency,
          visibility: supportMetadata.visibility,
          channel: supportMetadata.channel,
        },
      } : {}),
    }
    redirectUrl = checkoutUrl
    providerId = 'pp_mercadopago_mercadopago'
  }

  // ── Create Medusa PaymentCollection + PaymentSession ─────────────────────
  // ── Counter: one checkout, fenced (D8/D9) ──────────────────────────────────
  const counterRef = isCounterCart
    ? (providerId === 'pp_stripe-connect_stripe-connect' ? (providerData.stripe_session_id as string | undefined)
      : providerId === 'pp_mercadopago_mercadopago' ? (providerData.mp_preference_id as string | undefined)
      : 'manual')
    : undefined
  const expireCreated = async () => {
    if (counterRef && counterRef !== 'manual') {
      await expireCounterCheckout(providerId, counterRef, providerData, counterMpToken).catch((err) =>
        console.error('[start-checkout] could not expire a refused counter checkout', counterRef, err))
    }
  }
  let counterMark: string | null = null
  let counterLinkedCollectionId: string | null = null
  if (isCounterCart) {
    counterMark = await openCounterCheckout(req, cartId)
    if (!counterMark) {
      await expireCreated()
      return serverClaim!.status !== 'awaiting_payment'
        ? res.status(409).json({ code: 'SALE_CLOSED', message: 'Esta venta ya no se puede cobrar.' })
        : res.status(409).json({ code: 'CHECKOUT_EXISTS', message: 'Este cobro ya tiene un pago abierto.' })
    }
  }

  try {
    const paymentCollection = await paymentService.createPaymentCollections({
      currency_code: currency,
      amount: checkoutTotalCents,
    })

    // createPaymentSession accepts a single session DTO (singular method name in v2)
    const paymentSession = await (paymentService as any).createPaymentSession(
      paymentCollection.id,
      {
        provider_id: providerId,
        data: providerData,
        amount: checkoutTotalCents,
        currency_code: currency,
        context: {},
      }
    )

    // Patch the Stripe session metadata with the Medusa session ID (for webhook correlation)
    if (body.provider === 'stripe' && providerData.stripe_session_id) {
      // REQUIRED, not best-effort: the stripe-connect provider authorizes only a Checkout
      // Session whose `metadata.medusa_payment_session_id` is THIS payment session
      // (src/lib/stripe-authorization.ts — the binding that stops one paid session being
      // replayed onto another cart). A session we cannot bind could take the buyer's
      // money and never become an order, so it is expired and the checkout refused.
      // Request options address the account the session lives on (US direct charges are
      // on the seller's connected account; the old platform-only update failed there).
      const stripeCtx = readStripePaymentContext(providerData)
      const stripeOpts = stripeCtx ? stripeRequestOptions(stripeCtx) : undefined
      const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-09-30.clover' as any })
      try {
        await stripeClient.checkout.sessions.update(providerData.stripe_session_id as string, {
          metadata: {
            cart_id: cartId,
            medusa_payment_session_id: paymentSession.id,
          },
        }, stripeOpts)
      } catch (bindError) {
        await stripeClient.checkout.sessions.expire(providerData.stripe_session_id as string, {}, stripeOpts).catch(() => {})
        throw bindError
      }
    }

    // Link the payment collection to the cart. cart ↔ payment_collection is a
    // *module link* (it lives in the Link module, not as a column on either
    // entity), so it MUST be created via the Link service — exactly as Medusa's
    // own createPaymentCollectionForCartWorkflow does. The previous
    // `cartService.setPaymentCollection?.()` was a no-op (no such method on the
    // v2 Cart service), so the collection was created but never attached. Without
    // this link, POST /complete fails with "Payment collection has not been
    // initiated for cart" — payment succeeds at the provider but no Medusa order
    // is ever created. A failure here throws into the catch below (502) rather
    // than handing the buyer a payment we can never turn into an order.
    const remoteLink = req.scope.resolve(ContainerRegistrationKeys.LINK)
    await remoteLink.create({
      [Modules.CART]: { cart_id: cartId },
      [Modules.PAYMENT]: { payment_collection_id: paymentCollection.id },
    })
    counterLinkedCollectionId = isCounterCart ? paymentCollection.id : null

    const responseBody: Record<string, unknown> = {
      redirect_url: redirectUrl,
      cart_id: cartId,
      payment_session_id: paymentSession.id,
    }
    // For manual payments: include the full instruction snapshot so the success
    // page can show every configured method (SPEI / DiMo / cash) at once.
    if (isManual) {
      responseBody.payment_method = 'manual'
      responseBody.manual_payment = manualPaymentSnapshot
    }
    // For escrow: include the mode so frontend can show escrow badge
    if (useEscrow) {
      responseBody.escrow_mode = escrowModeSetting
    }
    // Bundle discount applied
    if (bundleTier) {
      responseBody.bundle_discount = {
        percent_off: bundleTier.percent_off,
        discount_cents: bundleDiscountCents,
        item_count: itemCount,
      }
    }
    // Coupon applied
    if (couponInfo) {
      responseBody.coupon = couponInfo
    }
    if (supportMetadata) {
      responseBody.support = {
        amount_cents: supportMetadata.amount_cents,
        currency: supportMetadata.currency,
        visibility: supportMetadata.visibility,
        channel: supportMetadata.channel,
      }
    }
    if (isCounterCart && counterMark && counterRef) {
      if (!(await fenceCounterCheckout(req, cartId, counterMark, providerId, counterRef))) {
        // A cancel won while we were creating this checkout: it must not stay payable.
        await expireCreated()
        return res.status(409).json({ code: 'SALE_CLOSED', message: 'Esta venta ya no se puede cobrar.' })
      }
    }
    return res.json(responseBody)
  } catch (e) {
    console.error('[start-checkout] Medusa payment session error:', e)
    if (isCounterCart && counterMark) {
      await expireCreated()
      // Unlink a collection this failed attempt attached, or the next attempt would be
      // refused as CHECKOUT_EXISTS forever (codex, PR 218).
      if (counterLinkedCollectionId) {
        await req.scope.resolve(ContainerRegistrationKeys.LINK).dismiss({
          [Modules.CART]: { cart_id: cartId },
          [Modules.PAYMENT]: { payment_collection_id: counterLinkedCollectionId },
        }).catch((err: unknown) => console.error('[start-checkout] could not unlink a failed counter collection', err))
      }
      await releaseCounterCheckout(req, cartId, counterMark).catch(() => {})
    }
    // Fail loudly: without a Medusa PaymentSession the cart can never be
    // completed into an order, so reconciliation can't recover it either.
    // Never hand the buyer a redirect to a payment we can't track — let them
    // retry (the orphaned provider session simply expires).
    return res.status(502).json({
      message: 'No se pudo inicializar el pago de forma segura. Intenta de nuevo en un momento.',
      code: 'PAYMENT_SESSION_FAILED',
    })
  }
}
