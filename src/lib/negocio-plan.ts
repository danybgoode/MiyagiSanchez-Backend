/**
 * The Negocio plan — the platform's one paid plan (epic 08 · plans-gratis-negocio, S1.1, README D3).
 *
 * A platform-owned SubscriptionPlan like the custom-domain, subdomain and ML-sync plans, told apart on the shared
 * `subscription_plan` table by `metadata.kind === NEGOCIO_PLAN_KIND` (no migration: a metadata discriminator).
 *
 * Unlike those three, Negocio has ONE recurring cadence: monthly. Yearly is a one-time payment that the Storefront
 * turns into a dated 12-month grant on the shop (Stripe offers meses sin intereses only on one-time payments, D3),
 * so it never touches this plan. The plan's `stripe_price_id` column therefore holds the MONTHLY price.
 *
 * Pure: the two internal routes are thin shells around these functions, so the decisions are unit-tested with no
 * Medusa container.
 */

/** Shared identifier — keep in sync with the Storefront's `lib/negocio-subscription.ts`. */
export const NEGOCIO_PLAN_KIND = 'negocio_plan'

/** $149 MXN a month (Storefront `lib/negocio-pricing.ts` is the price source; this is only the seed default). */
export const NEGOCIO_DEFAULT_MONTHLY_CENTS = 14900

/**
 * `past_due` counts as live: Stripe is retrying the card, and a transient failure must not drop a merchant to
 * Gratis mid-month. Only a definitive `canceled` (or anything unknown) lapses it — the same window the other
 * platform plans use.
 */
export const NEGOCIO_LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due'])

/** Statuses the lapse path (the Stripe webhook) may set. */
export const NEGOCIO_SETTABLE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'canceled'])

type PlanLike = { metadata?: Record<string, unknown> | null } | null | undefined
type SubscriptionLike = { status?: string | null; stripe_subscription_id?: string | null } | null | undefined

/** The platform Negocio plan among the platform's plans, or null. Filtered in JS: metadata jsonb filters are not
 *  reliably supported by the list query (same reason as the ML-sync route). */
export function findNegocioPlan<T extends PlanLike>(plans: readonly T[]): T | null {
  return plans.find((p) => (p?.metadata as Record<string, unknown> | null | undefined)?.kind === NEGOCIO_PLAN_KIND) ?? null
}

/** The first live subscription row, or null. An unknown status is NOT live: "I cannot tell" never grants. */
export function liveSubscription<T extends SubscriptionLike>(rows: readonly T[]): T | null {
  return rows.find((r) => typeof r?.status === 'string' && NEGOCIO_LIVE_STATUSES.has(r.status)) ?? null
}
