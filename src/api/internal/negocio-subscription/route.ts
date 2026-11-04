/**
 * GET /internal/negocio-subscription?seller_clerk_id=...&shop_id=...
 *
 * Source of truth for "does this seller have a LIVE monthly Negocio subscription?" (epic 08 · plans-gratis-negocio
 * S1.1, README D1/D3). A clone of `/internal/ml-sync-subscription` onto the Negocio plan. The Storefront's plan
 * composer (`lib/plan-server.ts`) feeds `active` into the pure `derivePlan` seam.
 *
 * Negocio is per SHOP (README D1): with `shop_id` (the marketplace shop id the webhook records as the subscription's
 * `seller_id`), only that shop's subscription counts. Returns `{ active, plan_id, stripe_price_id, price_cents,
 * subscription_id }`; on a failed subscription read it still returns the resolved `plan_id` with `reason: 'error'`,
 * so the activation webhook can record a paid subscription even when this seller's rows could not be listed. Every
 * failure answers `active: false` with a `reason`, so a backend hiccup never grants Negocio.
 *
 * PATCH /internal/negocio-subscription  { stripe_subscription_id, status }
 *   — the lapse path: the Stripe webhook knows only the Stripe subscription id, and entitlement reads Medusa.
 *   Answers `{ updated }` counting rows that actually changed, so a silent no-op is visible to the caller.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET (`internalSecretOk`).
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'
import { NEGOCIO_SETTABLE_STATUSES, findNegocioPlan, liveSubscription } from '../../../lib/negocio-plan'
import { internalSecretOk } from '../../../lib/internal-auth'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })

  const sellerClerkId = req.query.seller_clerk_id as string | undefined
  if (!sellerClerkId) {
    return res.status(400).json({ message: 'seller_clerk_id query param is required' })
  }

  const shopId = (req.query.shop_id as string | undefined) || null
  const subs = req.scope.resolve(SUBSCRIPTIONS_MODULE) as SubscriptionsModuleService

  let plan: any = null
  try {
    plan = findNegocioPlan(await (subs as any).listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 }))
  } catch (e) {
    // "Could not look" is reported as such — never a confident `no_plan`.
    console.error('[negocio-subscription] plan lookup failed:', e)
    return res.json({ active: false, reason: 'error', plan_id: null })
  }
  if (!plan) return res.json({ active: false, reason: 'no_plan', plan_id: null })

  const planFields = {
    plan_id: plan.id,
    stripe_price_id: plan.stripe_price_id ?? null,
    price_cents: plan.price_cents ?? null,
  }
  try {
    const rows: any[] = await (subs as any).listSubscriptions(
      { plan_id: plan.id, clerk_user_id: sellerClerkId },
      { take: 50 },
    )
    const live = liveSubscription(rows, shopId)
    return res.json({ active: !!live, ...planFields, subscription_id: live?.stripe_subscription_id ?? null })
  } catch (e) {
    console.error('[negocio-subscription] subscription lookup failed:', e)
    return res.json({ active: false, reason: 'error', ...planFields, subscription_id: null })
  }
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })

  const body = (req.body ?? {}) as { stripe_subscription_id?: string; status?: string }
  if (!body.stripe_subscription_id || !body.status) {
    return res.status(400).json({ message: 'stripe_subscription_id and status are required' })
  }
  if (!NEGOCIO_SETTABLE_STATUSES.has(body.status)) {
    return res.status(400).json({ message: `unsupported status: ${body.status}` })
  }

  const subs = req.scope.resolve(SUBSCRIPTIONS_MODULE) as SubscriptionsModuleService
  // No `.catch`: a failed read is a 500 the caller treats as a failure, never `updated: 0` ("no such row").
  const plan = findNegocioPlan(await (subs as any).listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 }))
  if (!plan) return res.status(409).json({ message: 'Negocio plan is not seeded' })
  // Scoped to the Negocio plan: this route can only ever lapse a Negocio subscription.
  const rows: any[] = await (subs as any)
    .listSubscriptions({ stripe_subscription_id: body.stripe_subscription_id, plan_id: plan.id }, { take: 50 })

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
