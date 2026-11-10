/**
 * GET /internal/ml-sync-subscription?seller_clerk_id=...
 *
 * Source of truth for the ML-sync paid entitlement (epic 03 · mercadolibre-sync,
 * Sprint 6): "does this seller have a LIVE subscription to the platform ML-sync
 * plan?" A faithful clone of `/internal/subdomain-subscription`. The frontend bridge
 * (lib/ml-sync-subscription.ts) calls this to derive `hasActiveSubscription` for the
 * ML-sync entitlement seam (`lib/ml-sync-entitlement-server.ts`).
 *
 * Returns `{ active, plan_id, stripe_price_id, price_cents, monthly_stripe_price_id,
 * monthly_price_cents, subscription_id }`. `active` is true iff a Subscription row
 * exists for that seller against the platform ML-sync plan with status in
 * LIVE_STATUSES. Fails closed to `{ active: false }` on any lookup error (the gate
 * simply stays closed — never wrongly grants).
 *
 * PATCH /internal/ml-sync-subscription  { stripe_subscription_id, status }
 *   — flips the Medusa Subscription status by its Stripe id (lapse path: the webhook
 *   only has the Stripe subscription id, and entitlement reads Medusa).
 *
 * The ML-sync plan is a DISTINCT row (metadata.kind === 'ml_sync_plan'), so its
 * subscriptions are naturally separated from the other SKUs by plan_id.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'
import { ML_SYNC_PLAN_KIND } from '../setup-ml-sync-plan/route'
import { platformSkuStatusHandler } from '../_utils/plan-routes'

// `past_due` counts as live: it's a grace window while Stripe retries the card, so a
// transient payment failure never collapses the seller's sync. Only a definitive
// `canceled` lapses it.
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

    // Resolve the platform ML-sync plan.
    const platformPlans: any[] = await (subs as any)
      .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
      .catch(() => [])
    const plan = platformPlans.find(
      (p) => (p?.metadata as Record<string, unknown> | null)?.kind === ML_SYNC_PLAN_KIND,
    )
    if (!plan) return res.json({ active: false, reason: 'no_plan' })

    const rows: any[] = await (subs as any)
      .listSubscriptions({ plan_id: plan.id, clerk_user_id: sellerClerkId }, { take: 50 })
      .catch(() => [])

    const active = rows.some((r) => LIVE_STATUSES.has(r?.status))
    const liveRow = rows.find((r) => LIVE_STATUSES.has(r?.status))
    const meta = (plan.metadata ?? {}) as Record<string, unknown>
    return res.json({
      active,
      plan_id: plan.id,
      stripe_price_id: plan.stripe_price_id ?? null,
      price_cents: plan.price_cents ?? null,
      monthly_stripe_price_id: (meta.monthly_stripe_price_id as string | undefined) ?? null,
      monthly_price_cents: (meta.monthly_price_cents as number | undefined) ?? null,
      subscription_id: liveRow?.stripe_subscription_id ?? null,
    })
  } catch (e) {
    console.error('[ml-sync-subscription] lookup failed:', e)
    return res.json({ active: false, reason: 'error' })
  }
}

// The lapse path. Its write is the shared conditional statement (`setPlatformSkuSubscriptionStatus`,
// `src/lib/plan-kind.ts`): it lands, and it never moves a row out of `canceled`. Until 2026-11 this called
// `updateSubscriptions(r.id, { status })` — the id as the data argument — so no status sent here was ever written.
export const PATCH = platformSkuStatusHandler({
  kind: ML_SYNC_PLAN_KIND,
  label: 'sincronización con Mercado Libre',
  logTag: 'ml-sync-subscription',
})
