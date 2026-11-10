import { NEGOCIO_PLAN_KIND, findNegocioPlan, negocioPlans } from '../negocio-plan'
import { liveSubscription, plansOfKind } from '../plan-kind'
import {
  TIENDA_DEFAULT_MONTHLY_CENTS,
  TIENDA_PLAN_KIND,
  TIENDA_PLAN_SPEC,
  findTiendaPlan,
  tiendaPlans,
} from '../tienda-plan'

/**
 * Plan Tienda is the second paid plan. The decisions are the ones Negocio runs (`plan-kind.ts`); what THIS spec
 * pins is that the two kinds never resolve to each other. A Tienda payment ($29) reading as Negocio ($149) gives
 * the bigger plan away; the reverse charges a merchant for a plan they do not get.
 */
describe('Plan Tienda constants', () => {
  it('is kind tienda_plan at $29 MXN a month', () => {
    expect(TIENDA_PLAN_KIND).toBe('tienda_plan')
    expect(TIENDA_DEFAULT_MONTHLY_CENTS).toBe(2900)
    expect(TIENDA_PLAN_SPEC).toMatchObject({ kind: 'tienda_plan', label: 'Tienda', defaultMonthlyCents: 2900 })
    expect(TIENDA_PLAN_SPEC.description).toContain('Miyagi Sánchez')
  })
})

describe('findTiendaPlan', () => {
  const plans = [
    { id: 'ml', metadata: { kind: 'ml_sync_plan' } },
    { id: 'neg', metadata: { kind: NEGOCIO_PLAN_KIND } },
    { id: 'tie', metadata: { kind: TIENDA_PLAN_KIND } },
    { id: 'sub', metadata: { kind: 'subdomain_plan' } },
  ]

  it('picks the Tienda plan among the other platform plans, and Negocio still picks its own', () => {
    expect(findTiendaPlan(plans)?.id).toBe('tie')
    expect(findNegocioPlan(plans)?.id).toBe('neg')
  })

  it('answers null when only Negocio is seeded: never the other paid plan', () => {
    const onlyNegocio = plans.filter((p) => p.id !== 'tie')
    expect(findTiendaPlan(onlyNegocio)).toBeNull()
    expect(tiendaPlans(onlyNegocio)).toEqual([])
    expect(findTiendaPlan([{ id: 'x', metadata: null }])).toBeNull()
    expect(findTiendaPlan([])).toBeNull()
  })

  it('answers null for Negocio when only Tienda is seeded', () => {
    const onlyTienda = plans.filter((p) => p.id !== 'neg')
    expect(findNegocioPlan(onlyTienda)).toBeNull()
    expect(negocioPlans(onlyTienda)).toEqual([])
  })

  it('orders duplicates oldest first, so every reader resolves the same plan', () => {
    const dup = [
      { id: 'newer', created_at: '2026-11-10T00:00:00Z', metadata: { kind: TIENDA_PLAN_KIND } },
      { id: 'neg', created_at: '2026-11-01T00:00:00Z', metadata: { kind: NEGOCIO_PLAN_KIND } },
      { id: 'older', created_at: '2026-11-09T00:00:00Z', metadata: { kind: TIENDA_PLAN_KIND } },
    ]
    expect(tiendaPlans(dup).map((p) => p.id)).toEqual(['older', 'newer'])
    expect(findTiendaPlan(dup)?.id).toBe('older')
    expect(findTiendaPlan([...dup].reverse())?.id).toBe('older')
  })
})

describe('plansOfKind has no wildcard', () => {
  it('an empty kind matches nothing, not the plans that have no kind', () => {
    const plans = [{ id: 'a', metadata: {} }, { id: 'b', metadata: null }, { id: 'c', metadata: { kind: '' } }]
    expect(plansOfKind(plans, '')).toEqual([])
  })
})

describe('liveSubscription with a plan id', () => {
  it('refuses a live row of ANOTHER plan for the same shop', () => {
    const rows = [{ status: 'active', seller_id: 'shop', plan_id: 'neg', stripe_subscription_id: 'sub_neg' }]
    expect(liveSubscription(rows, 'shop', 'tie')).toBeNull()
    expect(liveSubscription(rows, 'shop', 'neg')?.stripe_subscription_id).toBe('sub_neg')
  })

  it('a row with no plan id does not match a named plan: unknown is not a match', () => {
    expect(liveSubscription([{ status: 'active', seller_id: 'shop' }], 'shop', 'tie')).toBeNull()
  })

  it('finds this plan\'s live row behind another plan\'s', () => {
    const rows = [
      { status: 'active', seller_id: 'shop', plan_id: 'neg', stripe_subscription_id: 'sub_neg' },
      { status: 'trialing', seller_id: 'shop', plan_id: 'tie', stripe_subscription_id: 'sub_tie' },
    ]
    expect(liveSubscription(rows, 'shop', 'tie')?.stripe_subscription_id).toBe('sub_tie')
  })

  it('keeps the per-shop and live-status rules', () => {
    expect(liveSubscription([{ status: 'active', seller_id: 'other', plan_id: 'tie' }], 'shop', 'tie')).toBeNull()
    expect(liveSubscription([{ status: 'canceled', seller_id: 'shop', plan_id: 'tie' }], 'shop', 'tie')).toBeNull()
    expect(liveSubscription([{ status: 'past_due', seller_id: 'shop', plan_id: 'tie' }], 'shop', 'tie')).not.toBeNull()
    expect(liveSubscription([{ status: 'active', seller_id: 'shop', plan_id: 'tie' }], '', 'tie')).toBeNull()
  })
})
