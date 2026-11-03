/**
 * markets.ts — the market registry. THE source of truth for "which countries does
 * Miyagi operate in, and what does each one mean".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS DUPLICATED, BYTE-FOR-BYTE, IN TWO REPOSITORIES:
 *   · apps/storefront/lib/markets.ts       (frontend)
 *   · apps/backend/src/lib/markets.ts         (backend)
 * They have no shared package and different build systems, so the contract is
 * kept honest by a GOLDEN SPEC in each repo that asserts every field of every
 * record. If one side drifts, that side's own gate goes red. Change one, change
 * both, in the same epic — and update both golden specs.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ZERO IMPORTS, ON PURPOSE. No `next`, no `@medusajs`, no env reads. That is what
 * lets the identical bytes compile in a Next.js app, a Medusa server, a Playwright
 * `api` spec and a `node:test` unit run alike — and it is why every branch below is
 * reachable from a pure unit test with no network and no database.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: Medusa Region ids and Sales Channel ids. Those
 * are environment-resolved (they differ between local, staging and production) and
 * live in each repo's own `market-medusa` seam. Putting an id here would make the
 * registry lie the moment it is read in a different environment.
 *
 * The four concepts this file keeps SEPARATE, because collapsing any pair of them
 * is the exact defect this registry exists to prevent:
 *   market   — the operating country context (`mx`, `us`). What this file owns.
 *   locale   — presentation language. NEVER a proxy for any of the other three.
 *   Region   — Medusa's checkout currency/payment/fulfillment container.
 *   channel  — Medusa Sales Channel membership = marketplace publication truth.
 */

/** Every market code the platform knows about. Order is display order on the selector. */
export const MARKET_CODES = ['mx', 'us'] as const

export type MarketCode = (typeof MARKET_CODES)[number]

/**
 * Marketplace publication status for a market.
 *
 *   active     — the country marketplace is open; catalog reads and marketplace
 *                publication are allowed.
 *   invitation — an invitation surface exists, but there is NO
 *                marketplace: catalog reads fail closed and nothing can be
 *                published into it. This is the fail-closed state.
 *
 * There is deliberately no `disabled`/`coming_soon`: a third "sort of open" value
 * is how a fail-closed boundary becomes a fail-open one.
 */
export type MarketplaceStatus = 'active' | 'invitation'

export interface MarketRecord {
  /** Lowercase ISO-3166-1 alpha-2 market code. Also the public URL segment: `/mx`. */
  readonly code: MarketCode
  /** Lowercase ISO-3166-1 alpha-2 country. Equal to `code` today; kept distinct
   *  because a market is a business decision and a country is a fact — a future
   *  market could span or subset countries, and callers that mean "country" should
   *  say so. */
  readonly country_code: string
  /** Lowercase ISO-4217. The checkout currency for this market's Medusa Region. */
  readonly currency_code: string
  /** BCP-47 tag used for `lang`/`hreflang`. PRESENTATION ONLY — never read this to
   *  decide currency, payment, shipping, tax or marketplace membership. */
  readonly default_locale: string
  /** IANA timezone, for operator-facing date rendering. */
  readonly timezone: string
  /** See `MarketplaceStatus`. */
  readonly marketplace_status: MarketplaceStatus
}

export const MARKETS: Readonly<Record<MarketCode, MarketRecord>> = Object.freeze({
  mx: Object.freeze({
    code: 'mx',
    country_code: 'mx',
    currency_code: 'mxn',
    default_locale: 'es-MX',
    timezone: 'America/Mexico_City',
    marketplace_status: 'active',
  }),
  us: Object.freeze({
    code: 'us',
    country_code: 'us',
    currency_code: 'usd',
    default_locale: 'en-US',
    // The US marketplace is operated out of the eastern US; this is a rendering
    // default only and carries no commerce meaning.
    timezone: 'America/New_York',
    marketplace_status: 'active',
  }),
})

/**
 * The market an un-annotated legacy caller resolves to.
 *
 * This exists ONLY for the pre-launch migration window: every seller, product and
 * cart that predates the registry was created in a single-market Mexico system, so
 * "unspecified" genuinely means `mx` for that population and nothing else. It is a
 * BACKWARD-COMPATIBILITY default, not a fallback for unknown input — an unknown or
 * unsupported market must fail (`requireMarket`), never silently become Mexico.
 * New write paths state their market explicitly; see `Roadmap/.../market-architecture-foundation`.
 */
export const DEFAULT_MARKET: MarketCode = 'mx'

/** Thrown when a caller supplies something that is not a supported market code. */
export class UnknownMarketError extends Error {
  readonly value: unknown
  constructor(value: unknown, hint?: string) {
    super(
      `Unsupported market ${JSON.stringify(value)}. ` +
      `Supported: ${MARKET_CODES.join(', ')}.` +
      (hint ? ` ${hint}` : ''),
    )
    this.name = 'UnknownMarketError'
    this.value = value
  }
}

/**
 * Does this value look like a BCP-47 locale rather than a market code?
 *
 * The registry's single most important negative guarantee is that **a locale
 * cannot be passed where a market is required** — `es-MX` and `mx` are different
 * kinds of thing, and every historical bug in this area started by treating one as
 * the other. `isMarketCode('es-MX')` already returns false, but a bare "unsupported
 * market" error sends the reader hunting for a missing registry entry. Detecting
 * the locale shape lets the error name the actual mistake.
 *
 * Matches `xx-YY`, `xx_YY` and a bare `xxx` language subtag — deliberately loose,
 * because it only ever upgrades an error message, never accepts anything.
 */
export function looksLikeLocale(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^[a-z]{2,3}[-_][a-z0-9]{2,8}$/i.test(value.trim()) ||
    /^[a-z]{3}$/i.test(value.trim())
}

/**
 * Narrow an unknown value to a `MarketCode`. **STRICT: canonical form only.**
 *
 * Accepts `'mx'` and `'us'` exactly — not `'MX'`, not `' us '`, and certainly not a
 * locale (`es-MX`), a country name or a currency.
 *
 * The strictness is not fussiness, it is soundness. A type predicate makes the
 * compiler believe the value it narrowed *is* a `MarketCode`, so a lenient version
 * lets `if (isMarketCode(v)) MARKETS[v]` type-check while returning `undefined` at
 * runtime for `'MX'` — a market lookup that silently yields nothing is exactly the
 * kind of hole this registry exists to close. Leniency belongs in
 * `normalizeMarketCode`, which returns the canonical value rather than blessing the
 * original string. (Caught by a cross-family review of the epic's first PR, in the
 * architect's own file.)
 */
export function isMarketCode(value: unknown): value is MarketCode {
  return typeof value === 'string' && (MARKET_CODES as readonly string[]).includes(value)
}

/**
 * Normalize a possibly-untidy supported code to its canonical lowercase form, or
 * `null`. This is the LENIENT entry point — trims and lowercases — and it is what
 * every caller handling outside input (a query parameter, stored metadata, a tool
 * argument) should use. It returns the canonical value, so nothing downstream ever
 * carries a non-canonical string typed as a `MarketCode`.
 */
export function normalizeMarketCode(value: unknown): MarketCode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return isMarketCode(normalized) ? normalized : null
}

/** The record for a supported market, or `null`. Use when absence is a legitimate
 *  answer (a route deciding whether a path segment is a market at all). */
export function getMarket(value: unknown): MarketRecord | null {
  const code = normalizeMarketCode(value)
  return code ? MARKETS[code] : null
}

/**
 * The record for a supported market, or THROW.
 *
 * Use at every seam that must not proceed on an unknown market: cart/Region
 * resolution, marketplace catalog reads, seller operating-market writes. An
 * exception here is the fail-closed behaviour — the alternative (returning Mexico)
 * is how a US read would serve the Mexico catalog.
 */
export function requireMarket(value: unknown): MarketRecord {
  const record = getMarket(value)
  if (record) return record
  throw new UnknownMarketError(
    value,
    looksLikeLocale(value)
      ? 'That looks like a LOCALE. Locale is presentation only and is never a market — ' +
        'pass a market code and read `default_locale` off the record.'
      : undefined,
  )
}

/**
 * Is this market's country marketplace open for catalog reads and publication?
 *
 * Written as an allow-list on `active` rather than a deny-list on `invitation`, so
 * a future status value declines by default instead of silently opening a market.
 * (LEARNINGS: "a deny-list of bad statuses treats every unknown string as good".)
 */
export function isMarketplaceOpen(value: unknown): boolean {
  return getMarket(value)?.marketplace_status === 'active'
}

/** Every market whose marketplace is open. Derived — never maintain a second list. */
export function openMarketCodes(): MarketCode[] {
  return MARKET_CODES.filter((code) => MARKETS[code].marketplace_status === 'active')
}

/**
 * The public URL prefix for a market's marketplace surface: `mx` → `/mx`.
 *
 * Every marketplace link on the platform host is built from this, so a market's
 * path shape is stated in exactly one place. Tenant channels (subdomain, custom
 * domain, embed) are NOT marketplace surfaces and never carry a market prefix —
 * they pass `''` explicitly rather than calling this.
 */
export function marketBasePath(value: unknown): string {
  return `/${requireMarket(value).code}`
}
