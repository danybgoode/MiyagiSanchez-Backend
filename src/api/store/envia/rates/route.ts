/**
 * POST /store/envia/rates
 *
 * Quotes Envia.com shipping rates for a listing.
 * All Envia API calls originate from this backend route — the Next.js
 * checkout/shipping-rates route proxies here.
 *
 * No auth required — rate quoting is public commerce functionality.
 *
 * Body:
 *   listingId   string          Medusa product ID
 *   items?      string[]        Multiple listing IDs (bundle)
 *   address     {
 *     name, phone, line1, line2,
 *     city, state, state_code, postal_code
 *   }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { quoteShipments, mapEnviaError, type EnviaAddress, type EnviaPackage } from '../../../../modules/fulfillment-envia/envia-client'
import { toEnviaStateCode } from '../../../../modules/fulfillment-envia/mx-state-codes'
import { isEnabled } from '../../../../lib/flags'
import { enviaKillGate, ENVIA_ARRANGED_DELIVERY_MESSAGE } from '../../../../lib/envia-killswitch'
import { correosGate } from '../../../../lib/correos-gate'
import { quoteCorreosForPieces } from '../../../../lib/correos-tariff'
import { resolveSellerProductIds } from '../../_utils/seller-catalog-query'
import { shippingQuoteKey, signShippingRate } from '../../../../lib/shipping-quote-signature'

const DEFAULT_CARRIERS = ['dhl', 'fedex', 'estafeta', 'ups', 'redpack', 'paquetexpress']

/**
 * Correos de México — Impresos en General, a flat NATIONAL rate (no zones, no
 * carrier lookup). Sprint 3 (shipping-provider-expansion): appended to the same
 * quote seam as Envía, but independent of it — no funding gate, no comp-grant.
 */
const CORREOS_DELIVERY_LABEL = 'Económico · 4–10 días · sin rastreo'

type NormalizedRate = {
  id: string
  rateId: string
  carrier: string
  service: string
  baseAmountCents: number
  handlingFeeCents: number
  amountCents: number
  currency: string
  deliveryEstimate: number | null
  deliveryLabel: string | null
  logoUrl: string | null
}

function buildCorreosRate(totalCents: number): NormalizedRate {
  return {
    id: 'correos:impresos:flat',
    rateId: 'correos_impresos_flat',
    carrier: 'correos_mx',
    service: 'Económico',
    baseAmountCents: totalCents,
    handlingFeeCents: 0,
    amountCents: totalCents,
    currency: 'MXN',
    deliveryEstimate: null,
    deliveryLabel: CORREOS_DELIVERY_LABEL,
    logoUrl: null,
  }
}

type IncomingAddress = {
  name?: string
  phone?: string
  /** Street name only */
  line1?: string
  /** Exterior number */
  ext_number?: string
  /** Interior number */
  int_number?: string
  /** Colonia */
  line2?: string
  /** Alcaldía / municipio */
  city?: string
  state?: string
  state_code?: string
  postal_code?: string
}

type ShippingSettings = {
  envia_enabled?: boolean
  /** Correos de México Impresos opt-in (Sprint 3, Story 3.2) — sibling key to envia_enabled. */
  correos_enabled?: boolean
  allowed_carriers?: string[]
  rate_display?: 'recommended' | 'cheapest' | 'all'
  handling_fee_cents?: number
  package_defaults?: {
    weight_grams?: number
    length_cm?: number
    width_cm?: number
    height_cm?: number
  }
  origin_address?: {
    name?: string | null
    street?: string | null
    number?: string | null
    colonia?: string | null
    city?: string | null
    state?: string | null
    state_code?: string | null
    postal_code?: string | null
  }
}

function addressReady(a: IncomingAddress) {
  return Boolean(
    a.name?.trim() &&
    a.line1?.trim() &&          // street name
    a.ext_number?.trim() &&     // exterior number (required for label)
    a.city?.trim() &&
    (a.state_code?.trim() || a.state?.trim()) &&
    a.postal_code?.trim()
  )
}

function deliveryLabel(days: number | null) {
  if (!days || days <= 0) return null
  return days === 1 ? '1 dia habil' : `${days} dias habiles`
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const [enviaEnabled, correosEnabled] = await Promise.all([
    isEnabled('shipping.envia_enabled'),
    isEnabled('shipping.correos_enabled'),
  ])

  const body = req.body as {
    listingId?: string
    items?: string[]
    address?: IncomingAddress
  }

  const listingIds: string[] = body.items?.length
    ? body.items
    : body.listingId
      ? [body.listingId]
      : []

  const remoteQuery = req.scope.resolve('remoteQuery') as any
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  // ── Resolve products + seller UP FRONT — Sprint 2 needs the seller's
  // metadata.envia_grant before the kill-switch decision below, since a
  // granted seller must ride Envía even while the platform flag is OFF. A
  // malformed request (no listingId, unknown product) can't resolve a seller,
  // so this silently no-ops and the route falls through to the platform-flag-
  // only decision — preserving byte-identical OFF+ungranted fallback behavior
  // regardless of request validity, same as before this widening. ─────────────
  let products: any[] = []
  let productLookupFailed = false
  if (listingIds.length) {
    try {
      const { data } = await remoteQuery.graph({
        entity: 'product',
        fields: ['id', 'title', 'metadata', 'variants.metadata', 'variants.prices.*'],
        filters: { id: listingIds },
      })
      products = data ?? []
    } catch (err) {
      console.error('[envia/rates] product lookup failed:', err)
      productLookupFailed = true
    }
  }

  // Filter to physical products (listing_type = product)
  const shippable = products.filter((p: any) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>
    const t = meta.listing_type as string | undefined
    return !t || t === 'product'
  })

  // ── Resolve seller + shipping settings via first product ──────────────────
  let sellerMeta: Record<string, unknown> = {}
  if (shippable.length) {
    try {
      const allSellers = await sellerService.listSellers({}, { take: 1000 })
      // Find which seller owns the first product
      for (const seller of allSellers) {
        const productIds = await resolveSellerProductIds(req.scope, seller.id)
        if (productIds.has(shippable[0].id)) {
          sellerMeta = (seller.metadata ?? {}) as Record<string, unknown>
          break
        }
      }
    } catch (err) {
      console.warn('[envia/rates] seller lookup failed:', err)
    }
  }

  const sellerGranted = Boolean(sellerMeta.envia_grant)

  // ── Shipping settings, resolved EARLY (Sprint 3) — the Correos eligibility
  // check below needs shipping.correos_enabled before deciding whether the
  // Envía-blocked early-return should still fire. ───────────────────────────
  const settings = (sellerMeta.settings ?? {}) as Record<string, unknown>
  const shipping = (settings.shipping ?? {}) as ShippingSettings

  const correosSellerEligible = !correosGate({
    correosEnabled,
    sellerOptIn: shipping.correos_enabled === true,
  }).blocked

  const enviaBlocked = enviaKillGate({ enviaEnabled, sellerGranted }).blocked

  // Platform Envía kill-switch (shipping.envia_enabled, default OFF / fail-open),
  // widened by a per-seller comp grant (Sprint 2: seller.metadata.envia_grant).
  // Sprint 3: Correos is a WHOLLY INDEPENDENT provider (no funding gate, no
  // grant) — a Correos-eligible seller must still be priced even when Envía is
  // fully blocked, so only short-circuit BEFORE any address/product validation
  // when NEITHER provider can quote. This is the real enforcement — UCP/MCP/
  // agent + stale checkout pages proxying here inherit it.
  if (enviaBlocked && !correosSellerEligible) {
    return res.json({ rates: [], package_count: 0, message: ENVIA_ARRANGED_DELIVERY_MESSAGE })
  }

  if (!body.address || !addressReady(body.address)) {
    return res.status(422).json({ error: 'Completa la dirección de entrega.' })
  }

  if (!listingIds.length) {
    return res.status(400).json({ error: 'listingId o items requerido.' })
  }

  if (productLookupFailed) {
    return res.status(404).json({ error: 'Anuncio no encontrado.' })
  }

  if (!shippable.length) {
    return res.status(422).json({ error: 'Ningún artículo requiere envío por paquetería.' })
  }

  // Every rate leaves this route SIGNED (lib/shipping-quote-signature.ts): start-checkout charges a
  // shipping price only when the signature verifies, so the amount cannot be named by the caller.
  // Bound to the products asked about + the destination postcode (no cart exists yet at quote time).
  // No usable server secret => no signature => checkout refuses the rate (fails closed).
  const quoteKey = shippingQuoteKey(process.env)
  const nowMs = Date.now()
  const signRates = <T extends NormalizedRate>(rates: T[]) => rates.map((r) => ({
    ...r,
    signature: signShippingRate(
      quoteKey,
      { rate_id: r.rateId, carrier: r.carrier, service: r.service, amount_cents: r.amountCents, currency: r.currency },
      { productIds: listingIds, postalCode: body.address?.postal_code },
      nowMs,
    ),
  }))

  const pkgDefaults = shipping.package_defaults ?? {}
  const handlingFeeCents = Math.max(0, Math.round(shipping.handling_fee_cents ?? 0))
  const rateDisplay = shipping.rate_display ?? 'recommended'

  // Per-item weights, in grams — feeds Correos' quote (Story 3.1's
  // quoteCorreosForPieces), computed alongside the per-product Envía packages
  // below (same weight resolution). The Impresos tariff is priced "por pieza"
  // (per piece), NOT by combined cart weight — quoteCorreosForPieces quotes
  // each item separately and sums the totals (cross-review catch: summing
  // weights first would wrongly undercharge or reject an eligible multi-item
  // order once the SUM crossed the 2000 g table max, even though each
  // individual piece was well within it).
  const itemWeightsGrams: number[] = []

  const packages: EnviaPackage[] = shippable.map((p: any) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>
    // Number(...) tolerates a numeric-string metadata value the same way the
    // Envía `weight / 1000` arithmetic below already implicitly coerced it —
    // without this, a string weight silently passed Number.isFinite() as
    // false in quoteCorreosForPieces and hid Correos with no error
    // (cross-review catch: Envía and Correos would have read the identical
    // stored value inconsistently).
    const rawWeight = Number((meta.weight_grams as number | string | undefined) ?? pkgDefaults.weight_grams ?? 500)
    const weightGrams = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 500
    itemWeightsGrams.push(weightGrams)
    // Max price across all variants — a multi-variant (configurator) listing's
    // declared value should reflect its most expensive combination, not
    // whichever variant happens to be first. Excludes any variant flagged
    // metadata.disabled (defensive; nothing sets this today — mirrors the
    // same filter in listing.ts/price-grid route).
    const priceVariant = ((p.variants ?? []) as any[])
      .filter((v) => v?.metadata?.disabled !== true)
      .flatMap((v) => (v?.prices ?? []) as Array<{ amount?: number; currency_code?: string }>)
      // MXN only — mixing currencies into one max() would compare, e.g., a
      // 50 USD price against a 1000 MXN price as raw integers, producing a
      // meaningless declared value (cross-agent review catch, 2026-07-05).
      .filter((pr) => pr?.currency_code === 'mxn')
      .reduce((max: number | undefined, pr) =>
        typeof pr?.amount === 'number' && (max === undefined || pr.amount > max) ? pr.amount : max,
        undefined as number | undefined)
    return {
      content: String(p.title ?? 'Producto').slice(0, 80),
      weight: Math.max(0.1, weightGrams / 1000),
      declaredValue: priceVariant ? Math.round(priceVariant / 100) : 0,
      dimensions: {
        length: Math.max(1, pkgDefaults.length_cm ?? 20),
        width:  Math.max(1, pkgDefaults.width_cm  ?? 15),
        height: Math.max(1, pkgDefaults.height_cm ?? 10),
      },
    }
  })

  const correosQuote = correosSellerEligible ? quoteCorreosForPieces(itemWeightsGrams) : null
  const correosRate = correosQuote ? buildCorreosRate(correosQuote.totalCents) : null

  // ── Envía blocked (platform OFF + ungranted): Correos was already
  // established eligible above (else the byte-identical fallback already
  // returned) — respond Correos-only, never touch the Envía API. ───────────
  if (enviaBlocked) {
    return res.json(
      correosRate
        ? { rates: signRates([correosRate]), package_count: packages.length }
        : { rates: [], package_count: packages.length, message: ENVIA_ARRANGED_DELIVERY_MESSAGE },
    )
  }

  // ── Envía live from here on — original flow, unchanged, plus Correos
  // appended AFTER the price sort/slice below (never inserted by price: the
  // frontend blindly pre-selects rates[0], so a cheap Correos rate must never
  // land ahead of a faster live-quoted carrier). ────────────────────────────
  const originRaw = shipping.origin_address
  if (shipping.envia_enabled === false) {
    return res.status(422).json({ error: 'El vendedor no tiene envío a domicilio activo.' })
  }
  if (!originRaw?.street || !originRaw.city || !originRaw.postal_code) {
    return res.status(422).json({ error: 'El vendedor todavía no completó su dirección de origen. Coordina la entrega directamente.' })
  }
  if (!originRaw.state && !originRaw.state_code) {
    return res.status(422).json({ error: 'El vendedor todavía no completó su dirección de origen. Coordina la entrega directamente.' })
  }

  const origin: EnviaAddress = {
    name: originRaw.name ?? 'Vendedor',
    street: originRaw.street,
    number: originRaw.number ?? undefined,
    district: originRaw.colonia ?? undefined,
    city: originRaw.city,
    state: toEnviaStateCode(originRaw.state_code ?? originRaw.state ?? ''),
    country: 'MX',
    postalCode: originRaw.postal_code,
  }

  const destStateCode = body.address.state_code
    ? body.address.state_code
    : toEnviaStateCode(body.address.state ?? '')

  const destination: EnviaAddress = {
    name: body.address.name ?? 'Comprador',
    phone: body.address.phone,
    street: body.address.line1 ?? '',
    number: body.address.ext_number ?? undefined,
    district: body.address.line2,   // colonia
    city: body.address.city ?? '',  // alcaldía / municipio (region_2)
    state: destStateCode,
    country: 'MX',
    postalCode: body.address.postal_code ?? '',
  }

  const carriers = shipping.allowed_carriers?.length ? shipping.allowed_carriers : DEFAULT_CARRIERS

  try {
    const rates = await quoteShipments({ origin, destination, carriers, packages })

    const normalized = rates
      .filter(r => r.rateId && r.carrier && r.service && r.totalPrice > 0)
      .map(r => ({
        id: `${r.carrier}:${r.service}:${r.rateId}`,
        rateId: r.rateId,
        carrier: r.carrier,
        service: r.service,
        baseAmountCents: Math.round(r.totalPrice * 100),
        handlingFeeCents,
        amountCents: Math.round(r.totalPrice * 100) + handlingFeeCents,
        currency: r.currency || 'MXN',
        deliveryEstimate: r.deliveryEstimate,
        deliveryLabel: deliveryLabel(r.deliveryEstimate),
        logoUrl: r.logoUrl ?? null,
      }))
      .sort((a, b) =>
        a.amountCents !== b.amountCents
          ? a.amountCents - b.amountCents
          : (a.deliveryEstimate ?? 99) - (b.deliveryEstimate ?? 99)
      )

    if (normalized.length === 0) {
      return res.json(
        correosRate
          ? { rates: signRates([correosRate]), package_count: packages.length }
          : { rates: [], package_count: packages.length, message: ENVIA_ARRANGED_DELIVERY_MESSAGE },
      )
    }

    const visible = rateDisplay === 'cheapest'
      ? normalized.slice(0, 1)
      : rateDisplay === 'all'
        ? normalized.slice(0, 8)
        : normalized.slice(0, 3)

    const finalRates = correosRate ? [...visible, correosRate] : visible

    return res.json({ rates: signRates(finalRates), package_count: packages.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[envia/rates] quote failed:', msg)
    return res.status(502).json({ error: mapEnviaError(msg) })
  }
}
