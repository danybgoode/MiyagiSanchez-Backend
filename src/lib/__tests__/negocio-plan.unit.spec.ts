import { NEGOCIO_PLAN_KIND, findNegocioPlan, liveSubscription } from '../negocio-plan'

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

describe('liveSubscription', () => {
  it('counts active, trialing and past_due as live (past_due is the card-retry grace window)', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(liveSubscription([{ status, stripe_subscription_id: 'sub_1' }])?.stripe_subscription_id).toBe('sub_1')
    }
  })

  it('never counts canceled, an unknown status or a missing status as live', () => {
    expect(liveSubscription([{ status: 'canceled' }])).toBeNull()
    expect(liveSubscription([{ status: 'incomplete_expired' }])).toBeNull()
    expect(liveSubscription([{ status: null }, {}])).toBeNull()
  })

  it('finds the live row behind a canceled one', () => {
    const rows = [
      { status: 'canceled', stripe_subscription_id: 'old' },
      { status: 'active', stripe_subscription_id: 'new' },
    ]
    expect(liveSubscription(rows)?.stripe_subscription_id).toBe('new')
  })
})
