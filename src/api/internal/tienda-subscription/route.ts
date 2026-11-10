/**
 * GET /internal/tienda-subscription?seller_clerk_id=...&shop_id=...  (both required)
 *
 * Source of truth for "does this shop have a LIVE monthly Plan Tienda subscription?" (epic 08 ·
 * plan-tienda-three-free-months S2.2, README D3/D4). The Storefront's plan composer feeds `active` into the pure
 * plan seam, where Negocio outranks Tienda.
 *
 * Per SHOP, exactly as Negocio: `shop_id` (the marketplace shop id the webhook records as the subscription's
 * `seller_id`) is required, and only that shop's subscription counts. Returns `{ active, plan_id, stripe_price_id,
 * price_cents, subscription_id }`; on a failed subscription read it still returns the resolved `plan_id` with
 * `reason: 'error'`, so the activation webhook can record a paid subscription. Every failure answers
 * `active: false` with a `reason`, so a backend hiccup never grants Plan Tienda.
 *
 * PATCH /internal/tienda-subscription  { stripe_subscription_id, status }
 *   — the lapse path. Answers `{ updated }` = the TIENDA rows found for that Stripe id AND written successfully;
 *   0 is the honest failure.
 *
 * Only the Tienda plan's rows are ever read or written here. A shop may hold a Tienda subscription and later a
 * Negocio one (or both for a while): a Negocio subscription is invisible to this route, and a Tienda one to
 * `/internal/negocio-subscription`. The bodies are `readPlanSubscription` / `setPlanSubscriptionStatus`
 * (`src/lib/plan-kind.ts`), the same code Negocio runs; the reason for each guard is written there.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET (`internalSecretOk`).
 */
import { TIENDA_PLAN_SPEC } from '../../../lib/tienda-plan'
import { planSubscriptionReadHandler, planSubscriptionStatusHandler } from '../_utils/plan-routes'

export const GET = planSubscriptionReadHandler(TIENDA_PLAN_SPEC)
export const PATCH = planSubscriptionStatusHandler(TIENDA_PLAN_SPEC)
