/**
 * GET /internal/custom-domain-subscription?seller_clerk_id=...
 *
 * Source of truth for the custom-domain paywall entitlement (epic 07, Sprint 2):
 * "does this seller have a LIVE subscription to the platform custom-domain plan?"
 * The frontend entitlement seam (lib/domain-subscription.ts) calls this to derive
 * `hasActiveSubscription` for `resolveDomainEntitlement`.
 *
 * Returns `{ active, plan_id, stripe_price_id, price_cents }` — `active` is true
 * iff a Subscription row exists for that seller against the platform
 * custom-domain plan with status in {active, trialing}. The plan fields let the
 * frontend's buy route build the Stripe checkout in the same call. Fails closed
 * to `{ active: false }` on any lookup error (the paywall simply stays gated —
 * never wrongly grants).
 *
 * PATCH /internal/custom-domain-subscription  { stripe_subscription_id, status }
 *   — flips the Medusa Subscription status by its Stripe id (lapse path: the
 *   webhook only has the Stripe subscription id, and entitlement reads Medusa, so
 *   the row must be updated there for the gate to flip off).
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import {
  PLATFORM_SELLER_ID,
  CUSTOM_DOMAIN_PLAN_KIND,
} from '../setup-custom-domain-plan/route'
import { platformSkuStatusHandler } from '../_utils/plan-routes'

// `past_due` counts as live: it's a grace window while Stripe retries the card —
// the domain stays connected so a transient payment failure never darkens the
// seller's site. Only a definitive `canceled` (subscription.deleted) disconnects.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due'])

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const sellerClerkId = req.query.seller_clerk_id as string | undefined
  if (!sellerClerkId) {
    return res.status(400).json({ message: 'seller_clerk_id query param is required' })
  }

  try {
    const subs = req.scope.resolve(SUBSCRIPTIONS_MODULE) as SubscriptionsModuleService

    // Resolve the platform custom-domain plan.
    const platformPlans: any[] = await (subs as any)
      .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
      .catch(() => [])
    const plan = platformPlans.find(
      (p) => (p?.metadata as Record<string, unknown> | null)?.kind === CUSTOM_DOMAIN_PLAN_KIND,
    )
    if (!plan) return res.json({ active: false, reason: 'no_plan' })

    const rows: any[] = await (subs as any)
      .listSubscriptions(
        { plan_id: plan.id, clerk_user_id: sellerClerkId },
        { take: 50 },
      )
      .catch(() => [])

    const active = rows.some((r) => LIVE_STATUSES.has(r?.status))
    return res.json({
      active,
      plan_id: plan.id,
      stripe_price_id: plan.stripe_price_id ?? null,
      price_cents: plan.price_cents ?? null,
    })
  } catch (e) {
    console.error('[custom-domain-subscription] lookup failed:', e)
    return res.json({ active: false, reason: 'error' })
  }
}

// The lapse path. Its write is the shared conditional statement (`setPlatformSkuSubscriptionStatus`,
// `src/lib/plan-kind.ts`): it lands, and it never moves a row out of `canceled`. Until 2026-11 this called
// `updateSubscriptions(r.id, { status })` — the id as the data argument — so no status sent here was ever written.
export const PATCH = platformSkuStatusHandler({
  kind: CUSTOM_DOMAIN_PLAN_KIND,
  label: 'dominio propio',
  logTag: 'custom-domain-subscription',
})
