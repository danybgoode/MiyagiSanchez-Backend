/**
 * POST /internal/setup-negocio-plan  { stripe_price_id, price_cents? }
 *
 * Seed (idempotently) the ONE platform-owned SubscriptionPlan behind Negocio's MONTHLY billing (epic 08 ·
 * plans-gratis-negocio S1.1, README D3). Negocio's yearly price is a one-time payment handled entirely by the
 * Storefront (a dated grant), so this plan only ever carries the monthly recurring price, in its `stripe_price_id`
 * column.
 *
 * The Stripe Product + Price are created by the Storefront's `scripts/seed-negocio-plan.mjs` (it holds the Stripe
 * lib), which then POSTs the price id here. Re-running updates the existing plan instead of creating a duplicate.
 *
 * A failed lookup is a 500, two existing Negocio plans are a 409, and so is a price id another platform plan
 * already carries — never a silent second plan, never a shared price.
 *
 * The body is `setupPlanOfKind` (`src/lib/plan-kind.ts`), the same code Plan Tienda's setup route runs; the reason
 * for each guard is written there.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET (`internalSecretOk`).
 */
import { NEGOCIO_PLAN_SPEC } from '../../../lib/negocio-plan'
import { planSetupHandler } from '../_utils/plan-routes'

export const POST = planSetupHandler(NEGOCIO_PLAN_SPEC)
