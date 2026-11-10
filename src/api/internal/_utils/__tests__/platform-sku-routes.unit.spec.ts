import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import * as customDomain from '../../custom-domain-subscription/route'
import * as subdomain from '../../subdomain-subscription/route'
import * as mlSync from '../../ml-sync-subscription/route'

/**
 * The PATCH (lapse) wiring of the three older platform SKU routes. Each used to call the generated update as
 * `updateSubscriptions(r.id, { status })`; the fake module below behaves like Medusa's (ONE data argument; an id
 * string as the data finds nothing and throws), so a route that goes back to that call shape writes nothing and
 * these specs go red. The decisions are specced in `src/lib/__tests__/platform-sku-status.unit.spec.ts`.
 */
const SECRET = 'sku-routes-secret'
const PLANS = [
  { id: 'subplan_cd', seller_id: 'platform', metadata: { kind: 'custom_domain_plan' } },
  { id: 'subplan_sd', seller_id: 'platform', metadata: { kind: 'subdomain_plan' } },
  { id: 'subplan_ml', seller_id: 'platform', metadata: { kind: 'ml_sync_plan' } },
]

function harness(over: { secret?: string | null; body?: unknown; status?: string } = {}) {
  const subscriptions = [
    { id: 'sub_cd', plan_id: 'subplan_cd', status: over.status ?? 'active', stripe_subscription_id: 'stripe_shared' },
    { id: 'sub_sd', plan_id: 'subplan_sd', status: over.status ?? 'active', stripe_subscription_id: 'stripe_shared' },
    { id: 'sub_ml', plan_id: 'subplan_ml', status: over.status ?? 'active', stripe_subscription_id: 'stripe_shared' },
  ]
  const match = (row: any, f: any) => Object.entries(f).every(([k, v]) => row[k] === v)
  const module = {
    listSubscriptionPlans: async (f: any) => PLANS.filter((p) => match(p, f)),
    listSubscriptions: async (f: any) => subscriptions.filter((s) => match(s, f)).map((s) => ({ ...s })),
    // Medusa's generated update: `(data, sharedContext)`. A string as the data has no `id` to select by.
    updateSubscriptions: async (data: any) => {
      if (!data || typeof data !== 'object' || typeof data.id !== 'string') throw new Error('Subscription with id "undefined" not found')
      const row = subscriptions.find((s) => s.id === data.id)
      if (!row) throw new Error(`Subscription with id "${data.id}" not found`)
      Object.assign(row, data)
      return { ...row }
    },
  }
  const statements: Array<{ sql: string; bindings: string[] }> = []
  const knex = {
    raw: async (sql: string, bindings: string[]) => {
      statements.push({ sql, bindings })
      const [status, id, planId, final] = bindings
      const row = subscriptions.find((s) => s.id === id && s.plan_id === planId && s.status !== final)
      if (row) row.status = status
      return { rows: row ? [{ id }] : [] }
    },
  }
  const req: any = {
    headers: over.secret === null ? {} : { 'x-internal-secret': over.secret ?? SECRET },
    body: over.body,
    query: {},
    scope: { resolve: (key: string) => (key === ContainerRegistrationKeys.PG_CONNECTION ? knex : module) },
  }
  const out: { status: number; body: any } = { status: 200, body: undefined }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { req, res, out, subscriptions, statements }
}

const ROUTES: Array<[string, any, string]> = [
  ['custom-domain-subscription', customDomain, 'sub_cd'],
  ['subdomain-subscription', subdomain, 'sub_sd'],
  ['ml-sync-subscription', mlSync, 'sub_ml'],
]

let prevSecret: string | undefined
beforeAll(() => { prevSecret = process.env.MEDUSA_INTERNAL_SECRET; process.env.MEDUSA_INTERNAL_SECRET = SECRET })
afterAll(() => { process.env.MEDUSA_INTERNAL_SECRET = prevSecret })

describe.each(ROUTES)('PATCH /internal/%s', (_name, route, ownRow) => {
  it('the status LANDS on this SKU\'s row only, through the conditional statement', async () => {
    const h = harness({ body: { stripe_subscription_id: 'stripe_shared', status: 'canceled' } })
    await route.PATCH(h.req, h.res)
    expect(h.out).toEqual({ status: 200, body: { updated: 1 } })
    expect(h.subscriptions.find((s) => s.id === ownRow)!.status).toBe('canceled')
    expect(h.subscriptions.filter((s) => s.id !== ownRow).map((s) => s.status)).toEqual(['active', 'active'])
    expect(h.statements).toHaveLength(1)
    expect(h.statements[0].sql).toContain("status <> ?")
    expect(h.statements[0].bindings[3]).toBe('canceled')
  })

  it('a late active never revives a cancelled row, and the answer counts it as handled', async () => {
    const h = harness({ status: 'canceled', body: { stripe_subscription_id: 'stripe_shared', status: 'active' } })
    await route.PATCH(h.req, h.res)
    expect(h.out).toEqual({ status: 200, body: { updated: 1 } })
    expect(h.subscriptions.map((s) => s.status)).toEqual(['canceled', 'canceled', 'canceled'])
  })

  it('without the secret: 401 and nothing written', async () => {
    const h = harness({ secret: null, body: { stripe_subscription_id: 'stripe_shared', status: 'canceled' } })
    await route.PATCH(h.req, h.res)
    expect(h.out.status).toBe(401)
    expect(h.statements).toEqual([])
  })

  it('an unsupported status is still a 400', async () => {
    const h = harness({ body: { stripe_subscription_id: 'stripe_shared', status: 'unpaid' } })
    await route.PATCH(h.req, h.res)
    expect(h.out.status).toBe(400)
  })
})
