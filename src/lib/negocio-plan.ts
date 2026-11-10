/**
 * The Negocio plan (epic 08 · plans-gratis-negocio, S1.1, README D3).
 *
 * A platform-owned SubscriptionPlan like the custom-domain, subdomain and ML-sync plans, told apart on the shared
 * `subscription_plan` table by `metadata.kind === NEGOCIO_PLAN_KIND` (no migration: a metadata discriminator).
 *
 * Unlike those three, Negocio has ONE recurring cadence: monthly. Yearly is a one-time payment that the Storefront
 * turns into a dated 12-month grant on the shop (Stripe offers meses sin intereses only on one-time payments, D3),
 * so it never touches this plan. The plan's `stripe_price_id` column therefore holds the MONTHLY price.
 *
 * Since Plan Tienda (epic plan-tienda-three-free-months, S2.2) Negocio is no longer the only paid plan: the
 * decisions moved, unchanged, to `plan-kind.ts`, which both plans run. This file names the kind and keeps every
 * export it had, so a caller written before Tienda still reads the same.
 */
import {
  PLAN_LIVE_STATUSES,
  PLAN_SETTABLE_STATUSES,
  findPlanOfKind,
  plansOfKind,
  type PlanKindSpec,
  type PlanLike,
} from './plan-kind'

/** Shared identifier — keep in sync with the Storefront's `lib/negocio-subscription.ts`. */
export const NEGOCIO_PLAN_KIND = 'negocio_plan'

/** $149 MXN a month (Storefront `lib/negocio-pricing.ts` is the price source; this is only the seed default). */
export const NEGOCIO_DEFAULT_MONTHLY_CENTS = 14900

/** The live window (`past_due` is the card-retry grace). One definition for both paid plans: see `plan-kind.ts`. */
export const NEGOCIO_LIVE_STATUSES = PLAN_LIVE_STATUSES

/** Statuses the lapse path (the Stripe webhook) may set. */
export const NEGOCIO_SETTABLE_STATUSES = PLAN_SETTABLE_STATUSES

export const NEGOCIO_PLAN_SPEC: PlanKindSpec = {
  kind: NEGOCIO_PLAN_KIND,
  label: 'Negocio',
  description: 'Plan Negocio de Miyagi Sánchez, pago mensual.',
  defaultMonthlyCents: NEGOCIO_DEFAULT_MONTHLY_CENTS,
  logTag: 'negocio-subscription',
}

/** Every Negocio plan among the platform's plans, OLDEST first (ties by id). More than one is a seeding fault the
 *  setup route refuses. */
export function negocioPlans<T extends PlanLike>(plans: readonly T[]): T[] {
  return plansOfKind(plans, NEGOCIO_PLAN_KIND)
}

/**
 * THE Negocio plan: the oldest one. Deterministic on purpose — if a duplicate ever exists, the webhook that records a
 * subscription and the read that checks it must resolve the SAME plan, or a paying seller reads as not paying.
 */
export function findNegocioPlan<T extends PlanLike>(plans: readonly T[]): T | null {
  return findPlanOfKind(plans, NEGOCIO_PLAN_KIND)
}

/** The first live subscription row for a shop, or null. Plan-neutral: see `plan-kind.ts`. */
export { liveSubscription } from './plan-kind'
