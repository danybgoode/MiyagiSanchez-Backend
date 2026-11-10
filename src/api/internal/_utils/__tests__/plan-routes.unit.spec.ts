import { POST as setupNegocio } from '../../setup-negocio-plan/route'
import { POST as setupTienda } from '../../setup-tienda-plan/route'
import * as negocioSubscription from '../../negocio-subscription/route'
import * as tiendaSubscription from '../../tienda-subscription/route'
import { SUBSCRIPTIONS_MODULE } from '../../../../modules/subscriptions'

/**
 * The HTTP shell of the two paid plans' internal routes. The decisions are specced in
 * `src/lib/__tests__/plan-kind.unit.spec.ts`; this pins the wiring a pure spec cannot see: the secret is checked
 * before anything is resolved, each route file is bound to ITS plan, and the answer's status and body go out.
 */
const SECRET = 'plan-routes-secret'
const NEG = { id: 'subplan_neg', seller_id: 'platform', stripe_price_id: 'price_neg', price_cents: 14900, metadata: { kind: 'negocio_plan' } }
const TIE = { id: 'subplan_tie', seller_id: 'platform', stripe_price_id: 'price_tie', price_cents: 2900, metadata: { kind: 'tienda_plan' } }

function harness(over: { secret?: string | null; body?: unknown; query?: unknown; plans?: any[] } = {}) {
  const plans = over.plans ?? [NEG, TIE]
  const subscriptions = [
    { id: 'sub_n', plan_id: 'subplan_neg', clerk_user_id: 'user_1', seller_id: 'shop_1', status: 'active', stripe_subscription_id: 'stripe_n' },
    { id: 'sub_t', plan_id: 'subplan_tie', clerk_user_id: 'user_1', seller_id: 'shop_1', status: 'active', stripe_subscription_id: 'stripe_t' },
  ]
  const resolved: string[] = []
  const created: any[] = []
  const match = (row: any, f: any) => Object.entries(f).every(([k, v]) => row[k] === v)
  const module = {
    listSubscriptionPlans: async (f: any) => plans.filter((p) => match(p, f)),
    createSubscriptionPlans: async (d: any) => { created.push(d); return { id: 'subplan_created', ...d } },
    updateSubscriptionPlans: async (d: any) => d,
    listSubscriptions: async (f: any) => subscriptions.filter((s) => match(s, f)),
    updateSubscriptions: async (d: any) => { Object.assign(subscriptions.find((s) => s.id === d.id)!, d) },
  }
  const req: any = {
    headers: over.secret === null ? {} : { 'x-internal-secret': over.secret ?? SECRET },
    body: over.body,
    query: over.query ?? {},
    scope: { resolve: (key: string) => { resolved.push(key); return module } },
  }
  const out: { status: number; body: any } = { status: 200, body: undefined }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { req, res, out, resolved, created, subscriptions }
}

describe('the paid plans\' internal routes', () => {
  const prev = process.env.MEDUSA_INTERNAL_SECRET
  beforeAll(() => { process.env.MEDUSA_INTERNAL_SECRET = SECRET })
  afterAll(() => { process.env.MEDUSA_INTERNAL_SECRET = prev })

  const ALL: Array<[string, (req: any, res: any) => Promise<unknown>]> = [
    ['POST setup-tienda-plan', setupTienda],
    ['GET tienda-subscription', tiendaSubscription.GET],
    ['PATCH tienda-subscription', tiendaSubscription.PATCH],
    ['POST setup-negocio-plan', setupNegocio],
    ['GET negocio-subscription', negocioSubscription.GET],
    ['PATCH negocio-subscription', negocioSubscription.PATCH],
  ]

  it.each(ALL)('%s answers 401 without the secret and resolves nothing', async (_name, route) => {
    for (const secret of [null, 'wrong']) {
      const h = harness({ secret, body: { stripe_price_id: 'price_x', stripe_subscription_id: 'stripe_t', status: 'canceled' }, query: { seller_clerk_id: 'user_1', shop_id: 'shop_1' } })
      await route(h.req, h.res)
      expect(h.out).toEqual({ status: 401, body: { message: 'Unauthorized' } })
      expect(h.resolved).toEqual([])
      expect(h.created).toEqual([])
      expect(h.subscriptions.map((s) => s.status)).toEqual(['active', 'active'])
    }
  })

  it('GET tienda-subscription answers the Tienda subscription, GET negocio-subscription the Negocio one', async () => {
    const query = { seller_clerk_id: 'user_1', shop_id: 'shop_1' }
    const t = harness({ query })
    await tiendaSubscription.GET(t.req, t.res)
    expect(t.out).toEqual({ status: 200, body: { active: true, plan_id: 'subplan_tie', stripe_price_id: 'price_tie', price_cents: 2900, subscription_id: 'stripe_t' } })
    expect(t.resolved).toEqual([SUBSCRIPTIONS_MODULE])

    const n = harness({ query })
    await negocioSubscription.GET(n.req, n.res)
    expect(n.out.body).toEqual({ active: true, plan_id: 'subplan_neg', stripe_price_id: 'price_neg', price_cents: 14900, subscription_id: 'stripe_n' })
  })

  it('PATCH tienda-subscription cannot cancel the Negocio subscription, and cancels its own', async () => {
    const wrong = harness({ body: { stripe_subscription_id: 'stripe_n', status: 'canceled' } })
    await tiendaSubscription.PATCH(wrong.req, wrong.res)
    expect(wrong.out).toEqual({ status: 200, body: { updated: 0 } })
    expect(wrong.subscriptions.map((s) => s.status)).toEqual(['active', 'active'])

    const own = harness({ body: { stripe_subscription_id: 'stripe_t', status: 'canceled' } })
    await tiendaSubscription.PATCH(own.req, own.res)
    expect(own.out.body).toEqual({ updated: 1 })
    expect(own.subscriptions.map((s) => s.status)).toEqual(['active', 'canceled'])
  })

  it('POST setup-tienda-plan creates a tienda_plan under the platform seller with a 201; a missing body is a 400', async () => {
    const h = harness({ plans: [NEG], body: { stripe_price_id: 'price_tie' } })
    await setupTienda(h.req, h.res)
    expect(h.out.status).toBe(201)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ seller_id: 'platform', price_cents: 2900, metadata: { kind: 'tienda_plan' } })

    const empty = harness({ body: undefined })
    await setupTienda(empty.req, empty.res)
    expect(empty.out.status).toBe(400)
  })

  it('POST setup-negocio-plan still seeds a negocio_plan at $149', async () => {
    const h = harness({ plans: [TIE], body: { stripe_price_id: 'price_neg' } })
    await setupNegocio(h.req, h.res)
    expect(h.out.status).toBe(201)
    expect(h.created[0]).toMatchObject({ seller_id: 'platform', label: 'Negocio', price_cents: 14900, metadata: { kind: 'negocio_plan' } })
  })
})
