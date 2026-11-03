/**
 * market-medusa.ts — the seam between the pure market registry and THIS repo's
 * Medusa environment.
 *
 * `markets.ts` deliberately holds no Medusa Region id and no Sales Channel id: those
 * differ per environment (local / staging / production), so an id in the registry
 * would be a lie everywhere but one place (epic README, D2). This file is where a
 * market code becomes a concrete Medusa id, and it does it by reading an INJECTED
 * env object — never `process.env` directly — so every branch is unit-testable with
 * no ambient environment and no container.
 *
 * THREE STATES, NEVER TWO. `resolveMarketplaceChannelId('us')` and
 * `resolveMarketplaceChannelId('mx')` in an environment that forgot to set
 * `MEDUSA_SALES_CHANNEL_ID` both produce "no id", but they are completely different
 * facts:
 *   · `us`  — known-absent. There is no US Sales Channel and no US Region in ANY
 *             environment (D0: production holds exactly 1 Region and 2 Sales
 *             Channels, all Mexico). US is fail-closed by construction.
 *   · `mx` with the env var missing — UNCONFIGURED. An operator mistake. The
 *             marketplace exists; we simply cannot address it.
 * Collapsing those into one `null` is how a misconfigured deploy would read as
 * "this market has no marketplace" and quietly serve nothing while looking healthy.
 * The `*Resolution` functions keep them apart; the `*Id` helpers below are the
 * convenience shape the build contract asks for and are defined in terms of them.
 *
 * OPERATING CHANNEL (owned-shop-operating-channel epic, D2/S1.2): a SECOND Sales
 * Channel per market, added alongside `marketplace_channel` through the exact same
 * seam and the exact same three states. Marketplace membership means "published to
 * the country marketplace"; operating-channel membership means "buyable at all"
 * (cart/checkout/publishable-key resolve against it, starting Sprint 2). The two
 * channels are DIFFERENT Medusa resources with different ids — `unconfigured` on one
 * NEVER falls back to the other's id. Doing so would silently sell an owned-shop-only
 * product through the marketplace channel (or vice versa), which erases the whole
 * distinction this epic exists to create; a missing operating channel must read as an
 * outage, not as "use whatever channel we do have".
 */

import {
  MARKET_CODES,
  type MarketCode,
  requireMarket,
} from './markets'

/**
 * The env shape this seam reads. Injected, never `process.env` — a route passes
 * `process.env`, a spec passes an object literal.
 */
export interface MarketMedusaEnv {
  readonly MEDUSA_MXN_REGION_ID?: string
  readonly MEDUSA_SALES_CHANNEL_ID?: string
  readonly MEDUSA_MX_OPERATING_CHANNEL_ID?: string
  readonly MEDUSA_PUBLISHABLE_KEY?: string
  readonly MEDUSA_STOCK_LOCATION_ID?: string
  readonly MEDUSA_US_REGION_ID?: string
  readonly MEDUSA_US_MARKETPLACE_CHANNEL_ID?: string
  readonly MEDUSA_US_OPERATING_CHANNEL_ID?: string
  readonly MEDUSA_US_PUBLISHABLE_KEY?: string
  readonly MEDUSA_US_STOCK_LOCATION_ID?: string
}

/**
 * Which env var (if any) carries each market's Medusa ids.
 *
 * A market with no entry has no such resource IN ANY ENVIRONMENT — that is a
 * structural fact about the platform today, not a configuration gap. Standing up a
 * US Region later is one row here plus one env var, and until both exist every
 * caller reads a `no_resource` resolution rather than a Mexico id.
 */
const MARKET_MEDUSA_ENV_KEYS: Readonly<Record<MarketCode, {
  readonly region?: keyof MarketMedusaEnv
  readonly marketplace_channel?: keyof MarketMedusaEnv
  readonly operating_channel?: keyof MarketMedusaEnv
  readonly stock_location?: keyof MarketMedusaEnv
}>> = Object.freeze({
  mx: Object.freeze({
    region: 'MEDUSA_MXN_REGION_ID',
    marketplace_channel: 'MEDUSA_SALES_CHANNEL_ID',
    operating_channel: 'MEDUSA_MX_OPERATING_CHANNEL_ID',
    stock_location: 'MEDUSA_STOCK_LOCATION_ID',
  }),
  // US is now an expected resource pack. Until provisioning publishes the ids,
  // every resolution is `unconfigured` (operator action required), never
  // `no_resource` and never an MX fallback.
  us: Object.freeze({
    region: 'MEDUSA_US_REGION_ID',
    marketplace_channel: 'MEDUSA_US_MARKETPLACE_CHANNEL_ID',
    operating_channel: 'MEDUSA_US_OPERATING_CHANNEL_ID',
    stock_location: 'MEDUSA_US_STOCK_LOCATION_ID',
  }),
})

export type MedusaResourceKind =
  | 'region'
  | 'marketplace_channel'
  | 'operating_channel'
  | 'stock_location'

/**
 * The outcome of turning a market code into a Medusa id.
 *
 *   resolved     — an id exists and is configured.
 *   no_resource  — this market has no such Medusa resource anywhere. Structural.
 *   unconfigured — the resource is expected for this market but the env var that
 *                  names it is missing/empty. Operator error; callers must fail
 *                  closed and SAY SO rather than falling back to another market.
 */
export type MedusaIdResolution =
  | { readonly status: 'resolved'; readonly market: MarketCode; readonly kind: MedusaResourceKind; readonly id: string }
  | { readonly status: 'no_resource'; readonly market: MarketCode; readonly kind: MedusaResourceKind; readonly reason: string }
  | { readonly status: 'unconfigured'; readonly market: MarketCode; readonly kind: MedusaResourceKind; readonly env_var: string; readonly reason: string }

function resolve(
  value: unknown,
  kind: MedusaResourceKind,
  env: MarketMedusaEnv,
): MedusaIdResolution {
  // `requireMarket` throws `UnknownMarketError` — including the loud "that looks
  // like a LOCALE" hint (D3). An unknown market must never reach an id lookup.
  const market = requireMarket(value).code
  const envKey = MARKET_MEDUSA_ENV_KEYS[market][kind]

  if (!envKey) {
    return {
      status: 'no_resource',
      market,
      kind,
      reason: `Market "${market}" has no Medusa ${kind} in any environment.`,
    }
  }

  const raw = env[envKey]
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) {
    return {
      status: 'unconfigured',
      market,
      kind,
      env_var: envKey,
      reason: `Market "${market}" expects a Medusa ${kind} but ${envKey} is unset. ` +
        'Refusing to guess — fail closed rather than serving another market\'s resource.',
    }
  }

  return { status: 'resolved', market, kind, id }
}

/** Full resolution (three states) for a market's Medusa Region. */
export function resolveRegionForMarket(value: unknown, env: MarketMedusaEnv): MedusaIdResolution {
  return resolve(value, 'region', env)
}

/** Full resolution (three states) for a market's marketplace Sales Channel. */
export function resolveMarketplaceChannelForMarket(value: unknown, env: MarketMedusaEnv): MedusaIdResolution {
  return resolve(value, 'marketplace_channel', env)
}

/**
 * Full resolution (three states) for a market's OPERATING Sales Channel — the
 * channel that carries buyability (owned-shop-operating-channel epic, D2/S1.2). A
 * DIFFERENT Medusa resource from the marketplace channel above, resolved through the
 * same `resolve()` so the three states are identical in shape and in strictness.
 *
 * `unconfigured` here must NEVER be treated as "fall back to the marketplace
 * channel" — a caller that did so would silently sell an owned-shop-only product
 * through the marketplace channel (leaking marketplace visibility onto something the
 * seller deliberately kept out of it) or, once the publishable key moves (D3), it
 * would mean the storefront's key resolves to nothing and every cart 400s. A missing
 * operating channel is an outage to be reported and fixed, not a degraded mode to be
 * quietly routed around.
 */
export function resolveOperatingChannelForMarket(value: unknown, env: MarketMedusaEnv): MedusaIdResolution {
  return resolve(value, 'operating_channel', env)
}

const MARKET_PUBLISHABLE_KEY_ENV_KEYS: Readonly<Record<MarketCode, keyof MarketMedusaEnv>> = Object.freeze({
  mx: 'MEDUSA_PUBLISHABLE_KEY',
  us: 'MEDUSA_US_PUBLISHABLE_KEY',
})

export type PublishableKeyTokenResolution =
  | { readonly status: 'resolved'; readonly market: MarketCode; readonly kind: 'publishable_key_token'; readonly token: string }
  | { readonly status: 'unconfigured'; readonly market: MarketCode; readonly kind: 'publishable_key_token'; readonly env_var: string; readonly reason: string }

/**
 * Resolve a browser publishable token (`pk_…`). It is deliberately not a
 * `MedusaIdResolution`: API-key database row ids are `apk_…`, and conflating the
 * two makes cleanup/provision verification unsafe.
 */
export function resolvePublishableKeyForMarket(
  value: unknown,
  env: MarketMedusaEnv,
): PublishableKeyTokenResolution {
  const market = requireMarket(value).code
  const envKey = MARKET_PUBLISHABLE_KEY_ENV_KEYS[market]
  const raw = env[envKey]
  const token = typeof raw === 'string' ? raw.trim() : ''
  return token
    ? { status: 'resolved', market, kind: 'publishable_key_token', token }
    : {
      status: 'unconfigured', market, kind: 'publishable_key_token', env_var: envKey,
      reason: `Market "${market}" expects a publishable key token but ${envKey} is unset.`,
    }
}

/** Full resolution for the market-owned inventory location. */
export function resolveStockLocationForMarket(value: unknown, env: MarketMedusaEnv): MedusaIdResolution {
  return resolve(value, 'stock_location', env)
}

/**
 * The Medusa Region id for a market, or `null`.
 *
 * `mx` → `MEDUSA_MXN_REGION_ID`; `us` → `MEDUSA_US_REGION_ID`; unknown throws
 * `UnknownMarketError`. Use `resolveRegionForMarket` when the caller must preserve
 * the named `unconfigured` reason instead of collapsing it to null; this convenience
 * shape is only safe where every unresolved state means "cannot proceed".
 *
 * NOTE for this repo specifically: `MEDUSA_MXN_REGION_ID` is a FRONTEND env var
 * today (`apps/storefront/lib/medusa.ts`); the backend resolves its Region from
 * the database, so this function usually answers `unconfigured` here. That is
 * correct and harmless — no backend caller uses the id for commerce. It exists so
 * the destructive setup guard (D6) can protect a registry-addressable Region when
 * the var IS present, and so the two repos' seams stay shaped alike.
 */
export function resolveRegionIdForMarket(value: unknown, env: MarketMedusaEnv): string | null {
  const resolution = resolveRegionForMarket(value, env)
  return resolution.status === 'resolved' ? resolution.id : null
}

/**
 * The marketplace Sales Channel id for a market, or `null`.
 *
 * Both registry markets resolve their named marketplace-channel env. A missing
 * expected env collapses to null here; callers that need the three-state reason use
 * `resolveMarketplaceChannelForMarket`. Unknown input throws `UnknownMarketError`.
 */
export function resolveMarketplaceChannelId(value: unknown, env: MarketMedusaEnv): string | null {
  const resolution = resolveMarketplaceChannelForMarket(value, env)
  return resolution.status === 'resolved' ? resolution.id : null
}

/**
 * The operating Sales Channel id for a market, or `null` — collapsing `no_resource`
 * and `unconfigured` exactly like `resolveMarketplaceChannelId` does, and for the
 * same reason: this convenience shape is only safe where BOTH mean "cannot proceed".
 * A read boundary that must tell an outage apart from a structural absence uses
 * `resolveOperatingChannelForMarket` instead — never this one.
 *
 * Both registry markets resolve their named operating-channel env; unknown throws
 * `UnknownMarketError`.
 */
export function resolveOperatingChannelId(value: unknown, env: MarketMedusaEnv): string | null {
  const resolution = resolveOperatingChannelForMarket(value, env)
  return resolution.status === 'resolved' ? resolution.id : null
}

export function resolvePublishableKey(value: unknown, env: MarketMedusaEnv): string | null {
  const resolution = resolvePublishableKeyForMarket(value, env)
  return resolution.status === 'resolved' ? resolution.token : null
}

export function resolveStockLocationIdForMarket(value: unknown, env: MarketMedusaEnv): string | null {
  const resolution = resolveStockLocationForMarket(value, env)
  return resolution.status === 'resolved' ? resolution.id : null
}

/**
 * Every Medusa Region id that ANY registry market resolves to in this environment.
 *
 * Used by the destructive-setup guard (D6): `setup-mexico` step 6 must never delete
 * a Region a market can address. Derived from `MARKET_CODES` so a new market is
 * protected the moment it is added — never maintain a second list.
 */
export function registryRegionIds(env: MarketMedusaEnv): string[] {
  return dedupe(MARKET_CODES.map((code) => resolveRegionIdForMarket(code, env)))
}

/**
 * Every marketplace Sales Channel id that ANY registry market resolves to.
 *
 * Used by `cleanup-default-data.ts` and `/internal/prune-sales-channels`: both
 * delete "every channel that is not the one we keep", which is only safe while
 * exactly one market exists. Guard the population, not the door you found.
 */
export function registryMarketplaceChannelIds(env: MarketMedusaEnv): string[] {
  return dedupe(MARKET_CODES.map((code) => resolveMarketplaceChannelId(code, env)))
}

/**
 * Every operating Sales Channel id that ANY registry market resolves to — the
 * operating-channel sibling of `registryMarketplaceChannelIds` (owned-shop-operating-
 * channel epic, S1.2). Mirrors it exactly: derived from `MARKET_CODES`, never
 * hand-maintained, and an unconfigured/no-resource market contributes nothing rather
 * than inventing an id.
 *
 * Used by `protectedSalesChannelIds` below, per D10: the allow-list must protect the
 * operating channel BEFORE it exists in production, because a channel that exists
 * but is not yet on this list is one `cleanup-default-data.ts` run from deletion.
 */
export function registryOperatingChannelIds(env: MarketMedusaEnv): string[] {
  return dedupe(MARKET_CODES.map((code) => resolveOperatingChannelId(code, env)))
}

/**
 * The full set of Sales Channel ids a destructive cleanup must never delete:
 * every registry-declared marketplace channel, every registry-declared OPERATING
 * channel (owned-shop-operating-channel epic, D10), PLUS the store's own default
 * channel.
 *
 * `store.default_sales_channel_id` is included because Medusa refuses to delete a
 * channel that is still a store default (it would orphan the store), and because in
 * production it is a DIFFERENT channel from the marketplace one — a known, harmless,
 * out-of-scope divergence recorded in D0. All three must survive.
 */
export function protectedSalesChannelIds(
  env: MarketMedusaEnv,
  storeDefaultChannelId?: string | null,
): string[] {
  return dedupe([
    ...registryMarketplaceChannelIds(env),
    ...registryOperatingChannelIds(env),
    storeDefaultChannelId ?? null,
  ])
}

/**
 * Both channel ids for a market in one call, collapsed to `null` on anything but
 * `resolved` (owned-shop-operating-channel epic, S3.3 · seller/agent read surfaces).
 *
 * A read surface that shows a product's operating-vs-marketplace membership as two
 * separate facts (S3.3's build contract line) needs both ids to test membership
 * against; it is not itself a money path (unlike `checkout-admission.ts`), so an
 * unaddressable channel there degrades to "can't be a member of a channel that does
 * not resolve" (both membership booleans read `false`) rather than blocking the whole
 * product list the way the checkout and marketplace-read boundaries correctly do.
 */
export function resolveChannelIdsForMarket(
  value: unknown,
  env: MarketMedusaEnv,
): { readonly operating_channel_id: string | null; readonly marketplace_channel_id: string | null } {
  return {
    operating_channel_id: resolveOperatingChannelId(value, env),
    marketplace_channel_id: resolveMarketplaceChannelId(value, env),
  }
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()))]
}
