/**
 * GET /internal/subdomain-subscription?seller_clerk_id=...
 *
 * Source of truth for the subdomain paywall entitlement (epic 07 ·
 * subdomain-pricing, Sprint 2): "does this seller have a LIVE subscription to the
 * platform subdomain plan?" A faithful clone of `/internal/custom-domain-subscription`.
 * The frontend bridge (lib/subdomain-subscription.ts) calls this to derive
 * `hasActiveSubscription` for the subdomain entitlement seam.
 *
 * Returns `{ active, plan_id, stripe_price_id, price_cents, monthly_stripe_price_id,
 * monthly_price_cents, subscription_id }` — `active` is true iff a Subscription row
 * exists for that seller against the platform subdomain plan with status in
 * LIVE_STATUSES. The plan fields (yearly column + the Sprint-3 monthly price held in
 * plan metadata) let the frontend's buy route build the Stripe checkout in either
 * cadence in the same call; `subscription_id` is the LIVE row's Stripe subscription
 * id, which the monthly↔yearly switch route prorates. Fails closed to
 * `{ active: false }` on any lookup error (the paywall simply stays gated — never
 * wrongly grants).
 *
 * PATCH /internal/subdomain-subscription  { stripe_subscription_id, status }
 *   — flips the Medusa Subscription status by its Stripe id (lapse path: the
 *   webhook only has the Stripe subscription id, and entitlement reads Medusa, so
 *   the row must be updated there for the gate to flip off).
 *
 * The subdomain plan is a DISTINCT row (metadata.kind === 'subdomain_plan'), so its
 * subscriptions are naturally separated from custom-domain ones by plan_id.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'
import { SUBDOMAIN_PLAN_KIND } from '../setup-subdomain-plan/route'
import { platformSkuStatusHandler } from '../_utils/plan-routes'

// `past_due` counts as live: it's a grace window while Stripe retries the card —
// the subdomain stays white-label so a transient payment failure never collapses
// the seller's site to /s/slug. Only a definitive `canceled` lapses it.
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

    // Resolve the platform subdomain plan.
    const platformPlans: any[] = await (subs as any)
      .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
      .catch(() => [])
    const plan = platformPlans.find(
      (p) => (p?.metadata as Record<string, unknown> | null)?.kind === SUBDOMAIN_PLAN_KIND,
    )
    if (!plan) return res.json({ active: false, reason: 'no_plan' })

    const rows: any[] = await (subs as any)
      .listSubscriptions(
        { plan_id: plan.id, clerk_user_id: sellerClerkId },
        { take: 50 },
      )
      .catch(() => [])

    const active = rows.some((r) => LIVE_STATUSES.has(r?.status))
    const liveRow = rows.find((r) => LIVE_STATUSES.has(r?.status))
    const meta = (plan.metadata ?? {}) as Record<string, unknown>
    return res.json({
      active,
      plan_id: plan.id,
      stripe_price_id: plan.stripe_price_id ?? null,
      price_cents: plan.price_cents ?? null,
      // Sprint 3 — the monthly recurring price ($25/mo) lives on the same plan's
      // metadata (the column stays the yearly one); null until the monthly seed runs.
      monthly_stripe_price_id: (meta.monthly_stripe_price_id as string | undefined) ?? null,
      monthly_price_cents: (meta.monthly_price_cents as number | undefined) ?? null,
      // The LIVE Stripe subscription id — the switch route retrieves it to prorate
      // the price swap on the same subscription (no gap, no double charge).
      subscription_id: liveRow?.stripe_subscription_id ?? null,
    })
  } catch (e) {
    console.error('[subdomain-subscription] lookup failed:', e)
    return res.json({ active: false, reason: 'error' })
  }
}

// The lapse path. Its write is the shared conditional statement (`setPlatformSkuSubscriptionStatus`,
// `src/lib/plan-kind.ts`): it lands, and it never moves a row out of `canceled`. Until 2026-11 this called
// `updateSubscriptions(r.id, { status })` — the id as the data argument — so no status sent here was ever written.
export const PATCH = platformSkuStatusHandler({
  kind: SUBDOMAIN_PLAN_KIND,
  label: 'subdominio',
  logTag: 'subdomain-subscription',
})
