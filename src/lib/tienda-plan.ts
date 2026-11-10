/**
 * Plan Tienda, month to month (epic 08 · plan-tienda-three-free-months S2.2, README D3/D5).
 *
 * The second paid plan of Miyagi Sánchez: a platform-owned SubscriptionPlan told apart by
 * `metadata.kind === TIENDA_PLAN_KIND`. Like Negocio it has ONE recurring cadence, monthly; the yearly price is a
 * one-time payment the Storefront turns into a dated `tienda_grant` on the shop, so it never touches this plan.
 *
 * Nothing is implemented here: every decision is `plan-kind.ts`, the same code Negocio runs. This file only names
 * the kind, so the two plans cannot drift apart.
 */
import { findPlanOfKind, plansOfKind, type PlanKindSpec, type PlanLike } from './plan-kind'

/** Shared identifier — keep in sync with the Storefront's Tienda subscription bridge. */
export const TIENDA_PLAN_KIND = 'tienda_plan'

/** $29 MXN a month, IVA included (Storefront `lib/tienda-pricing.ts` is the price source; this is only the seed default). */
export const TIENDA_DEFAULT_MONTHLY_CENTS = 2900

export const TIENDA_PLAN_SPEC: PlanKindSpec = {
  kind: TIENDA_PLAN_KIND,
  label: 'Tienda',
  description: 'Plan Tienda de Miyagi Sánchez, pago mensual.',
  defaultMonthlyCents: TIENDA_DEFAULT_MONTHLY_CENTS,
  logTag: 'tienda-subscription',
}

/** Every Tienda plan among the platform's plans, oldest first. More than one is a seeding fault. */
export function tiendaPlans<T extends PlanLike>(plans: readonly T[]): T[] {
  return plansOfKind(plans, TIENDA_PLAN_KIND)
}

/** THE Tienda plan: the oldest one, so the webhook and the read always resolve the same row. */
export function findTiendaPlan<T extends PlanLike>(plans: readonly T[]): T | null {
  return findPlanOfKind(plans, TIENDA_PLAN_KIND)
}
