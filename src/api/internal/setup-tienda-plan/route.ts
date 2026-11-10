/**
 * POST /internal/setup-tienda-plan  { stripe_price_id, price_cents? }
 *
 * Seed (idempotently) the ONE platform-owned SubscriptionPlan behind Plan Tienda's MONTHLY billing (epic 08 ·
 * plan-tienda-three-free-months S2.2, README D3/D5): $29 MXN a month, kind `tienda_plan`. Plan Tienda's yearly
 * price is a one-time payment the Storefront turns into a dated `tienda_grant`, so this plan only ever carries the
 * monthly recurring price, in its `stripe_price_id` column.
 *
 * The Stripe Product + Price are created on the Storefront side (it holds the Stripe lib), which then POSTs the
 * price id here. Re-running updates the existing Tienda plan instead of creating a duplicate, and never rewrites
 * the Negocio plan or any other platform plan.
 *
 * A failed lookup is a 500, two existing Tienda plans are a 409, and so is a price id another platform plan
 * already carries (Negocio's price pasted here would charge $149 for Plan Tienda).
 *
 * The body is `setupPlanOfKind` (`src/lib/plan-kind.ts`), the same code Negocio's setup route runs; the reason for
 * each guard is written there.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET (`internalSecretOk`).
 */
import { TIENDA_PLAN_SPEC } from '../../../lib/tienda-plan'
import { planSetupHandler } from '../_utils/plan-routes'

export const POST = planSetupHandler(TIENDA_PLAN_SPEC)
