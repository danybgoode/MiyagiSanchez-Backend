/**
 * GET /store/sellers/:slug/checkout-options
 *
 * THE single source of truth for the checkout catalog. Returns, for a seller
 * (+ the listing context passed as query params), which payment methods and
 * delivery methods are available — consolidating logic that used to be
 * duplicated across the PDP page, the checkout page, and the UCP route.
 *
 *   payment_methods  — Medusa region payment providers ∩ the seller's enabled
 *                      set (see resolveSellerPaymentMethods). Each is a real,
 *                      registered Medusa provider.
 *   delivery_methods — derived from the seller's shipping settings: structured
 *                      pickup spots (with hours/scheduling), live shipping
 *                      (Envia), digital, service/rental, or coordinated.
 *
 * Cross-rules folded in here (previously scattered):
 *   - Coordinated-only delivery hides instant card payments (you can't pay a
 *     card for a "we'll arrange it" sale) — only SPEI/cash remain.
 *   - Digital listings hide MercadoPago (digital-goods restriction, preserved).
 *
 * `:slug` may be a seller slug OR a seller id — resolved either way.
 * Query: listing_type=product|digital|service|rental, is_digital=true|false,
 *        delivery_mode=carrier|arranged (arranged-only delivery epic, S1.1 —
 *        gated by shipping.arranged_only_enabled; absent/carrier ⇒ today's behavior)
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { resolveSellerPaymentMethods } from '../../../_utils/payment-methods'
import { buildDeliveryCatalog, type PickupSpot } from '../../../_utils/delivery-catalog'
import { readSellerOperatingMarket } from '../../../../../lib/seller-market'
import { isEnabled } from '../../../../../lib/flags'
import { correosGate } from '../../../../../lib/correos-gate'
import { sellerRowEnforcement } from '../../../../../lib/seller-status'

function processingLabel(value: unknown): string | null {
  const labels: Record<string, string> = {
    '1d': '1 día hábil',
    '1-3d': '1 a 3 días hábiles',
    '3-5d': '3 a 5 días hábiles',
    '1-2w': '1 a 2 semanas',
  }
  return typeof value === 'string' ? (labels[value] ?? value) : null
}

async function resolveRegionProviderIds(req: MedusaRequest): Promise<string[] | undefined> {
  try {
    const regionService: any = req.scope.resolve(Modules.REGION)
    const regions = await regionService.listRegions(
      { currency_code: 'mxn' },
      { relations: ['payment_providers'] },
    )
    const region = regions?.[0]
    const ids: string[] = (region?.payment_providers ?? []).map((p: any) => p.id).filter(Boolean)
    // Only treat the region list as an authoritative gate once it has been
    // migrated to include the real providers (setup-mexico). A region that still
    // only carries pp_system_default is stale — intersecting against it would
    // wrongly hide every method, so we skip the intersection (seller config +
    // module registration remain the binding constraints).
    const REAL = ['pp_stripe-connect_stripe-connect', 'pp_mercadopago_mercadopago', 'pp_spei_spei', 'pp_cash_cash']
    const hasRealProvider = ids.some(id => REAL.includes(id))
    return hasRealProvider ? ids : undefined
  } catch {
    return undefined
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const { slug } = req.params

  // Resolve by slug, then fall back to id (the frontend may pass either).
  let [seller] = await sellerService.listSellers({ slug } as any, { take: 1 })
  if (!seller) {
    const [byId] = await sellerService.listSellers({ id: slug } as any, { take: 1 })
    seller = byId
  }
  const visibility = sellerRowEnforcement(seller)
  if (!seller || !visibility.present || !visibility.admits) {
    return res.status(404).json({ message: `Seller '${slug}' not found` })
  }

  const listingType = (req.query.listing_type as string) || 'product'
  // Print-ad placements fulfill like digital goods (access / no shipping) — map them
  // so card/manual checkout works and the coord-only rule never trips.
  const isDigital = req.query.is_digital === 'true' || listingType === 'digital' || listingType === 'print_ad'
  const deliveryMode = req.query.delivery_mode === 'arranged' ? 'arranged' as const : 'carrier' as const
  // A display hint, like listing_type: start-checkout re-derives "is this an event" from the product itself.
  const isEvent = req.query.is_event === 'true'

  const settings = ((seller.metadata ?? {}) as any).settings ?? {}
  const shipping = (settings.shipping ?? {}) as Record<string, any>
  const orders = (settings.orders ?? {}) as Record<string, any>

  const localPickup = shipping.local_pickup === true
  const pickupSpots: PickupSpot[] = localPickup ? (shipping.pickup_spots ?? []) : []
  const origin = (shipping.origin_address ?? {}) as Record<string, string | null>
  const hasShippingOrigin = !!(origin.street && origin.city && origin.state && origin.postal_code)
  // Correos de México (Sprint 3): independent of Envía's own envia_enabled toggle —
  // a Correos-only seller (Envía off/ungranted) still needs the "shipping" category
  // to appear so the buyer can reach the Correos rate at the quote seam
  // (envia/rates). Origin address stays required for both (v1 simplification —
  // Correos is technically address-independent, but this keeps one setup/UX path).
  const correosPlatformEnabled = await isEnabled('shipping.correos_enabled')
  const correosSellerEligible = !correosGate({
    correosEnabled: correosPlatformEnabled,
    sellerOptIn: shipping.correos_enabled === true,
  }).blocked
  const hasLiveShipping = (shipping.envia_enabled !== false || correosSellerEligible) && hasShippingOrigin
  const preparation = processingLabel(orders.processing_time)
  // Arranged-only delivery (epic, S1.1) — flag OFF or delivery_mode absent/carrier
  // reproduces today's behavior byte-for-byte (see buildDeliveryCatalog).
  const arrangedOnlyEnabled = await isEnabled('shipping.arranged_only_enabled')

  // ── Delivery methods ────────────────────────────────────────────────────
  // The market comes from the SELLER ROW, never from the request (D16 — delivery
  // inputs are server-authoritative). The storefront does send a `market` query
  // param, but it is used only to pick a publishable key on its side; letting it
  // choose the delivery catalog would let any caller ask a Mexican shop for the US
  // vocabulary, and with it a `manual_carrier` method that shop never offered.
  //
  // An UNREADABLE market falls back to `mx`, which is the fail-closed direction
  // here: `mx` is the market with the existing, more restrictive rules, and every
  // seller on the platform today is explicitly `mx`.
  const marketRead = readSellerOperatingMarket(seller)
  const sellerMarket = marketRead.market === 'us' ? 'us' as const : 'mx' as const

  const { deliveryMethods: delivery_methods, onlyCoordinated } = buildDeliveryCatalog({
    listingType,
    isDigital,
    isEvent,
    deliveryMode,
    arrangedOnlyEnabled,
    localPickup,
    pickupSpots,
    hasLiveShipping,
    market: sellerMarket,
  })

  // ── Payment methods (two buckets: online + one consolidated manual) ───────
  const regionProviderIds = await resolveRegionProviderIds(req)
  const stripeEnabled = await isEnabled('checkout.stripe_enabled')
  let { methods: rawMethods } = resolveSellerPaymentMethods(seller, regionProviderIds, { stripeEnabled })

  // Digital goods: MercadoPago restriction (preserved from prior behavior).
  if (isDigital) rawMethods = rawMethods.filter(m => m.id !== 'mercadopago')

  // Coordinated-only delivery: no instant card payment — pay is arranged with
  // delivery. Mirrors the start-checkout 422 guard.
  if (onlyCoordinated) rawMethods = rawMethods.filter(m => !m.instant)

  // Online (instant, escrow-capable) methods stay as-is.
  const onlineMethods = rawMethods
    .filter(m => m.instant)
    .map(m => ({ id: m.id, kind: 'online' as const, label: m.label, note: m.note, instant: true, protected: true }))

  // Manual methods (SPEI / cash) collapse into ONE "Pago directo" method that
  // expands to the seller's structured sub-options — removes the ambiguous,
  // overlapping top-level choices. Cash is a sub-option only with pickup delivery.
  const hasPickup = delivery_methods.some(d => d.id === 'local_pickup')
  const sub_options = rawMethods
    .filter(m => !m.instant)
    .filter(m => m.id !== 'cash' || hasPickup)
    .map(m => ({
      type: m.id === 'spei' ? 'clabe' : m.id,   // 'clabe' | 'cash'
      label: m.id === 'spei' ? 'Transferencia SPEI' : m.label,
      note: m.note,
      requires_pickup: m.id === 'cash',
    }))

  const manualMethod = sub_options.length
    ? [{
        id: 'manual' as const,
        kind: 'manual' as const,
        label: 'Pago directo al vendedor',
        note: 'Acuerdas el pago directamente con el vendedor (sin protección de Miyagi).',
        instant: false,
        protected: false,
        sub_options,
      }]
    : []

  const payment_methods = [...onlineMethods, ...manualMethod]

  // Default: prefer the protected online rails, else manual.
  const ids = new Set(payment_methods.map(m => m.id))
  const payment_default = (['mercadopago', 'stripe', 'manual'] as const).find(id => ids.has(id)) ?? null

  return res.json({
    payment_methods,
    payment_default,
    delivery_methods,
    delivery_default: delivery_methods[0]?.id ?? null,
    only_coordinated: onlyCoordinated,
    preparation,
  })
}
