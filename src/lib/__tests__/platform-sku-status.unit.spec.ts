import {
  PLATFORM_SKU_SETTABLE_STATUSES,
  setPlatformSkuSubscriptionStatus,
  type PlanDeps,
  type PlanStore,
  type PlatformSkuSpec,
} from '../plan-kind'

/**
 * The lapse body of the older platform SKUs (custom domain, subdomain, ML sync). Their routes used to call
 * `updateSubscriptions(id, { status })`, so no status ever landed. These specs pin that the write now lands, that
 * it lands only on this SKU's rows, and that `canceled` stays final — the guard that keeps a late Stripe event from
 * reviving a cancelled subscription now that the write is live.
 */
type Row = Record<string, any>

const CD = { id: 'subplan_cd', seller_id: 'platform', created_at: '2026-05-01T00:00:00Z', metadata: { kind: 'custom_domain_plan' } }
const CD_DUP = { id: 'subplan_cd2', seller_id: 'platform', created_at: '2026-06-01T00:00:00Z', metadata: { kind: 'custom_domain_plan' } }
const SD = { id: 'subplan_sd', seller_id: 'platform', created_at: '2026-05-02T00:00:00Z', metadata: { kind: 'subdomain_plan' } }
const ML = { id: 'subplan_ml', seller_id: 'platform', created_at: '2026-07-01T00:00:00Z', metadata: { kind: 'ml_sync_plan' } }
const SELLER_PLAN = { id: 'subplan_seller', seller_id: 'shop_9', created_at: '2026-01-01T00:00:00Z', metadata: { kind: 'custom_domain_plan' } }

const SPECS: Record<string, PlatformSkuSpec> = {
  custom_domain: { kind: 'custom_domain_plan', label: 'dominio propio', logTag: 'custom-domain-subscription' },
  subdomain: { kind: 'subdomain_plan', label: 'subdominio', logTag: 'subdomain-subscription' },
  ml_sync: { kind: 'ml_sync_plan', label: 'ML', logTag: 'ml-sync-subscription' },
}
const PLAN_OF: Record<string, Row> = { custom_domain: CD, subdomain: SD, ml_sync: ML }

function makeStore(subscriptions: Row[], plans: Row[] = [CD, SD, ML]) {
  const rows = subscriptions.map((s) => ({ ...s }))
  const writes: Row[] = []
  const match = (row: Row, f: Row) => Object.entries(f).every(([k, v]) => row[k] === v)
  const subs: PlanStore = {
    // Like the module: only platform plans when asked for seller_id 'platform'.
    listSubscriptionPlans: async (f) => plans.filter((p) => match(p, f)).map((p) => ({ ...p })),
    createSubscriptionPlans: async () => { throw new Error('not used') },
    updateSubscriptionPlans: async () => { throw new Error('not used') },
    listSubscriptions: async (f) => rows.filter((r) => match(r, f)).map((r) => ({ ...r })),
  }
  const deps: PlanDeps = {
    subs,
    platformSellerId: 'platform',
    // The conditional statement against the CURRENT rows: write unless cancelled.
    writeStatusUnlessCanceled: async ({ id, planId, status }) => {
      const row = rows.find((r) => r.id === id && r.plan_id === planId && r.status !== 'canceled')
      if (!row) return 0
      writes.push({ id, planId, status })
      row.status = status
      return 1
    },
  }
  return { deps, rows, writes }
}

const row = (id: string, plan: Row, over: Row = {}): Row => ({
  id, plan_id: plan.id, clerk_user_id: 'user_1', seller_id: 'shop_1', status: 'active', stripe_subscription_id: 'sub_X', ...over,
})

describe.each(Object.keys(SPECS))('setPlatformSkuSubscriptionStatus — %s', (name) => {
  const spec = SPECS[name]
  const own = PLAN_OF[name]
  const set = (s: ReturnType<typeof makeStore>, status: string, stripeId = 'sub_X') =>
    setPlatformSkuSubscriptionStatus(spec, { stripe_subscription_id: stripeId, status }, s.deps)

  it('the status LANDS on the row and is counted', async () => {
    const s = makeStore([row('a', own)])
    expect(await set(s, 'past_due')).toEqual({ status: 200, body: { updated: 1 } })
    expect(s.rows[0].status).toBe('past_due')
    expect(s.writes).toEqual([{ id: 'a', planId: own.id, status: 'past_due' }])
    expect(await set(s, 'canceled')).toEqual({ status: 200, body: { updated: 1 } })
    expect(s.rows[0].status).toBe('canceled')
  })

  it.each(['active', 'past_due', 'trialing'])('a late %s after the cancellation leaves the row canceled, and still counts it', async (late) => {
    const s = makeStore([row('a', own, { status: 'canceled' })])
    expect(await set(s, late)).toEqual({ status: 200, body: { updated: 1 } })
    expect(s.rows[0].status).toBe('canceled')
    expect(s.writes).toEqual([])
  })

  it('a row read live but cancelled before the write stays canceled (the condition is in the write)', async () => {
    const s = makeStore([row('a', own)])
    const list = s.deps.subs.listSubscriptions
    let first = true
    s.deps.subs.listSubscriptions = async (f, c) => {
      const rows = await list(f, c)
      if (first) { first = false; s.rows[0].status = 'canceled' }
      return rows
    }
    expect(await set(s, 'active')).toEqual({ status: 200, body: { updated: 1 } })
    expect(s.rows[0].status).toBe('canceled')
  })

  it('touches only rows on a plan of THIS kind, even when another SKU\'s row shares the Stripe id', async () => {
    const others = Object.values(PLAN_OF).filter((p) => p !== own)
    const s = makeStore([row('mine', own), ...others.map((p, i) => row(`other${i}`, p))])
    expect((await set(s, 'canceled')).body.updated).toBe(1)
    expect(s.rows.find((r) => r.id === 'mine')!.status).toBe('canceled')
    expect(s.rows.filter((r) => r.id !== 'mine').map((r) => r.status)).toEqual(others.map(() => 'active'))
  })

  it('a row on a SELLER\'s plan with the same kind label is never touched (platform plans only)', async () => {
    const s = makeStore([row('seller', SELLER_PLAN)], [CD, SD, ML, SELLER_PLAN])
    expect((await set(s, 'canceled')).body.updated).toBe(0)
    expect(s.rows[0].status).toBe('active')
  })

  it('no such row is the honest 0', async () => {
    const s = makeStore([row('a', own)])
    expect(await set(s, 'canceled', 'sub_unknown')).toEqual({ status: 200, body: { updated: 0 } })
  })

  it('nothing written and the row still reads live: a failure, not counted', async () => {
    const s = makeStore([row('a', own)])
    s.deps.writeStatusUnlessCanceled = async () => 0
    expect((await set(s, 'canceled')).body.updated).toBe(0)
  })

  it('no plan of this kind seeded: a 409, nothing written', async () => {
    const s = makeStore([row('a', own)], Object.values(PLAN_OF).filter((p) => p !== own))
    expect((await set(s, 'canceled')).status).toBe(409)
    expect(s.rows[0].status).toBe('active')
  })

  it('a failed read throws (a 500), never a confident 0', async () => {
    const s = makeStore([row('a', own)])
    s.deps.subs.listSubscriptions = async () => { throw new Error('db down') }
    await expect(set(s, 'canceled')).rejects.toThrow('db down')
  })
})

describe('setPlatformSkuSubscriptionStatus — contract', () => {
  it('every row of the kind is reachable, including one on a duplicate plan seed', async () => {
    const s = makeStore([row('a', CD), row('b', CD_DUP)], [CD, CD_DUP, SD, ML])
    expect((await setPlatformSkuSubscriptionStatus(SPECS.custom_domain, { stripe_subscription_id: 'sub_X', status: 'canceled' }, s.deps)).body.updated).toBe(2)
    expect(s.rows.map((r) => r.status)).toEqual(['canceled', 'canceled'])
  })

  it('accepts exactly the four statuses the Storefront sends; anything else is a 400 with nothing read', async () => {
    expect([...PLATFORM_SKU_SETTABLE_STATUSES].sort()).toEqual(['active', 'canceled', 'past_due', 'trialing'])
    const s = makeStore([row('a', CD)])
    s.deps.subs.listSubscriptions = async () => { throw new Error('must not read') }
    for (const status of ['unpaid', 'paused', 'incomplete', 'pending', 'constructor', '']) {
      expect((await setPlatformSkuSubscriptionStatus(SPECS.custom_domain, { stripe_subscription_id: 'sub_X', status }, s.deps)).status).toBe(400)
    }
    expect((await setPlatformSkuSubscriptionStatus(SPECS.custom_domain, { status: 'canceled' }, s.deps)).status).toBe(400)
  })
})
