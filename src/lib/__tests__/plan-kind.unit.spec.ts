import { NEGOCIO_PLAN_SPEC } from '../negocio-plan'
import {
  readPlanSubscription,
  setPlanSubscriptionStatus,
  setupPlanOfKind,
  type PlanDeps,
  type PlanKindSpec,
  type PlanStore,
} from '../plan-kind'
import { TIENDA_PLAN_SPEC } from '../tienda-plan'

/**
 * The bodies of the paid plans' internal routes, over an in-memory store. Money entitlements: each spec below is a
 * way a merchant is charged for a plan they do not get, or handed one they did not pay for.
 *
 * The store filters by equality on every key it is given, like the module's list query. `leaky` drops the
 * `plan_id` filter, to prove the row-level check holds when the query filter does not.
 */
type Row = Record<string, any>

function makeStore(seed: { plans?: Row[]; subscriptions?: Row[] } = {}, opts: { leaky?: boolean } = {}) {
  const plans: Row[] = (seed.plans ?? []).map((p) => ({ ...p }))
  const subscriptions: Row[] = (seed.subscriptions ?? []).map((s) => ({ ...s }))
  const calls = { createPlan: 0, updatePlan: [] as Row[], updateSub: [] as Array<{ id: string; data: Row }> }
  let n = 0
  const match = (row: Row, filters: Row) => Object.entries(filters).every(([k, v]) => row[k] === v)
  const subs: PlanStore = {
    listSubscriptionPlans: async (filters) => plans.filter((p) => match(p, filters)).map((p) => ({ ...p })),
    createSubscriptionPlans: async (data) => {
      calls.createPlan++
      const plan = { id: `subplan_new_${++n}`, created_at: new Date(Date.UTC(2026, 10, 9, 0, 0, n)).toISOString(), ...data }
      plans.push(plan)
      return { ...plan }
    },
    updateSubscriptionPlans: async (data) => {
      calls.updatePlan.push(data)
      const plan = plans.find((p) => p.id === data.id)!
      Object.assign(plan, data)
      return { ...plan }
    },
    listSubscriptions: async (filters) => {
      const { plan_id: _dropped, ...rest } = filters
      const used = opts.leaky ? rest : filters
      return subscriptions.filter((s) => match(s, used)).map((s) => ({ ...s }))
    },
    // Like the real generated method: ONE argument, the row found by its `id`. A call in the old
    // `(id, { status })` shape carries no id here and throws, as it fails to reach the row in Medusa.
    updateSubscriptions: async (data, ...rest: unknown[]) => {
      if (rest.length > 0 || typeof data?.id !== 'string') throw new Error('Subscription with id "" not found')
      const { id, ...fields } = data
      calls.updateSub.push({ id, data: fields })
      Object.assign(subscriptions.find((s) => s.id === id)!, fields)
      return {}
    },
  }
  const deps: PlanDeps = { subs, platformSellerId: 'platform' }
  return { deps, plans, subscriptions, calls }
}

const NEG = { id: 'subplan_neg', seller_id: 'platform', created_at: '2026-11-05T00:00:00Z', stripe_price_id: 'price_neg', price_cents: 14900, label: 'Negocio', metadata: { kind: 'negocio_plan' } }
const TIE = { id: 'subplan_tie', seller_id: 'platform', created_at: '2026-11-09T00:00:00Z', stripe_price_id: 'price_tie', price_cents: 2900, label: 'Tienda', metadata: { kind: 'tienda_plan' } }
const ML = { id: 'subplan_ml', seller_id: 'platform', created_at: '2026-07-01T00:00:00Z', stripe_price_id: 'price_ml', price_cents: 9900, label: 'ML', metadata: { kind: 'ml_sync_plan' } }

const sub = (id: string, plan: Row, over: Row = {}): Row => ({
  id, plan_id: plan.id, clerk_user_id: 'user_1', seller_id: 'shop_1', status: 'active', stripe_subscription_id: `stripe_${id}`, ...over,
})

const BOTH: Array<[string, PlanKindSpec, Row, Row]> = [
  ['tienda', TIENDA_PLAN_SPEC, TIE, NEG],
  ['negocio', NEGOCIO_PLAN_SPEC, NEG, TIE],
]

describe('setupPlanOfKind — Plan Tienda', () => {
  it('creates the Tienda plan when absent: 201, platform-owned, monthly, $29 by default', async () => {
    const s = makeStore({ plans: [NEG, ML] })
    const a = await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)
    expect(a.status).toBe(201)
    expect(a.body.created).toBe(true)
    expect(a.body.plan).toMatchObject({
      seller_id: 'platform', product_id: null, mp_plan_id: null, label: 'Tienda', price_cents: 2900, currency: 'mxn',
      interval: 'month', stripe_price_id: 'price_tie', is_active: true, metadata: { kind: 'tienda_plan' },
    })
    expect(s.plans).toHaveLength(3)
  })

  it('never rewrites the Negocio plan (or any other kind) when Tienda is absent', async () => {
    const s = makeStore({ plans: [NEG, ML] })
    await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)
    expect(s.calls.updatePlan).toEqual([])
    expect(s.plans.find((p) => p.id === 'subplan_neg')).toEqual(NEG)
    expect(s.plans.find((p) => p.id === 'subplan_ml')).toEqual(ML)
  })

  it('a second run updates the same plan in place: 200, never a second one', async () => {
    const s = makeStore({ plans: [NEG] })
    const first = await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)
    const second = await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie_v2', price_cents: 3500 }, s.deps)
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(false)
    expect((second.body.plan as Row).id).toBe((first.body.plan as Row).id)
    expect(second.body.plan).toMatchObject({ stripe_price_id: 'price_tie_v2', price_cents: 3500 })
    expect(s.calls.createPlan).toBe(1)
    expect(s.plans.filter((p) => p.metadata?.kind === 'tienda_plan')).toHaveLength(1)
    expect(s.plans.find((p) => p.id === 'subplan_neg')).toEqual(NEG)
  })

  it('keeps the plan\'s other metadata on an update', async () => {
    const s = makeStore({ plans: [{ ...TIE, metadata: { kind: 'tienda_plan', stripe_product_id: 'prod_1' } }] })
    const a = await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)
    expect((a.body.plan as Row).metadata).toEqual({ kind: 'tienda_plan', stripe_product_id: 'prod_1' })
  })

  it('a by-id update that answers an array is normalized to the one plan', async () => {
    const s = makeStore({ plans: [TIE] })
    s.deps.subs.updateSubscriptionPlans = async (data) => [{ ...TIE, ...data }]
    const a = await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)
    expect((a.body.plan as Row).id).toBe('subplan_tie')
  })

  it('refuses two Tienda plans with a 409 and writes nothing', async () => {
    const s = makeStore({ plans: [TIE, { ...TIE, id: 'subplan_tie_2', created_at: '2026-11-10T00:00:00Z', stripe_price_id: 'price_tie_2' }, NEG] })
    const a = await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)
    expect(a.status).toBe(409)
    expect(a.body.plan_ids).toEqual(['subplan_tie', 'subplan_tie_2'])
    expect(s.calls.createPlan).toBe(0)
    expect(s.calls.updatePlan).toEqual([])
  })

  it('two NEGOCIO plans do not block the Tienda seed: the duplicate check is per kind', async () => {
    const s = makeStore({ plans: [NEG, { ...NEG, id: 'subplan_neg_2', stripe_price_id: 'price_neg_2' }] })
    expect((await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)).status).toBe(201)
  })

  it('a failed plan read throws (a 500) and creates nothing: never "no plan yet"', async () => {
    const s = makeStore()
    s.deps.subs.listSubscriptionPlans = async () => { throw new Error('db down') }
    await expect(setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie' }, s.deps)).rejects.toThrow('db down')
    expect(s.calls.createPlan).toBe(0)
  })

  it('requires stripe_price_id (400) before reading anything', async () => {
    const s = makeStore()
    let reads = 0
    s.deps.subs.listSubscriptionPlans = async () => { reads++; return [] }
    for (const body of [{}, { stripe_price_id: '' }, { stripe_price_id: 123 }]) {
      expect((await setupPlanOfKind(TIENDA_PLAN_SPEC, body, s.deps)).status).toBe(400)
    }
    expect(reads).toBe(0)
  })

  it('falls back to the plan\'s own default for a price that is not a positive integer', async () => {
    for (const price_cents of [0, -5, 29.5, '2900', null, undefined]) {
      const s = makeStore()
      const a = await setupPlanOfKind(TIENDA_PLAN_SPEC, { stripe_price_id: 'price_tie', price_cents }, s.deps)
      expect((a.body.plan as Row).price_cents).toBe(2900)
    }
    const s = makeStore()
    const neg = await setupPlanOfKind(NEGOCIO_PLAN_SPEC, { stripe_price_id: 'price_neg' }, s.deps)
    expect((neg.body.plan as Row).price_cents).toBe(14900)
  })
})

describe.each(BOTH)('setupPlanOfKind — a Stripe price is never shared (%s)', (_name, spec, own, other) => {
  it('refuses the OTHER paid plan\'s price id with a 409 and writes nothing', async () => {
    for (const plans of [[other], [own, other]]) {
      const s = makeStore({ plans })
      const a = await setupPlanOfKind(spec, { stripe_price_id: other.stripe_price_id }, s.deps)
      expect(a.status).toBe(409)
      expect(a.body.plan_ids).toEqual([other.id])
      expect(s.calls.createPlan).toBe(0)
      expect(s.calls.updatePlan).toEqual([])
    }
  })

  it('re-seeding a plan with its OWN price is not a clash', async () => {
    const s = makeStore({ plans: [own, other] })
    expect((await setupPlanOfKind(spec, { stripe_price_id: own.stripe_price_id }, s.deps)).status).toBe(200)
  })
})

describe.each(BOTH)('readPlanSubscription — %s never reads the other plan', (_name, spec, own, other) => {
  const q = { seller_clerk_id: 'user_1', shop_id: 'shop_1' }

  it('a live subscription to the OTHER plan is not this plan', async () => {
    const s = makeStore({ plans: [NEG, TIE], subscriptions: [sub('other', other)] })
    const a = await readPlanSubscription(spec, q, s.deps)
    expect(a).toEqual({
      status: 200,
      body: { active: false, plan_id: own.id, stripe_price_id: own.stripe_price_id, price_cents: own.price_cents, subscription_id: null },
    })
  })

  it('still refuses the other plan\'s row when the query filter leaks it', async () => {
    const s = makeStore({ plans: [NEG, TIE], subscriptions: [sub('other', other)] }, { leaky: true })
    const a = await readPlanSubscription(spec, q, s.deps)
    expect(a.body.active).toBe(false)
    expect(a.body.subscription_id).toBeNull()
  })

  it('a shop holding BOTH gets each plan\'s own subscription id', async () => {
    const s = makeStore({ plans: [NEG, TIE], subscriptions: [sub('other', other), sub('own', own)] }, { leaky: true })
    const a = await readPlanSubscription(spec, q, s.deps)
    expect(a.body).toMatchObject({ active: true, plan_id: own.id, subscription_id: 'stripe_own' })
  })

  it('with only the OTHER plan seeded it answers no_plan, never that plan', async () => {
    const s = makeStore({ plans: [other], subscriptions: [sub('other', other)] })
    expect(await readPlanSubscription(spec, q, s.deps)).toEqual({ status: 200, body: { active: false, reason: 'no_plan', plan_id: null } })
  })
})

describe('readPlanSubscription — Plan Tienda', () => {
  const q = { seller_clerk_id: 'user_1', shop_id: 'shop_1' }

  it('requires seller_clerk_id and shop_id (400): a missing shop never means any shop', async () => {
    const s = makeStore({ plans: [TIE], subscriptions: [sub('a', TIE)] })
    expect((await readPlanSubscription(TIENDA_PLAN_SPEC, { shop_id: 'shop_1' }, s.deps)).status).toBe(400)
    expect((await readPlanSubscription(TIENDA_PLAN_SPEC, { seller_clerk_id: 'user_1' }, s.deps)).status).toBe(400)
    expect((await readPlanSubscription(TIENDA_PLAN_SPEC, { seller_clerk_id: 'user_1', shop_id: '' }, s.deps)).status).toBe(400)
    // An array (`?shop_id=a&shop_id=b`) is not a shop id.
    expect((await readPlanSubscription(TIENDA_PLAN_SPEC, { seller_clerk_id: 'user_1', shop_id: ['shop_1'] }, s.deps)).status).toBe(400)
  })

  it('is per shop and per person', async () => {
    const s = makeStore({ plans: [TIE], subscriptions: [sub('a', TIE, { seller_id: 'shop_2' }), sub('b', TIE, { clerk_user_id: 'user_2' })] })
    expect((await readPlanSubscription(TIENDA_PLAN_SPEC, q, s.deps)).body.active).toBe(false)
    expect((await readPlanSubscription(TIENDA_PLAN_SPEC, { seller_clerk_id: 'user_1', shop_id: 'shop_2' }, s.deps)).body.active).toBe(true)
  })

  it('trialing (bought during the free months) and past_due are live; canceled and pending are not', async () => {
    for (const [status, active] of [['trialing', true], ['past_due', true], ['active', true], ['canceled', false], ['pending', false]] as const) {
      const s = makeStore({ plans: [TIE], subscriptions: [sub('a', TIE, { status })] })
      expect((await readPlanSubscription(TIENDA_PLAN_SPEC, q, s.deps)).body.active).toBe(active)
    }
  })

  it('a failed plan read is "error", never a confident no_plan', async () => {
    const s = makeStore({ plans: [TIE] })
    const logged: string[] = []
    s.deps.logError = (m) => logged.push(m)
    s.deps.subs.listSubscriptionPlans = async () => { throw new Error('db down') }
    expect(await readPlanSubscription(TIENDA_PLAN_SPEC, q, s.deps)).toEqual({ status: 200, body: { active: false, reason: 'error', plan_id: null } })
    expect(logged).toEqual(['[tienda-subscription] plan lookup failed:'])
  })

  it('a failed subscription read never grants, and still hands back the plan so a paid activation can be recorded', async () => {
    const s = makeStore({ plans: [TIE, NEG] })
    s.deps.subs.listSubscriptions = async () => { throw new Error('db down') }
    expect(await readPlanSubscription(TIENDA_PLAN_SPEC, q, s.deps)).toEqual({
      status: 200,
      body: { active: false, reason: 'error', plan_id: 'subplan_tie', stripe_price_id: 'price_tie', price_cents: 2900, subscription_id: null },
    })
  })
})

describe.each(BOTH)('setPlanSubscriptionStatus — %s can only lapse its own plan', (_name, spec, own, other) => {
  it('cancelling by a Stripe id that belongs to the OTHER plan updates nothing', async () => {
    const s = makeStore({ plans: [NEG, TIE], subscriptions: [sub('other', other, { stripe_subscription_id: 'sub_X' })] })
    const a = await setPlanSubscriptionStatus(spec, { stripe_subscription_id: 'sub_X', status: 'canceled' }, s.deps)
    expect(a).toEqual({ status: 200, body: { updated: 0 } })
    expect(s.subscriptions[0].status).toBe('active')
  })

  it('still leaves the other plan\'s row alone when the query filter leaks it', async () => {
    const s = makeStore({ plans: [NEG, TIE], subscriptions: [sub('other', other, { stripe_subscription_id: 'sub_X' })] }, { leaky: true })
    const a = await setPlanSubscriptionStatus(spec, { stripe_subscription_id: 'sub_X', status: 'canceled' }, s.deps)
    expect(a.body.updated).toBe(0)
    expect(s.calls.updateSub).toEqual([])
  })

  it('updates its own row and leaves the same shop\'s other-plan subscription live', async () => {
    const s = makeStore({ plans: [NEG, TIE], subscriptions: [sub('own', own), sub('other', other)] })
    const a = await setPlanSubscriptionStatus(spec, { stripe_subscription_id: 'stripe_own', status: 'canceled' }, s.deps)
    expect(a.body.updated).toBe(1)
    expect(s.calls.updateSub).toEqual([{ id: 'own', data: { status: 'canceled' } }])
    expect(s.subscriptions.map((r) => [r.id, r.status])).toEqual([['own', 'canceled'], ['other', 'active']])
  })

  it('answers 409 when its plan is not seeded, even if the other is', async () => {
    const s = makeStore({ plans: [other], subscriptions: [sub('other', other)] })
    const a = await setPlanSubscriptionStatus(spec, { stripe_subscription_id: 'stripe_other', status: 'canceled' }, s.deps)
    expect(a.status).toBe(409)
    expect(a.body.message).toBe(`${spec.label} plan is not seeded`)
    expect(s.calls.updateSub).toEqual([])
  })
})

describe('setPlanSubscriptionStatus — Plan Tienda', () => {
  it('requires both fields and a settable status (400), before reading anything', async () => {
    const s = makeStore({ plans: [TIE], subscriptions: [sub('a', TIE)] })
    let reads = 0
    const list = s.deps.subs.listSubscriptionPlans
    s.deps.subs.listSubscriptionPlans = async (f, c) => { reads++; return list(f, c) }
    for (const body of [
      {}, { stripe_subscription_id: 'stripe_a' }, { status: 'canceled' },
      { stripe_subscription_id: 'stripe_a', status: 'pending' }, { stripe_subscription_id: 'stripe_a', status: 'free_forever' },
    ]) {
      expect((await setPlanSubscriptionStatus(TIENDA_PLAN_SPEC, body, s.deps)).status).toBe(400)
    }
    expect(reads).toBe(0)
    expect(s.subscriptions[0].status).toBe('active')
  })

  it('a replay (the status the row already has) still counts as updated', async () => {
    const s = makeStore({ plans: [TIE], subscriptions: [sub('a', TIE, { status: 'canceled' })] })
    expect((await setPlanSubscriptionStatus(TIENDA_PLAN_SPEC, { stripe_subscription_id: 'stripe_a', status: 'canceled' }, s.deps)).body.updated).toBe(1)
  })

  it('counts only the writes that landed: a failed write is not "updated"', async () => {
    const s = makeStore({ plans: [TIE], subscriptions: [sub('a', TIE, { stripe_subscription_id: 'sub_X' }), sub('b', TIE, { stripe_subscription_id: 'sub_X' })] })
    const logged: string[] = []
    s.deps.logError = (m) => logged.push(m)
    s.deps.subs.updateSubscriptions = async ({ id }) => { if (id === 'a') throw new Error('write failed'); return {} }
    const a = await setPlanSubscriptionStatus(TIENDA_PLAN_SPEC, { stripe_subscription_id: 'sub_X', status: 'past_due' }, s.deps)
    expect(a.body.updated).toBe(1)
    expect(logged).toEqual(['[tienda-subscription] status update failed for a:'])
  })

  it('a failed read throws (a 500), never updated: 0', async () => {
    const s = makeStore({ plans: [TIE] })
    s.deps.subs.listSubscriptions = async () => { throw new Error('db down') }
    await expect(setPlanSubscriptionStatus(TIENDA_PLAN_SPEC, { stripe_subscription_id: 'x', status: 'canceled' }, s.deps)).rejects.toThrow('db down')
  })
})
