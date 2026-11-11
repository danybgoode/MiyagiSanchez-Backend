/**
 * GET /store/checkout-admission/:id?market=mx
 *
 * The CHECKOUT admission seam (owned-shop-operating-channel epic, D7 · S2.3). It
 * answers exactly one question: *is this product a member of this market's OPERATING
 * channel, and therefore buyable?* The rules, the three fail-closed states and the
 * reasoning all live in `../../_utils/checkout-admission.ts` — read that header
 * before changing anything here. This file is only the I/O shell.
 *
 * ── WHO CALLS IT ───────────────────────────────────────────────────────────────
 * The storefront's `lib/cart.ts` → `resolveCheckoutLines`, in place of
 * `GET /store/listings/:id?market=mx`, when `catalog.owned_shop_only_enabled` is ON.
 * `GET /store/listings/:id` is UNTOUCHED and still means marketplace-publication
 * truth (epic E3).
 *
 * ── RESPONSE (200) ─────────────────────────────────────────────────────────────
 *   {
 *     "market_code": "mx",              // the market echo the storefront confirms
 *     "admitted": true,
 *     "owned_shop_only_enabled": true,  // which rule actually ran
 *     "product": {
 *       "id": "prod_…",
 *       "medusa_product_id": "prod_…",  // same value; see below
 *       "status": "published",
 *       "in_operating_channel": true,
 *       "in_marketplace_channel": false
 *     },
 *     "seller": { "slug": "mi-tienda" }  // the owning shop — see below
 *   }
 *
 * `seller.slug` names the shop that owns an ADMITTED product, so the storefront can
 * read it through that shop's own channel (`/store/sellers/:slug/products/:id`) when
 * the marketplace does not carry it — a «Solo mi tienda» product's checkout page.
 * Medusa owns that edge (seller ↔ product link); the storefront must not resolve it
 * from a Supabase mirror. It is only sent with an admission, and an admitted product
 * is already public on that shop's page, so it reveals nothing a refusal hides.
 *
 * `medusa_product_id` duplicates `id` because the caller's admission proof compares
 * BOTH against the id it asked about — the productId/variantId divergence lesson in
 * `resolveCheckoutLines`' own comments is why the proof checks two fields rather than
 * trusting one. Keeping the pair here means the storefront's predicate stays the same
 * shape when it swaps endpoints.
 *
 * Every product-level refusal is one indistinguishable **404 `{"message":"Listing not
 * found"}`** — the same body and the same reasoning as `/store/listings/:id`: a
 * checkout gate is not entitled to tell a caller which of its rules it tripped, and a
 * refusal that named the rule would turn this into a catalog-enumeration oracle.
 * Market-level refusals return the structured `unavailable` body (400 / 404 / 503).
 *
 * ── IS THIS AN IDOR? NO — AND HERE IS THE ARGUMENT ─────────────────────────────
 * The route takes a caller-supplied product id, so the check must be per-object, and
 * it is: publish state, hidden-product state, OPERATING-channel membership and the
 * OWNING SELLER's market are all proven against the row itself, never against
 * anything the caller asserted. What a successful answer reveals — "this product is
 * buyable in mx" — is precisely what `GET /store/products/:id` already reveals under
 * the same publishable key once the key resolves through the operating channel (D3).
 * It is not new information; it is the same information with the rule stated. Nothing
 * seller-private is read out: the owning seller's row is consulted ONLY for
 * `metadata.operating_market`, through `readSellerOperatingMarket`, and never echoed.
 *
 * ── THE OWNING SELLER MUST BE ACTIVE (tenant-lifecycle-admin · D2b) ────────────
 * A paused or deleted shop is refused here, per-object, against the owning seller's
 * own row. This is the money-path GUARANTEE and it is deliberately redundant with
 * the mechanism — pausing also unlinks the seller's products from every market
 * channel, which removes them from the catalog by construction. If a link ever
 * lingers, checkout still refuses. An unreadable status refuses too.
 *
 * ── THE FLAG IS NOT THE AUTHORIZATION (AGENTS rule 5) ──────────────────────────
 * `catalog.owned_shop_only_enabled` decides WHICH RULE runs (operating-only, or
 * operating AND marketplace as today). Both rules are per-object authorization
 * checks. This is a Golden-managed KILLSWITCH with an ON default: the live
 * feature is available by default, and an explicit OFF value is the deliberate
 * protective rollback. A missing/unavailable Golden definition still uses the
 * declared local default and therefore preserves the live ON behavior.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { isEnabled } from '../../../../lib/flags'
import { readSellerOperatingMarket } from '../../../../lib/seller-market'
import { requireSellerStatus, type SellerStatus } from '../../../../lib/seller-status'
import type { MarketCode } from '../../../../lib/markets'
import {
  ADMISSION_NOT_FOUND_MESSAGE,
  CHECKOUT_ADMISSION_FIELDS,
  decideCheckoutAdmission,
  resolveCheckoutAdmissionGate,
  type AdmissionProductRow,
} from '../../_utils/checkout-admission'
// The SHARED refusal body. Imported rather than restated: this route was building
// the shape inline, which is how `admission_read_failed` came to be emitted while
// the union that documents it did not list it.
import type { MarketUnavailableBody } from '../../_utils/market-read'

/**
 * The owning seller's operating market, or `null` when it cannot be resolved.
 *
 * Uses the product→seller edge of the `seller ↔ product` module link directly
 * (`src/links/seller-product.ts`) — the same read `profit-ledger-write.ts` runs in
 * production. The alternative, looping every seller and asking for its product ids
 * (what `/store/listings/:id` does), is N graph queries per checkout line on the
 * money path; this is one.
 *
 * A THROWN error resolves to `null`, i.e. REFUSED. That is deliberate: "the ownership
 * read failed" and "this product has no owner" must both fail closed here, and the
 * caller cannot tell them apart anyway.
 */
/**
 * The three genuinely different outcomes of resolving a product's owning market.
 * `absent` (no seller link row) is a refusal; `unavailable` (the read threw) is an
 * outage and must NOT be served as a refusal.
 */
type OwnerMarketRead =
  | {
      readonly status: 'resolved'
      readonly market: MarketCode | null
      /** The owner's lifecycle status; `null` when unreadable, which REFUSES. */
      readonly sellerStatus: SellerStatus | null
      /** The owner's public shop slug — echoed only alongside an admission. */
      readonly sellerSlug: string | null
    }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable'; readonly reason: string }

function readSellerSlug(seller: unknown): string | null {
  const slug = (seller as { slug?: unknown }).slug
  return typeof slug === 'string' && slug.length > 0 ? slug : null
}

async function ownerMarketFor(
  query: { graph: (args: any) => Promise<any> },
  productId: string,
): Promise<OwnerMarketRead> {
  try {
    const { data } = await query.graph({
      entity: 'product',
      // `seller.metadata` is read ONLY by `readSellerOperatingMarket` below and is
      // never echoed — the bag also carries Stripe Connect ids and payout config.
      // `seller.status` rides along on the query that already runs — the owner row is
      // being read anyway, so the money-path status proof costs nothing extra.
      // `seller.slug` is public (it is the shop's URL) and echoed only on admission.
      fields: ['id', 'seller.id', 'seller.slug', 'seller.metadata', 'seller.status'],
      filters: { id: productId },
    })
    const seller = (data?.[0] as { seller?: unknown } | undefined)?.seller
    if (!seller) return { status: 'absent' }
    return {
      status: 'resolved',
      market: readSellerOperatingMarket(seller).market,
      // STRICT: an absent `status` here can only mean the field list above stopped
      // selecting it, and defaulting that to active would re-open every paused shop.
      sellerStatus: requireSellerStatus((seller as { status?: unknown }).status),
      sellerSlug: readSellerSlug(seller),
    }
  } catch (e) {
    // THREE STATES, NEVER TWO. This used to `return null`, which the decision below
    // reads as "no resolvable owner" ⇒ a uniform 404. That collapses an OUTAGE into
    // a REFUSAL: if the product table is reachable but the seller link table is not,
    // every owned-shop-only product reports "not found" — permanently-absent-looking,
    // with nothing in the response saying otherwise — while the sibling product read
    // ten lines up correctly answers 503 for the same class of failure. The
    // asymmetry was the bug. (Cross-agent review, claude-opus-4-6.)
    return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params

  const gate = resolveCheckoutAdmissionGate(
    (req.query as Record<string, string>)?.market,
    process.env,
  )
  if (!gate.ok) {
    return res.status(gate.status).json(gate.body)
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  // No initializer: the try assigns and the catch returns 503, so the seed was dead.
  // On a money path the annotation is the better guard — a future branch that skips
  // the assignment fails to compile instead of admitting a null product.
  let product: AdmissionProductRow | null
  try {
    const { data } = await query.graph({
      entity: 'product',
      fields: [...CHECKOUT_ADMISSION_FIELDS],
      filters: { id },
    })
    product = ((data ?? [])[0] as AdmissionProductRow | undefined) ?? null
  } catch {
    // A read failure on a money path is an outage, not a refusal — 503 so the caller
    // retries rather than telling a buyer their product does not exist.
    const body: MarketUnavailableBody = {
      unavailable: true,
      market_code: gate.market,
      marketplace_status: null,
      reason: 'admission_read_failed',
      message: 'No se pudo verificar el producto. Intenta de nuevo.',
    }
    return res.status(503).json(body)
  }

  const ownedShopOnly = await isEnabled('catalog.owned_shop_only_enabled')
  const ownerRead: OwnerMarketRead = product
    ? await ownerMarketFor(query, id)
    : { status: 'absent' }

  if (ownerRead.status === 'unavailable') {
    // Same class of failure as the product read above, so the same answer: 503, not
    // a 404 that tells a buyer their product does not exist.
    const body: MarketUnavailableBody = {
      unavailable: true,
      market_code: gate.market,
      marketplace_status: null,
      reason: 'admission_read_failed',
      message: 'No se pudo verificar el producto. Intenta de nuevo.',
    }
    return res.status(503).json(body)
  }

  const ownerMarket = ownerRead.status === 'resolved' ? ownerRead.market : null
  const ownerStatus = ownerRead.status === 'resolved' ? ownerRead.sellerStatus : null

  const decision = decideCheckoutAdmission({
    requested_product_id: id,
    product,
    operating_channel_id: gate.operating_channel_id,
    marketplace_channel_id: gate.marketplace_channel_id,
    owner_market: ownerMarket,
    owner_status: ownerStatus,
    market: gate.market,
    owned_shop_only_enabled: ownedShopOnly,
  })

  if (!decision.admitted) {
    // Uniform, on purpose — see the header.
    return res.status(404).json({ message: ADMISSION_NOT_FOUND_MESSAGE })
  }

  return res.json({
    market_code: gate.market,
    admitted: true,
    owned_shop_only_enabled: ownedShopOnly,
    product: {
      id: decision.product_id,
      medusa_product_id: decision.product_id,
      status: 'published',
      in_operating_channel: decision.in_operating_channel,
      in_marketplace_channel: decision.in_marketplace_channel,
    },
    // Admitted ⇒ the owner read resolved (an absent/unavailable owner never admits).
    seller: { slug: ownerRead.status === 'resolved' ? ownerRead.sellerSlug : null },
  })
}
