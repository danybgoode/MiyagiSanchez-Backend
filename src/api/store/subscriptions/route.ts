/**
 * POST /store/subscriptions
 *
 * Creates or activates a subscription record in Medusa.
 * Called by the frontend webhook handlers after payment confirmation.
 *
 * This endpoint is intentionally not authenticated at the Clerk level
 * because it is called by the Next.js backend (server-to-server) using
 * a shared secret header instead of a Clerk JWT.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET env var.
 *
 * Body:
 *   plan_id                string   — Medusa SubscriptionPlan ID
 *   buyer_email            string   — required
 *   clerk_user_id?         string   — if buyer is signed in
 *   customer_id?           string   — Medusa Customer ID
 *   status?                string   — defaults to 'active'
 *   payment_method         string   — 'stripe' | 'mercadopago' | 'spei'
 *   stripe_subscription_id? string
 *   stripe_customer_id?    string
 *   mp_preapproval_id?     string
 *   seller_id              string
 *   current_period_start?  string   — ISO date
 *   current_period_end?    string   — ISO date
 *   metadata?              object
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { internalSecretOk } from '../../../lib/internal-auth'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  // ── Internal-secret auth ──────────────────────────────────────────────────
  // Fail CLOSED on a missing secret — see src/lib/internal-auth.ts.
  if (!internalSecretOk(req)) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = req.body as {
    plan_id: string
    buyer_email: string
    clerk_user_id?: string
    customer_id?: string
    status?: string
    payment_method: string
    stripe_subscription_id?: string
    stripe_customer_id?: string
    mp_preapproval_id?: string
    seller_id: string
    current_period_start?: string
    current_period_end?: string
    metadata?: Record<string, unknown>
  }

  if (!body.plan_id || !body.buyer_email || !body.seller_id || !body.payment_method) {
    return res.status(400).json({
      message: 'plan_id, buyer_email, seller_id, and payment_method are required',
    })
  }

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)

  // Check if subscription already exists (idempotency)
  let existing: any[] = []
  try {
    const filters: Record<string, unknown> = {
      plan_id: body.plan_id,
      buyer_email: body.buyer_email,
    }
    if (body.stripe_subscription_id) {
      filters.stripe_subscription_id = body.stripe_subscription_id
    }
    existing = await (subsService as any).listSubscriptions(filters, { take: 1 }).catch(() => [])
  } catch { /* non-fatal */ }

  if (existing.length > 0) {
    // A replay (Stripe re-delivered the checkout event) records nothing new and changes NO status.
    //
    // This branch used to "update status if it changed" with `updateSubscriptions(sub.id, { status })` — the id
    // as the data argument — so that write never landed, and removing it changes nothing that runs today. It was
    // removed rather than repaired because, live, it would be wrong:
    //   - Every caller (the Storefront's checkout-completed handlers) sends `status: 'active'`. A replayed or late
    //     checkout event is OLDER than whatever happened since, so writing its `active` over a newer `past_due` or
    //     `canceled` would revive a lapsed or cancelled subscription: a paid plan nobody pays for.
    //   - The status of an existing row is owned by the lapse routes (`/internal/*-subscription` PATCH), which
    //     write it from the subscription's own Stripe events through the conditional statement in
    //     `src/lib/plan-kind.ts`. A second writer here would be a second, unguarded source of truth.
    // The answer is unchanged: the row as it is, `created: false`.
    return res.json({ subscription: existing[0], created: false })
  }

  // Create new subscription record
  const subscription = await (subsService as any).createSubscriptions({
    plan_id: body.plan_id,
    buyer_email: body.buyer_email,
    clerk_user_id: body.clerk_user_id ?? null,
    customer_id: body.customer_id ?? null,
    status: body.status ?? 'active',
    payment_method: body.payment_method,
    stripe_subscription_id: body.stripe_subscription_id ?? null,
    stripe_customer_id: body.stripe_customer_id ?? null,
    mp_preapproval_id: body.mp_preapproval_id ?? null,
    seller_id: body.seller_id,
    current_period_start: body.current_period_start
      ? new Date(body.current_period_start)
      : null,
    current_period_end: body.current_period_end
      ? new Date(body.current_period_end)
      : null,
    cancel_at_period_end: false,
    metadata: body.metadata ?? null,
  })

  return res.status(201).json({ subscription, created: true })
}

// ── GET /store/subscriptions?plan_id=xxx ──────────────────────────────────────
// Light public endpoint — check if a buyer has an active subscription for a plan

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const query = req.query as Record<string, string>
  const planId = query.plan_id
  const buyerEmail = query.buyer_email

  if (!planId || !buyerEmail) {
    return res.status(400).json({ message: 'plan_id and buyer_email are required' })
  }

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)
  const subscriptions = await (subsService as any).listSubscriptions(
    { plan_id: planId, buyer_email: buyerEmail, status: ['active', 'trialing'] },
    { take: 1 }
  ).catch(() => [])

  return res.json({ has_access: subscriptions.length > 0, subscriptions })
}
