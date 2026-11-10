import { POST as recordSubscription } from '../subscriptions/route'
import { PATCH as buyerPatch } from '../buyer/me/subscriptions/[id]/route'
import { recordVerifiedClerkIdentity } from '../_utils/clerk-verify'
import { buyerPlanRefusal, buyerSubscriptionUpdates } from '../../../lib/buyer-subscription-update'

/**
 * Two store routes that wrote a subscription's status with `updateSubscriptions(id, patch)` — the id as the data
 * argument — so the write never landed. The fake module behaves like Medusa's generated update (ONE data argument;
 * a string as the data has no id and throws), so going back to that call shape turns these red.
 */
const SECRET = 'store-subs-secret'

function harness(seed: { subscriptions?: any[]; plans?: any[]; planLookupFails?: boolean } = {}) {
  const subscriptions = (seed.subscriptions ?? []).map((s) => ({ ...s }))
  const plans = seed.plans ?? []
  const updates: any[] = []
  const created: any[] = []
  const match = (row: any, f: any) => Object.entries(f).every(([k, v]) => row[k] === v)
  const module = {
    listSubscriptions: async (f: any) => subscriptions.filter((s) => match(s, f)).map((s) => ({ ...s })),
    listSubscriptionPlans: async (f: any) => {
      if (seed.planLookupFails) throw new Error('db down')
      return plans.filter((p) => match(p, f))
    },
    createSubscriptions: async (d: any) => { created.push(d); return { id: 'sub_new', ...d } },
    updateSubscriptions: async (data: any) => {
      updates.push(data)
      if (!data || typeof data !== 'object' || typeof data.id !== 'string') throw new Error('Subscription with id "undefined" not found')
      const row = subscriptions.find((s) => s.id === data.id)
      if (!row) throw new Error(`Subscription with id "${data.id}" not found`)
      Object.assign(row, data)
      return { ...row }
    },
  }
  const out: { status: number; body: any } = { status: 200, body: undefined }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  const req = (over: { headers?: any; body?: any; params?: any; clerk?: string | null } = {}) => {
    const r: any = { headers: over.headers ?? {}, body: over.body, params: over.params ?? {}, scope: { resolve: () => module } }
    if (over.clerk !== undefined) recordVerifiedClerkIdentity(r, over.clerk ? { sub: over.clerk } : null)
    return r
  }
  return { module, subscriptions, updates, created, out, res, req }
}

// ── Site 4: POST /store/subscriptions (internal-secret only) ─────────────────────────────────────────────────

describe('POST /store/subscriptions — a replay changes no status', () => {
  let prev: string | undefined
  beforeAll(() => { prev = process.env.MEDUSA_INTERNAL_SECRET; process.env.MEDUSA_INTERNAL_SECRET = SECRET })
  afterAll(() => { process.env.MEDUSA_INTERNAL_SECRET = prev })

  const body = { plan_id: 'plan_1', buyer_email: 'a@b.mx', seller_id: 'shop_1', payment_method: 'stripe', stripe_subscription_id: 'stripe_1', status: 'active' }

  it.each(['canceled', 'past_due'])('a replayed checkout (status active) leaves a %s row as it is', async (now) => {
    const h = harness({ subscriptions: [{ id: 'sub_1', plan_id: 'plan_1', buyer_email: 'a@b.mx', stripe_subscription_id: 'stripe_1', status: now }] })
    await recordSubscription(h.req({ headers: { 'x-internal-secret': SECRET }, body }), h.res)
    expect(h.out.status).toBe(200)
    expect(h.out.body).toEqual({ subscription: expect.objectContaining({ id: 'sub_1', status: now }), created: false })
    expect(h.updates).toEqual([])
    expect(h.subscriptions[0].status).toBe(now)
    expect(h.created).toEqual([])
  })

  it('a first delivery still creates the row with the sent status', async () => {
    const h = harness()
    await recordSubscription(h.req({ headers: { 'x-internal-secret': SECRET }, body }), h.res)
    expect(h.out.status).toBe(201)
    expect(h.created).toEqual([expect.objectContaining({ plan_id: 'plan_1', status: 'active', stripe_subscription_id: 'stripe_1' })])
  })

  it('without the internal secret: 401, nothing read or written', async () => {
    const h = harness({ subscriptions: [{ id: 'sub_1', plan_id: 'plan_1', buyer_email: 'a@b.mx', stripe_subscription_id: 'stripe_1', status: 'canceled' }] })
    await recordSubscription(h.req({ headers: { 'x-publishable-api-key': 'pk_public' }, body }), h.res)
    expect(h.out.status).toBe(401)
    expect(h.updates).toEqual([])
    expect(h.created).toEqual([])
  })
})

// ── Site 5: PATCH /store/buyer/me/subscriptions/:id ─────────────────────────────────────────────────────────────

const SELLER_PLAN = { id: 'plan_seller', seller_id: 'shop_9' }
const PLATFORM_PLAN = { id: 'plan_platform', seller_id: 'platform', metadata: { kind: 'tienda_plan' } }
const mine = (plan: any, over: any = {}) => ({ id: 'sub_1', plan_id: plan.id, clerk_user_id: 'user_buyer', status: 'active', cancel_at_period_end: false, ...over })

describe('PATCH /store/buyer/me/subscriptions/:id', () => {
  it('a buyer cancels their own subscription to a seller\'s plan: the write LANDS', async () => {
    const h = harness({ subscriptions: [mine(SELLER_PLAN)], plans: [SELLER_PLAN] })
    await buyerPatch(h.req({ clerk: 'user_buyer', params: { id: 'sub_1' }, body: { status: 'canceled' } }), h.res)
    expect(h.out.status).toBe(200)
    expect(h.out.body.subscription).toEqual(expect.objectContaining({ id: 'sub_1', status: 'canceled' }))
    expect(h.subscriptions[0].status).toBe('canceled')
    expect(h.updates).toEqual([{ id: 'sub_1', status: 'canceled' }])
  })

  it('cancel at period end lands, and the status is left alone', async () => {
    const h = harness({ subscriptions: [mine(SELLER_PLAN)], plans: [SELLER_PLAN] })
    await buyerPatch(h.req({ clerk: 'user_buyer', params: { id: 'sub_1' }, body: { cancel_at_period_end: true, status: 'active' } }), h.res)
    expect(h.out.status).toBe(200)
    expect(h.subscriptions[0]).toEqual(expect.objectContaining({ cancel_at_period_end: true, status: 'active' }))
    expect(h.updates).toEqual([{ id: 'sub_1', cancel_at_period_end: true }])
  })

  it('someone else\'s subscription is a 404 and nothing is written', async () => {
    const h = harness({ subscriptions: [mine(SELLER_PLAN)], plans: [SELLER_PLAN] })
    await buyerPatch(h.req({ clerk: 'user_other', params: { id: 'sub_1' }, body: { status: 'canceled' } }), h.res)
    expect(h.out.status).toBe(404)
    expect(h.updates).toEqual([])
  })

  it('an unverified caller is a 401', async () => {
    const h = harness({ subscriptions: [mine(SELLER_PLAN)], plans: [SELLER_PLAN] })
    await buyerPatch(h.req({ clerk: null, params: { id: 'sub_1' }, body: { status: 'canceled' } }), h.res)
    expect(h.out.status).toBe(401)
    expect(h.updates).toEqual([])
  })

  it('a PLATFORM plan subscription (the merchant\'s own Plan Tienda) is refused: 409, nothing written', async () => {
    const h = harness({ subscriptions: [mine(PLATFORM_PLAN)], plans: [PLATFORM_PLAN] })
    await buyerPatch(h.req({ clerk: 'user_buyer', params: { id: 'sub_1' }, body: { status: 'canceled' } }), h.res)
    expect(h.out.status).toBe(409)
    expect(h.out.body.code).toBe('platform_plan')
    expect(h.updates).toEqual([])
    expect(h.subscriptions[0].status).toBe('active')
  })

  it('a plan that cannot be read refuses (503) and a plan that is gone refuses (409): unknown is never "a seller\'s"', async () => {
    const failing = harness({ subscriptions: [mine(SELLER_PLAN)], plans: [SELLER_PLAN], planLookupFails: true })
    await buyerPatch(failing.req({ clerk: 'user_buyer', params: { id: 'sub_1' }, body: { status: 'canceled' } }), failing.res)
    expect(failing.out.status).toBe(503)
    expect(failing.updates).toEqual([])

    const gone = harness({ subscriptions: [mine(SELLER_PLAN)], plans: [] })
    await buyerPatch(gone.req({ clerk: 'user_buyer', params: { id: 'sub_1' }, body: { status: 'canceled' } }), gone.res)
    expect(gone.out.status).toBe(409)
    expect(gone.updates).toEqual([])
  })

  it('a body asking for nothing allowed is a 400', async () => {
    const h = harness({ subscriptions: [mine(SELLER_PLAN)], plans: [SELLER_PLAN] })
    await buyerPatch(h.req({ clerk: 'user_buyer', params: { id: 'sub_1' }, body: { status: 'active' } }), h.res)
    expect(h.out.status).toBe(400)
    expect(h.updates).toEqual([])
  })
})

describe('buyer subscription decisions', () => {
  it('only canceled can be asked for, and cancel_at_period_end only as a boolean', () => {
    expect(buyerSubscriptionUpdates({ status: 'active' })).toBeNull()
    expect(buyerSubscriptionUpdates({ status: 'canceled', seller_id: 'x', plan_id: 'y' })).toEqual({ status: 'canceled' })
    expect(buyerSubscriptionUpdates({ cancel_at_period_end: 'true' })).toBeNull()
    expect(buyerSubscriptionUpdates({ cancel_at_period_end: false })).toEqual({ cancel_at_period_end: false })
    expect(buyerSubscriptionUpdates(null)).toBeNull()
  })

  it('refuses a platform plan, an absent or unreadable plan, and an empty platform id', () => {
    expect(buyerPlanRefusal({ state: 'found', plan: { seller_id: 'shop_9' } }, 'platform')).toBeNull()
    expect(buyerPlanRefusal({ state: 'found', plan: { seller_id: 'platform' } }, 'platform')?.status).toBe(409)
    expect(buyerPlanRefusal({ state: 'found', plan: null }, 'platform')?.status).toBe(409)
    expect(buyerPlanRefusal({ state: 'absent' }, 'platform')?.status).toBe(409)
    expect(buyerPlanRefusal({ state: 'unavailable' }, 'platform')?.status).toBe(503)
    expect(buyerPlanRefusal({ state: 'found', plan: { seller_id: 'shop_9' } }, '')?.status).toBe(409)
  })
})
