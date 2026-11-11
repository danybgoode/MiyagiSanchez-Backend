/**
 * Shared seller-product CREATE logic (Medusa product workflow + seller link +
 * inventory provisioning). Used by BOTH the Clerk-authed store route
 * (`POST /store/sellers/me/products`) and the internal service route
 * (`POST /internal/seller-products`, called by the seller's MCP agent) so the
 * product-create path is defined once and can't drift between the two — the
 * create counterpart of `seller-product-update.ts`.
 *
 * Callers are responsible for authentication + resolving the seller BEFORE
 * calling this; this function trusts `sellerId`.
 */

import type { MedusaRequest } from '@medusajs/framework/http'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'
import { createProductsWorkflow, updateProductsWorkflow } from '@medusajs/medusa/core-flows'
import { SELLER_MODULE } from '../../../modules/seller'
import {
  isStockableListingType,
  validateSeatQuantity,
  resolveStockLocationId,
  provisionVariantInventory,
} from './inventory'
import { resolveDefaultShippingProfileId } from './fulfillment'
import { resolveDeliveryModeForWrite } from './delivery-catalog'
import { planProductPublication } from './product-publication'
import SellerModuleService from '../../../modules/seller/service'
import {
  admitSellerProductCreatePrice,
  resolveSellerProductMoneyContext,
} from './product-market-currency'
import type { MarketCode } from '../../../lib/markets'
import { isEnabled } from '../../../lib/flags'

/** Auto-generate a unique SKU for P2P marketplace items. */
export function generateSku(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `MIYAGI-${ts}-${rand}`
}

export interface CreateProductBody {
  title: string
  /** Optional canonical product handle. The supply importer includes its
   * immutable item id here because Medusa handles are global, not per seller. */
  handle?: string
  description?: string | null
  price_cents?: number | null
  currency?: string
  condition?: string | null
  listing_type?: string
  category?: string       // category handle
  state?: string | null
  municipio?: string | null
  location?: string | null
  quantity?: number | null
  weight_grams?: number | null
  /** Initial publish state. Defaults to 'published' (preserves prior behaviour). */
  status?: 'published' | 'draft'
  images?: Array<{ url: string; alt?: string }>
  tags?: string[]
  attrs?: Record<string, unknown>  // type/category-specific attributes (brand, size, color…)
  metadata?: Record<string, unknown>
  /**
   * Priced option dimensions (Tamaño / Material / Acabado, up to 3) for a
   * print-configurator listing. When present, replaces the single
   * "Default"/"Default" variant with the full cartesian product of
   * combinations, each priced via `variant_prices`. Omit for a normal
   * single-variant listing (unchanged default behaviour).
   */
  option_dimensions?: Array<{ title: string; values: string[] }>
  /**
   * Per-combination price in cents (MXN), keyed by `buildVariantComboKey()`
   * (sorted "Title:Value|Title:Value"). Required for every combination when
   * `option_dimensions` is set.
   */
  variant_prices?: Record<string, number>
  /**
   * Unit cost (COGS) in integer centavos MXN, stored on the created variant's
   * `metadata.unit_cost_cents` (seller-private — never surfaced on public
   * reads). Single-variant listings only (the bulk-import path); a
   * dimensioned listing sets per-variant costs after creation via the update
   * route's `variant_id` + `unit_cost_cents` (profit-analyzer S1 · US-1).
   */
  unit_cost_cents?: number | null
  /**
   * Arranged-only delivery (epic, S1.2): 'carrier' (default) or 'arranged' — a
   * listing delivered only by coordination (no carrier, no named pickup spot).
   * `service`/`rental` listings are FORCED to 'arranged' server-side regardless
   * of this value (see createSellerProduct) — checkout-options already treats
   * them as never-carrier-shippable, so an independent choice for those types
   * has no coherent meaning. Only takes effect when
   * shipping.arranged_only_enabled is ON (checkout-options ignores it OFF).
   */
  delivery_mode?: 'carrier' | 'arranged' | null
  /**
   * MARKETPLACE PUBLICATION INTENT, stated by the call site (epic
   * market-architecture-foundation, story 1.3; owned-shop-operating-channel epic,
   * S3.1 for the `null` value below).
   *
   *   omitted  — publish into the SELLER's own operating market. For every seller
   *              that exists today (all `mx`) this is byte-identical to the previous
   *              behaviour.
   *   'mx'     — the same thing, said out loud. Must match the seller's market.
   *   null     — "owned shop only": operating channel alone, no marketplace channel.
   *              Buyable on the shop, absent from every country marketplace. Gated
   *              behind `catalog.owned_shop_only_enabled` (D8) — refused with the
   *              pre-Sprint-3 error while the flag is OFF.
   *
   * A market whose marketplace is not open is REFUSED with an
   * actionable message, never silently downgraded to Mexico's channel. See the header
   * of `product-publication.ts` for the full rule; the operating channel is always
   * attached (D2), so no value of this field ever produces a channel-less product.
   */
  publish_to_market?: MarketCode | null
}

const MAX_OPTION_DIMENSIONS = 3
const MAX_VARIANT_COMBOS = 60

/** Stable, sorted combo key so callers can address a specific variant's price. */
export function buildVariantComboKey(combo: Record<string, string>): string {
  return Object.keys(combo)
    .sort()
    .map((title) => `${title}:${combo[title]}`)
    .join('|')
}

/** Cartesian product of option dimensions → one combo (Title→value map) per variant. */
export function cartesianCombos(
  dimensions: Array<{ title: string; values: string[] }>,
): Array<Record<string, string>> {
  return dimensions.reduce<Array<Record<string, string>>>(
    (combos, dim) =>
      combos.flatMap((combo) => dim.values.map((value) => ({ ...combo, [dim.title]: value }))),
    [{}],
  )
}

export type ValidatedDimensionsResult =
  | { ok: true; dimensions: Array<{ title: string; values: string[] }>; combos: Array<Record<string, string>> }
  | { ok: false; message: string }

/**
 * Validate seller-supplied option dimensions: 1-3 dimensions, non-empty
 * trimmed titles/values, no duplicate titles, no duplicate values within a
 * dimension, and a bounded combo count (guards against an accidental
 * combinatorial explosion, e.g. 3 dimensions × 20 values each).
 */
export function validateOptionDimensions(
  raw: Array<{ title: string; values: string[] }>,
): ValidatedDimensionsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'Se requiere al menos una dimensión de opción (por ejemplo, Tamaño).' }
  }
  if (raw.length > MAX_OPTION_DIMENSIONS) {
    return { ok: false, message: `Máximo ${MAX_OPTION_DIMENSIONS} dimensiones de opción (por ejemplo, Tamaño, Material, Acabado).` }
  }
  const dimensions: Array<{ title: string; values: string[] }> = []
  const seenTitles = new Set<string>()
  for (const dim of raw) {
    const title = dim?.title?.trim().slice(0, 40)
    if (!title) return { ok: false, message: 'Cada dimensión necesita un nombre (por ejemplo, Tamaño).' }
    const titleKey = title.toLowerCase()
    if (seenTitles.has(titleKey)) {
      return { ok: false, message: `La dimensión "${title}" está repetida.` }
    }
    seenTitles.add(titleKey)

    const seenValues = new Set<string>()
    const values: string[] = []
    for (const rawValue of dim.values ?? []) {
      const value = rawValue?.trim().slice(0, 40)
      if (!value) continue
      const valueKey = value.toLowerCase()
      if (seenValues.has(valueKey)) continue
      seenValues.add(valueKey)
      values.push(value)
    }
    if (values.length === 0) {
      return { ok: false, message: `La dimensión "${title}" necesita al menos un valor.` }
    }
    dimensions.push({ title, values })
  }

  const combos = cartesianCombos(dimensions)
  if (combos.length > MAX_VARIANT_COMBOS) {
    return { ok: false, message: `Demasiadas combinaciones (${combos.length}). Máximo ${MAX_VARIANT_COMBOS} — reduce el número de dimensiones o valores.` }
  }
  return { ok: true, dimensions, combos }
}

export type CreateSellerProductResult =
  | { ok: true; product_id: string }
  | { ok: false; status: number; message: string }

/**
 * Create a Medusa product for the given seller and link it. Returns the new
 * product id, or a structured error the caller maps to an HTTP status.
 */
export async function createSellerProduct(
  scope: MedusaRequest['scope'],
  sellerId: string,
  body: CreateProductBody,
): Promise<CreateSellerProductResult> {
  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const remoteLink = scope.resolve(ContainerRegistrationKeys.LINK)

  if (!body.title?.trim() || body.title.trim().length < 3) {
    return { ok: false, status: 400, message: 'title must be at least 3 characters' }
  }

  if (body.unit_cost_cents !== undefined && body.unit_cost_cents !== null
    && (!Number.isInteger(body.unit_cost_cents) || body.unit_cost_cents < 0)) {
    return { ok: false, status: 422, message: 'El costo unitario debe ser un entero en centavos de 0 o más.' }
  }

  const deliveryModeResult = resolveDeliveryModeForWrite({
    listingType: body.listing_type ?? 'product',
    requested: body.delivery_mode,
  })
  if (!deliveryModeResult.ok) {
    return { ok: false, status: 422, message: deliveryModeResult.message }
  }
  const deliveryMode = deliveryModeResult.value

  // ── Priced option dimensions (print-configurator listings) ────────────────
  let dimensions: Array<{ title: string; values: string[] }> | undefined
  let dimensionCombos: Array<Record<string, string>> | undefined
  if (body.option_dimensions !== undefined) {
    const validated = validateOptionDimensions(body.option_dimensions)
    if (!validated.ok) return { ok: false, status: 422, message: validated.message }
    const missingPrice = validated.combos.find((combo) => {
      const price = body.variant_prices?.[buildVariantComboKey(combo)]
      return !(typeof price === 'number' && price > 0)
    })
    if (missingPrice) {
      return { ok: false, status: 422, message: `Falta el precio para la combinación ${buildVariantComboKey(missingPrice)}.` }
    }
    dimensions = validated.dimensions
    dimensionCombos = validated.combos
  }

  // ── Look up category by handle ──────────────────────────────────────────
  let categoryId: string | undefined
  if (body.category) {
    const [cat] = await productService.listProductCategories({ handle: body.category })
    categoryId = cat?.id
  }

  // ── Look up product type by value ────────────────────────────────────────
  const typeValue = body.listing_type ?? 'physical'
  const [ptype] = await productService.listProductTypes({ value: typeValue })

  // ── Resolve the sales channel from the SELLER's market ────────────────────
  // The product MUST be in the store's sales channel, otherwise the standard
  // (channel-scoped) /store/products endpoint 404s and checkout fails with
  // "Product not found" even though the custom /store/listings endpoint shows it.
  //
  // What changed (story 1.3): the channel is no longer "whatever env var is set". It
  // is derived from the OWNING SELLER's `operating_market` — not from a platform-wide
  // default, because that would publish a non-Mexico shop into the Mexico marketplace
  // and hand it Mexico's Stripe/shipping rails, which story 1.2's acceptance forbids.
  // For every seller that exists today (all `mx`) the configured marketplace channel
  // remains the same. A missing market channel is an outage, never permission to
  // adopt the Store default (D0 proves those channels have different meanings).
  //
  // The seller row is read HERE rather than trusted from the caller: both callers
  // resolve a seller before calling, but neither passes its metadata, and a market
  // that a caller could assert is not a market this function can enforce.
  let sellerMarket
  let currencyCode: string
  try {
    const sellerService: SellerModuleService = scope.resolve(SELLER_MODULE)
    const [sellerRow] = await sellerService.listSellers({ id: sellerId }, { take: 1 })
    if (!sellerRow) {
      // Fail closed. Trusting `sellerId` for the LINK is fine — a bad id simply
      // fails there — but silently guessing a market for an unresolvable seller is
      // how a product lands in the wrong country's marketplace.
      return { ok: false, status: 404, message: 'No se encontró la tienda para este producto.' }
    }
    const money = resolveSellerProductMoneyContext(sellerRow, body.currency)
    sellerMarket = money.market
    currencyCode = money.currency_code
  } catch (e) {
    // Unknown seller markets and caller-selected foreign currencies both fail closed.
    // Repair the row or request the registry currency; never guess a money rail.
    return { ok: false, status: 422, message: (e as Error).message }
  }

  // D8 (US marketplace Sprint 3): a public US listing must carry a real native USD
  // price row from birth. This admission deliberately sits before `isEnabled`, the
  // product workflow, seller linking and inventory provisioning: a refused request
  // has performed no write and is safe for the caller to correct and retry.
  const priceAdmission = admitSellerProductCreatePrice(sellerMarket, body)
  if (!priceAdmission.ok) return priceAdmission

  // Resolved unconditionally (not only when `body.publish_to_market === null`) so a
  // flag-store outage never depends on WHICH value a caller happened to send —
  // `isEnabled` fails open to `false` (the flag's fail-safe side per AGENTS rule 5),
  // and `planProductPublication` only reads this boolean on the `null` branch anyway.
  const ownedShopOnlyEnabled = await isEnabled('catalog.owned_shop_only_enabled')
  const publicationPlan = planProductPublication(
    { requested: body.publish_to_market, sellerMarket, ownedShopOnlyEnabled },
    process.env,
  )
  if (publicationPlan.status === 'refused') {
    return { ok: false, status: publicationPlan.http_status, message: publicationPlan.message }
  }
  // BOTH channels (owned-shop-operating-channel epic, D2 · S2.2): the seller market's
  // OPERATING channel — which is what makes the product buyable once the publishable
  // key resolves through it (D3) — plus the marketplace channel when the product is
  // being published into the country marketplace. `planProductPublication` refuses
  // rather than returning a partial set, so this is never empty and never
  // marketplace-only.
  const salesChannelIds = publicationPlan.channel_ids

  // ── Build metadata ───────────────────────────────────────────────────────
  // Currency is stamped LAST so caller metadata cannot counterfeit the market's
  // money rail. The native Price rows below use this same registry-derived value.
  const metadata: Record<string, unknown> = {
    ...(body.condition ? { condition: body.condition } : {}),
    ...(body.state ? { state: body.state } : {}),
    ...(body.municipio ? { municipio: body.municipio } : {}),
    ...(body.location ? { location: body.location } : {}),
    ...(body.price_cents != null ? { price_cents: body.price_cents } : {}),
    listing_type: body.listing_type ?? 'product',
    delivery_mode: deliveryMode,
    views: 0,
    // Category/type-specific structured attributes (brand, size, color, year, km…)
    ...(body.attrs && Object.keys(body.attrs).length > 0 ? { attrs: body.attrs } : {}),
    ...(body.metadata ?? {}),
    currency: currencyCode.toUpperCase(),
  }

  // ── Inventory: physical `product` listings are unique-stock items ─────────
  // Managed variants let Medusa's completeCartWorkflow reserve stock on order
  // placement and block double-selling. service/rental/digital/subscription are
  // not stockable. Default quantity 1 (unique P2P item).
  const manageInventory = isStockableListingType(body.listing_type, {
    attrs: body.attrs,
    quantity: body.quantity,
  })
  if (manageInventory && (body.listing_type ?? 'product') !== 'product') {
    // An event's seats: a negative count is refused, never silently clamped to 0.
    const seats = validateSeatQuantity(body.quantity)
    if (!seats.ok) return { ok: false, status: 422, message: seats.message }
  }
  const quantity = Math.max(0, Math.floor(body.quantity ?? 1))
  const inventoryLocationId = manageInventory
    ? await resolveStockLocationId(scope, sellerMarket)
    : undefined
  if (manageInventory && !inventoryLocationId) {
    return {
      ok: false,
      status: 503,
      message: `No stock location is configured for market "${sellerMarket}". Refusing before product creation.`,
    }
  }
  const sku = generateSku()
  const weightGrams = body.weight_grams != null && body.weight_grams > 0
    ? Math.round(body.weight_grams)
    : undefined

  // ── Resolve the shipping profile ─────────────────────────────────────────
  // Medusa requires every product to belong to a shipping profile; the cart's
  // shipping method must be on the SAME profile or completeCart rejects the order
  // ("shipping profiles not satisfied"). Link to the canonical default profile —
  // the same one the seeded shipping options use.
  const shippingProfileId = await resolveDefaultShippingProfileId(scope)

  // ── Create Medusa product ────────────────────────────────────────────────
  // Always create as 'draft' (never catalog-visible), THEN link to the seller
  // below, THEN — only once the link is confirmed — flip to the caller's
  // actually-requested status. Product-create and seller-link used to happen
  // as status:published followed by a separate, non-atomic link step; if
  // anything failed/was interrupted between them, the result was a real,
  // live, orphaned listing with no resolvable seller (found in production,
  // 2026-07-15 — its shop.slug resolved to the frontend's "Unknown"
  // placeholder, which broke the embed-iframe surface). A draft product is
  // structurally safe to strand: it never reaches the public catalog.
  const requestedStatus = body.status ?? 'published'
  const { result } = await createProductsWorkflow(scope).run({
    input: {
      products: [{
        title: body.title.trim().slice(0, 100),
        ...(body.handle ? { handle: body.handle.trim().slice(0, 100) } : {}),
        description: body.description?.trim() || null,
        status: 'draft',
        ...(weightGrams !== undefined ? { weight: weightGrams } : {}),
        ...(shippingProfileId ? { shipping_profile_id: shippingProfileId } : {}),
        sales_channels: salesChannelIds.map((id) => ({ id })),
        ...(categoryId ? { category_ids: [categoryId] } : {}),
        ...(ptype ? { type_id: ptype.id } : {}),
        images: (body.images ?? []).map((img) => ({
          url: img.url,
          metadata: img.alt ? { alt: img.alt } : undefined,
        })),
        options: dimensions ?? [{
          title: 'Default',
          values: ['Default'],
        }],
        metadata,
        variants: dimensionCombos
          ? dimensionCombos.map((combo) => ({
              title: Object.values(combo).join(' / '),
              sku: generateSku(),
              options: combo,
              manage_inventory: manageInventory,
              prices: [{
                amount: body.variant_prices![buildVariantComboKey(combo)],
                currency_code: currencyCode,
              }],
            }))
          : [{
              // Use the product title as the variant title so Admin shows meaningful names
              // instead of "Default". P2P items are unique, so there's always one variant.
              title: body.title.trim().slice(0, 100),
              sku,
              options: {
                Default: 'Default',
              },
              manage_inventory: manageInventory,
              prices: body.price_cents != null && body.price_cents > 0
                ? [{ amount: body.price_cents, currency_code: currencyCode }]
                : [],
              ...(body.unit_cost_cents != null
                ? { metadata: { unit_cost_cents: body.unit_cost_cents } }
                : {}),
            }],
      }],
    },
  })
  const product = result[0]

  // ── Link product to seller ───────────────────────────────────────────────
  await remoteLink.create({
    [SELLER_MODULE]: { seller_id: sellerId },
    [Modules.PRODUCT]: { product_id: product.id },
  })

  // ── Provision inventory level for managed (physical) products ─────────────
  // The managed variant's inventory item is auto-created by the product workflow;
  // here we create the stock level at the seeded location and ensure that location
  // is linked to the sales channel so reservations succeed on order placement.
  // `inventoryProvisioned` gates the publish step below — a second fresh-reviewer
  // pass caught that the FIRST version of this reorder still let a manageInventory
  // product publish even when this block's own pre-existing else branch below
  // fired (console.error-only, never blocking) — the exact "goes live incomplete"
  // failure mode this fix exists to close.
  let inventoryProvisioned = true
  if (manageInventory) {
    const variantIds = ((product.variants ?? []) as { id?: string }[])
      .map((v) => v.id)
      .filter((id): id is string => !!id)
    const locationId = inventoryLocationId
    // `body.quantity` means "how many units of this ONE item" for a
    // single-variant listing — applying it to every generated combination on
    // a multi-variant (configurator) create would phantom-multiply stock
    // (quantity:10 × 6 variants = 60 apparent units, a cross-agent review
    // catch, 2026-07-05). Multi-variant creates default every combo to 0 —
    // the seller sets real per-variant stock afterward via the variant_id-
    // aware quantity-update path (seller-product-update.ts), same as the
    // option_dimensions edit path already does for newly-added combos.
    const perVariantQuantity = dimensionCombos ? 0 : quantity
    if (variantIds.length > 0 && locationId) {
      for (const variantId of variantIds) {
        await provisionVariantInventory(scope, {
          variantId,
          // EVERY channel the product joined — D5. Reservation happens against the
          // CART's channel (the operating one after D3), so linking only the
          // marketplace channel to the stock location would fail completion.
          salesChannelIds,
          locationId,
          quantity: perVariantQuantity,
        })
      }
    } else {
      console.error('[createSellerProduct] inventory not provisioned:', { variantIds, locationId })
      inventoryProvisioned = false
    }
  }

  // ── Publish (only now that the link AND inventory are both confirmed) ────
  if (requestedStatus !== 'draft') {
    if (!inventoryProvisioned) {
      // Leave the product in draft — safe to strand, matching this fix's own
      // principle — and surface the failure explicitly rather than returning
      // ok:true for a listing that's actually invisible in the catalog.
      return { ok: false, status: 500, message: 'No se pudo aprovisionar el inventario. Intenta de nuevo o contacta soporte.' }
    }
    await updateProductsWorkflow(scope).run({
      input: { selector: { id: product.id }, update: { status: requestedStatus } },
    })
  }

  return { ok: true, product_id: product.id }
}
