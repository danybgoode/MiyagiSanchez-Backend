import { NEGOCIO_PLAN_KIND, findNegocioPlan, liveSubscription, negocioPlans } from '../negocio-plan'

/**
 * Negocio is a money entitlement: a wrong answer here either charges a merchant for a plan they do not get, or
 * gives the plan away. The routes are thin shells; the decisions are these two functions.
 */
describe('findNegocioPlan', () => {
  it('picks the plan by kind among the other platform plans', () => {
    const plans = [
      { id: 'a', metadata: { kind: 'ml_sync_plan' } },
      { id: 'b', metadata: { kind: NEGOCIO_PLAN_KIND } },
      { id: 'c', metadata: { kind: 'subdomain_plan' } },
    ]
    expect(findNegocioPlan(plans)?.id).toBe('b')
  })

  it('answers null when no plan has been seeded, never another plan', () => {
    expect(findNegocioPlan([{ id: 'a', metadata: { kind: 'ml_sync_plan' } }, { id: 'x', metadata: null }])).toBeNull()
    expect(findNegocioPlan([])).toBeNull()
  })
})

describe('negocioPlans — a duplicate never splits the webhook from the read', () => {
  it('orders duplicates oldest first, so every reader resolves the same plan', () => {
    const plans = [
      { id: 'newer', created_at: '2026-11-05T00:00:00Z', metadata: { kind: NEGOCIO_PLAN_KIND } },
      { id: 'older', created_at: '2026-11-04T00:00:00Z', metadata: { kind: NEGOCIO_PLAN_KIND } },
    ]
    expect(negocioPlans(plans).map((p) => p.id)).toEqual(['older', 'newer'])
    expect(findNegocioPlan(plans)?.id).toBe('older')
    // The same answer whatever order the list query returned them in.
    expect(findNegocioPlan([...plans].reverse())?.id).toBe('older')
  })
})

describe('liveSubscription', () => {
  it('per shop: another shop\'s live subscription does not count, and an empty shop id matches nothing', () => {
    const rows = [{ status: 'active', seller_id: 'shop-a', stripe_subscription_id: 'sub_a' }]
    expect(liveSubscription(rows, 'shop-b')).toBeNull()
    expect(liveSubscription(rows, '')).toBeNull()
    expect(liveSubscription(rows, 'shop-a')?.stripe_subscription_id).toBe('sub_a')
  })

  it('counts active, trialing and past_due as live (past_due is the card-retry grace window)', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(liveSubscription([{ status, seller_id: 's', stripe_subscription_id: 'sub_1' }], 's')?.stripe_subscription_id).toBe('sub_1')
    }
  })

  it('never counts canceled, an unknown status or a missing status as live', () => {
    expect(liveSubscription([{ status: 'canceled', seller_id: 's' }], 's')).toBeNull()
    expect(liveSubscription([{ status: 'incomplete_expired', seller_id: 's' }], 's')).toBeNull()
    expect(liveSubscription([{ status: null, seller_id: 's' }, { seller_id: 's' }], 's')).toBeNull()
  })

  it('finds the live row behind a canceled one', () => {
    const rows = [
      { status: 'canceled', seller_id: 's', stripe_subscription_id: 'old' },
      { status: 'active', seller_id: 's', stripe_subscription_id: 'new' },
    ]
    expect(liveSubscription(rows, 's')?.stripe_subscription_id).toBe('new')
  })
})
