/**
 * GET /internal/negocio-subscription?seller_clerk_id=...&shop_id=...  (both required)
 *
 * Source of truth for "does this seller have a LIVE monthly Negocio subscription?" (epic 08 · plans-gratis-negocio
 * S1.1, README D1/D3). The Storefront's plan composer (`lib/plan-server.ts`) feeds `active` into the pure
 * `derivePlan` seam.
 *
 * Negocio is per SHOP (README D1): `shop_id` (the marketplace shop id the webhook records as the subscription's
 * `seller_id`) is required, and only that shop's subscription counts. Returns `{ active, plan_id, stripe_price_id, price_cents,
 * subscription_id }`; on a failed subscription read it still returns the resolved `plan_id` with `reason: 'error'`,
 * so the activation webhook can record a paid subscription even when this seller's rows could not be listed. Every
 * failure answers `active: false` with a `reason`, so a backend hiccup never grants Negocio.
 *
 * PATCH /internal/negocio-subscription  { stripe_subscription_id, status }
 *   — the lapse path: the Stripe webhook knows only the Stripe subscription id, and entitlement reads Medusa.
 *   Answers `{ updated }` = the Negocio rows found for that Stripe id AND written successfully. Re-setting the status a
 *   row already has (a replayed webhook) counts, on purpose: the caller asks "is this subscription now at status X?",
 *   and 0 means the honest failure — no such Negocio row, or every write failed.
 *
 * Only the Negocio plan's rows are ever read or written here: a Plan Tienda subscription is invisible to this
 * route. The bodies are `readPlanSubscription` / `setPlanSubscriptionStatus` (`src/lib/plan-kind.ts`), the same
 * code `/internal/tienda-subscription` runs; the reason for each guard is written there.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET (`internalSecretOk`).
 */
import { NEGOCIO_PLAN_SPEC } from '../../../lib/negocio-plan'
import { planSubscriptionReadHandler, planSubscriptionStatusHandler } from '../_utils/plan-routes'

export const GET = planSubscriptionReadHandler(NEGOCIO_PLAN_SPEC)
export const PATCH = planSubscriptionStatusHandler(NEGOCIO_PLAN_SPEC)
