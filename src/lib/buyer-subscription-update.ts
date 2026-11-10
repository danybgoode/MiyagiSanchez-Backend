/**
 * The decisions behind PATCH /store/buyer/me/subscriptions/:id — a signed-in buyer changing their OWN subscription
 * (`cancel_at_period_end`, or `status: 'canceled'`). Pure, so the route stays a shell and every rule is unit-tested.
 *
 * Two rules beyond "it must be yours" (which the route enforces by reading the row with the caller's verified
 * Clerk id in the filter):
 *
 *   1. Only a status of `canceled` can be set, and nothing else in the body is read. A buyer can never set a row
 *      `active`.
 *   2. A subscription to a PLATFORM plan (any plan filed under the platform seller id: Plan Negocio, Plan Tienda,
 *      custom domain, subdomain, ML sync) is refused. Those rows also carry the seller's Clerk id, so they pass the
 *      ownership check — but their status is owned by Stripe through the lapse routes, and this route does not
 *      touch Stripe. Cancelling one here would drop the merchant's plan in Medusa while Stripe kept charging them,
 *      with nothing to put it back. Merchants end a platform plan through the seller flows.
 *      "I could not read the plan" refuses too: an unknown plan is never assumed to be a seller's plan.
 */

export type BuyerSubscriptionAnswer = { status: number; body: Record<string, unknown> }

/** What a buyer's body asks to change, or null when it asks for nothing this route allows. */
export function buyerSubscriptionUpdates(body: unknown): Record<string, unknown> | null {
  const b = (body && typeof body === 'object' ? body : {}) as { cancel_at_period_end?: unknown; status?: unknown }
  const updates: Record<string, unknown> = {}
  if (typeof b.cancel_at_period_end === 'boolean') updates.cancel_at_period_end = b.cancel_at_period_end
  if (b.status === 'canceled') updates.status = 'canceled'
  return Object.keys(updates).length > 0 ? updates : null
}

/** The plan read, in three states: found, known absent, or could not be read. */
export type PlanLookup =
  | { state: 'found'; plan: { seller_id?: string | null } | null | undefined }
  | { state: 'absent' }
  | { state: 'unavailable' }

/** Null when the buyer may change this subscription; otherwise the refusal to send. */
export function buyerPlanRefusal(lookup: PlanLookup, platformSellerId: string): BuyerSubscriptionAnswer | null {
  if (lookup.state === 'unavailable') {
    return { status: 503, body: { message: 'Could not verify this subscription right now. Try again.' } }
  }
  if (lookup.state === 'absent' || !lookup.plan) {
    return { status: 409, body: { message: 'This subscription cannot be changed here.' } }
  }
  // An empty platform id is a misconfiguration under which no plan could be told apart: refuse, never guess.
  if (!platformSellerId || lookup.plan.seller_id === platformSellerId) {
    return {
      status: 409,
      body: { message: 'This is a Miyagi Sánchez plan. Manage it from your shop settings.', code: 'platform_plan' },
    }
  }
  return null
}
