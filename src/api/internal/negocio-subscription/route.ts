/**
 * GET /internal/negocio-subscription?seller_clerk_id=...
 *
 * Source of truth for "does this seller have a LIVE monthly Negocio subscription?" (epic 08 · plans-gratis-negocio
 * S1.1, README D1/D3). A clone of `/internal/ml-sync-subscription` onto the Negocio plan. The Storefront's plan
 * composer (`lib/plan-server.ts`) feeds `active` into the pure `derivePlan` seam.
 *
 * Returns `{ active, plan_id, stripe_price_id, price_cents, subscription_id }`. Fails CLOSED to `{ active: false }`
 * on any lookup error, with a `reason`, so a backend hiccup never grants Negocio.
 *
 * PATCH /internal/negocio-subscription  { stripe_subscription_id, status }
 *   — the lapse path: the Stripe webhook knows only the Stripe subscription id, and entitlement reads Medusa.
 *   Answers `{ updated }` counting rows that actually changed, so a silent no-op is visible to the caller.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'
import { NEGOCIO_SETTABLE_STATUSES, findNegocioPlan, liveSubscription } from '../../../lib/negocio-plan'

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
    const platformPlans: any[] = await (subs as any)
      .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
    const plan = findNegocioPlan(platformPlans)
    if (!plan) return res.json({ active: false, reason: 'no_plan' })

    const rows: any[] = await (subs as any).listSubscriptions(
      { plan_id: plan.id, clerk_user_id: sellerClerkId },
      { take: 50 },
    )
    const live = liveSubscription(rows)
    return res.json({
      active: !!live,
      plan_id: plan.id,
      stripe_price_id: plan.stripe_price_id ?? null,
      price_cents: plan.price_cents ?? null,
      subscription_id: live?.stripe_subscription_id ?? null,
    })
  } catch (e) {
    // A failed read is reported as `reason: 'error'`, never as a confident "no subscription" with no reason —
    // the caller can tell "could not look" from "looked and found none".
    console.error('[negocio-subscription] lookup failed:', e)
    return res.json({ active: false, reason: 'error' })
  }
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as { stripe_subscription_id?: string; status?: string }
  if (!body.stripe_subscription_id || !body.status) {
    return res.status(400).json({ message: 'stripe_subscription_id and status are required' })
  }
  if (!NEGOCIO_SETTABLE_STATUSES.has(body.status)) {
    return res.status(400).json({ message: `unsupported status: ${body.status}` })
  }

  const subs = req.scope.resolve(SUBSCRIPTIONS_MODULE) as SubscriptionsModuleService
  const rows: any[] = await (subs as any)
    .listSubscriptions({ stripe_subscription_id: body.stripe_subscription_id }, { take: 50 })
    .catch(() => [])

  let updated = 0
  for (const r of rows) {
    try {
      await (subs as any).updateSubscriptions(r.id, { status: body.status })
      updated++
    } catch (e) {
      console.error(`[negocio-subscription] status update failed for ${r.id}:`, e)
    }
  }
  return res.json({ updated })
}
