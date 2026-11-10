/**
 * PATCH /store/buyer/me/subscriptions/:id
 *
 * A buyer changes their OWN subscription to a seller's plan: cancel at period end, or cancel now.
 *
 * Body: { cancel_at_period_end?: boolean; status?: 'canceled' }
 *
 * Auth: a Clerk JWT, verified by the `/store/buyer/me` middleware (`src/api/middlewares.ts`); `extractClerkUserId`
 * reads only that verified identity.
 * Security: the row is read with the caller's Clerk id IN the filter, so another person's subscription is a 404.
 * A platform plan's subscription is refused (see `src/lib/buyer-subscription-update.ts`).
 *
 * Medusa only: this does NOT cancel anything in Stripe or Mercado Pago. The row's status changes here; billing at
 * the processor is untouched.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../../../../modules/subscriptions'
import SubscriptionsModuleService from '../../../../../../modules/subscriptions/service'
import { extractClerkUserId } from '../../../../_utils/clerk-auth'
import { PLATFORM_SELLER_ID } from '../../../../../internal/setup-custom-domain-plan/route'
import { buyerPlanRefusal, buyerSubscriptionUpdates, type PlanLookup } from '../../../../../../lib/buyer-subscription-update'

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params

  const subsService: SubscriptionsModuleService = req.scope.resolve(SUBSCRIPTIONS_MODULE)

  // Verify ownership
  let subscription: any = null
  try {
    const [sub] = await (subsService as any).listSubscriptions(
      { id, clerk_user_id: clerkUserId },
      { take: 1 }
    )
    subscription = sub ?? null
  } catch { /* fall through to 404 */ }

  if (!subscription) {
    return res.status(404).json({ message: 'Subscription not found' })
  }

  const updates = buyerSubscriptionUpdates(req.body)
  if (!updates) {
    return res.status(400).json({ message: 'No valid updates provided' })
  }

  // Whose plan is it? Deleted plans are included: a buyer must still be able to cancel a subscription to a plan
  // the seller has since removed.
  let lookup: PlanLookup
  try {
    const [plan] = typeof subscription.plan_id === 'string' && subscription.plan_id
      ? await (subsService as any).listSubscriptionPlans({ id: subscription.plan_id }, { take: 1, withDeleted: true })
      : []
    lookup = plan ? { state: 'found', plan } : { state: 'absent' }
  } catch (e) {
    console.error('[buyer-subscription] plan lookup failed:', e)
    lookup = { state: 'unavailable' }
  }
  const refusal = buyerPlanRefusal(lookup, PLATFORM_SELLER_ID)
  if (refusal) return res.status(refusal.status).json(refusal.body)

  // ONE argument: the generated `updateSubscriptions(data, sharedContext)` takes the id inside the data. The old
  // `updateSubscriptions(id, updates)` passed the id as the data, so every call failed (a 500) and nothing was
  // written. A by-id update returns the single updated row.
  const updated = await (subsService as any).updateSubscriptions({ id: subscription.id, ...updates })

  return res.json({ subscription: Array.isArray(updated) ? updated[0] : updated })
}
