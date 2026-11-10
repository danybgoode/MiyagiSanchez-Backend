/**
 * A paid platform plan, by KIND (epic 08 · plan-tienda-three-free-months S2.2, README D3/D6).
 *
 * Miyagi Sánchez sells two monthly plans, Plan Negocio and Plan Tienda. Each is one platform-owned SubscriptionPlan
 * on the shared `subscription_plan` table, told apart by `metadata.kind` (no migration: a metadata discriminator).
 * This module is the ONE implementation of "which plan is it, is this shop's subscription live, seed it, read it,
 * lapse it" — `negocio-plan.ts` and `tienda-plan.ts` only name a kind and call in. It was lifted out of
 * `negocio-plan.ts` unchanged in behaviour, so that a second plan could not drift from the first by copy.
 *
 * Two halves:
 *   - pure decisions (`plansOfKind`, `findPlanOfKind`, `liveSubscription`);
 *   - the three route bodies (`setupPlanOfKind`, `readPlanSubscription`, `setPlanSubscriptionStatus`) over an
 *     INJECTED store, answering `{ status, body }`. The routes are shells that authenticate, resolve the module
 *     and send the answer, so every guard below is unit-tested with no Medusa container.
 *
 * The rule that keeps the two plans apart: every read and write is scoped to the plan row of ITS kind. A Tienda
 * subscription must never read as Negocio (a $29 payment opening the $149 plan), nor the reverse.
 */

/**
 * `past_due` counts as live: Stripe is retrying the card, and a transient failure must not drop a merchant off
 * their plan mid-month. Only a definitive `canceled` (or anything unknown) lapses it — the same window the other
 * platform plans use.
 */
export const PLAN_LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due'])

/** Statuses the lapse path (the Stripe webhook) may set. */
export const PLAN_SETTABLE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'canceled'])

export type PlanLike = {
  id?: string
  created_at?: string | Date | null
  metadata?: Record<string, unknown> | null
} | null | undefined

export type SubscriptionLike = {
  status?: string | null
  stripe_subscription_id?: string | null
  seller_id?: string | null
  plan_id?: string | null
} | null | undefined

function createdMs(p: PlanLike): number {
  const t = p?.created_at instanceof Date ? p.created_at.getTime() : Date.parse(String(p?.created_at ?? ''))
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

/** Every plan of `kind` among the platform's plans, OLDEST first (ties by id). Filtered in JS: metadata jsonb filters
 *  are not reliably supported by the list query. More than one is a seeding fault the setup route refuses.
 *  There is no wildcard: an empty kind matches nothing, so a missing constant can never select "any plan". */
export function plansOfKind<T extends PlanLike>(plans: readonly T[], kind: string): T[] {
  if (!kind) return []
  return plans
    .filter((p) => (p?.metadata as Record<string, unknown> | null | undefined)?.kind === kind)
    .sort((a, b) => createdMs(a) - createdMs(b) || String(a?.id ?? '').localeCompare(String(b?.id ?? '')))
}

/**
 * THE plan of a kind: the oldest one. Deterministic on purpose — if a duplicate ever exists, the webhook that records a
 * subscription and the read that checks it must resolve the SAME plan, or a paying seller reads as not paying.
 */
export function findPlanOfKind<T extends PlanLike>(plans: readonly T[], kind: string): T | null {
  return plansOfKind(plans, kind)[0] ?? null
}

/**
 * The first live subscription row, or null. An unknown status is NOT live: "I cannot tell" never grants.
 * A plan is per SHOP: only rows recorded for `shopId` count, so one monthly payment never opens the plan on every
 * shop the same person owns. There is no wildcard — an empty shop id matches nothing.
 *
 * `planId`, when given, is checked on the row ITSELF. The list query already filters by plan, but that filter is
 * the only thing between a Tienda row and a Negocio answer; if a query ever returned another plan's rows (a
 * dropped or mistyped filter key), this refuses them instead of granting the wrong plan. A row with no `plan_id`
 * does not match a named plan: unknown is not a match.
 */
export function liveSubscription<T extends SubscriptionLike>(rows: readonly T[], shopId: string, planId?: string): T | null {
  if (!shopId) return null
  return rows.find((r) =>
    typeof r?.status === 'string' &&
    PLAN_LIVE_STATUSES.has(r.status) &&
    r.seller_id === shopId &&
    (planId === undefined || r.plan_id === planId),
  ) ?? null
}

// ── The route bodies ──────────────────────────────────────────────────────────────────────────────────────────

/** What tells one paid plan from the other. Everything a route body needs that is not the same for both. */
export type PlanKindSpec = {
  /** `metadata.kind` on the plan row. */
  kind: string
  /** The plan's `label` column and the name used in messages: «Negocio», «Tienda». */
  label: string
  /** The plan's `description` column. */
  description: string
  /** Seed default when the caller sends no valid `price_cents` (the Storefront's pricing module is the source). */
  defaultMonthlyCents: number
  /** Log prefix, e.g. `negocio-subscription`. */
  logTag: string
}

/** The slice of the subscriptions module the route bodies use. Injected so the specs need no container. */
export type PlanStore = {
  listSubscriptionPlans(filters: Record<string, unknown>, config?: Record<string, unknown>): Promise<any[]>
  createSubscriptionPlans(data: Record<string, unknown>): Promise<any>
  updateSubscriptionPlans(data: Record<string, unknown>): Promise<any>
  listSubscriptions(filters: Record<string, unknown>, config?: Record<string, unknown>): Promise<any[]>
  /** ONE argument carrying the id. See the note in `setPlanSubscriptionStatus` before changing this shape. */
  updateSubscriptions(data: { id: string } & Record<string, unknown>): Promise<any>
}

export type PlanDeps = {
  subs: PlanStore
  /** The `seller_id` every platform-owned plan is filed under. */
  platformSellerId: string
  logError?: (message: string, error: unknown) => void
}

export type RouteAnswer = { status: number; body: Record<string, unknown> }

function listPlatformPlans(deps: PlanDeps): Promise<any[]> {
  return deps.subs.listSubscriptionPlans({ seller_id: deps.platformSellerId }, { take: 100 })
}

/**
 * POST /internal/setup-<kind>-plan  { stripe_price_id, price_cents? }
 *
 * Seed (idempotently) the ONE platform-owned plan of this kind. Creates it when absent (201), updates it in place
 * when present (200), and never touches a plan of another kind.
 */
export async function setupPlanOfKind(
  spec: PlanKindSpec,
  input: { stripe_price_id?: unknown; price_cents?: unknown },
  deps: PlanDeps,
): Promise<RouteAnswer> {
  if (typeof input.stripe_price_id !== 'string' || !input.stripe_price_id) {
    return { status: 400, body: { message: 'stripe_price_id is required' } }
  }
  const stripePriceId = input.stripe_price_id
  const priceCents =
    typeof input.price_cents === 'number' && Number.isInteger(input.price_cents) && input.price_cents > 0
      ? input.price_cents
      : spec.defaultMonthlyCents

  // No `.catch(() => [])`: a FAILED read must never look like "no plan yet", or a re-run seeds a duplicate and the
  // webhook and the entitlement read can resolve different plans. A failure throws (a 500); the operator re-runs.
  const platformPlans = await listPlatformPlans(deps)
  const found = plansOfKind(platformPlans, spec.kind)
  if (found.length > 1) {
    return {
      status: 409,
      body: {
        message: `${found.length} ${spec.label} plans exist — resolve by hand before re-seeding (readers use the oldest).`,
        plan_ids: found.map((p: any) => p.id),
      },
    }
  }
  const existing = found[0] ?? null

  // One Stripe price, one plan. The two paid plans are seeded by near-identical commands; pasting Negocio's price id
  // into the Tienda seed would make every Tienda checkout charge Negocio's price (or the reverse) while both plans
  // looked correctly seeded. A price already carried by ANOTHER platform plan is refused, never silently shared.
  const clash = platformPlans.find((p: any) => p?.stripe_price_id === stripePriceId && p?.id !== existing?.id)
  if (clash) {
    return {
      status: 409,
      body: {
        message: `stripe_price_id already belongs to another platform plan (${clash.id}) — a price is never shared between plans.`,
        plan_ids: [clash.id],
      },
    }
  }

  const prevMeta = (existing?.metadata ?? {}) as Record<string, unknown>
  const fields = {
    label: spec.label,
    description: spec.description,
    price_cents: priceCents,
    currency: 'mxn',
    interval: 'month' as const,
    stripe_price_id: stripePriceId,
    is_active: true,
    metadata: { ...prevMeta, kind: spec.kind },
  }

  let plan
  if (existing) {
    // A by-id update returns a SINGLE object, not an array — normalize either shape (same guard as ML sync).
    const updated = await deps.subs.updateSubscriptionPlans({ id: existing.id, ...fields })
    plan = Array.isArray(updated) ? updated[0] : updated
  } else {
    plan = await deps.subs.createSubscriptionPlans({
      seller_id: deps.platformSellerId,
      product_id: null,
      mp_plan_id: null,
      ...fields,
    })
  }
  return { status: existing ? 200 : 201, body: { plan, created: !existing } }
}

/**
 * GET /internal/<kind>-subscription?seller_clerk_id=...&shop_id=...
 *
 * "Does this shop have a LIVE monthly subscription to THIS plan?" Every failure answers `active: false` with a
 * `reason`, so a backend hiccup never grants a paid plan.
 */
export async function readPlanSubscription(
  spec: PlanKindSpec,
  input: { seller_clerk_id?: unknown; shop_id?: unknown },
  deps: PlanDeps,
): Promise<RouteAnswer> {
  const sellerClerkId = typeof input.seller_clerk_id === 'string' ? input.seller_clerk_id : ''
  if (!sellerClerkId) return { status: 400, body: { message: 'seller_clerk_id query param is required' } }

  // REQUIRED: a plan is per shop. A missing shop_id must never mean "any of this person's shops" (Codex, #224).
  const shopId = typeof input.shop_id === 'string' ? input.shop_id : ''
  if (!shopId) return { status: 400, body: { message: 'shop_id query param is required' } }

  let plan: any
  try {
    plan = findPlanOfKind(await listPlatformPlans(deps), spec.kind)
  } catch (e) {
    // "Could not look" is reported as such — never a confident `no_plan`.
    deps.logError?.(`[${spec.logTag}] plan lookup failed:`, e)
    return { status: 200, body: { active: false, reason: 'error', plan_id: null } }
  }
  if (!plan) return { status: 200, body: { active: false, reason: 'no_plan', plan_id: null } }

  const planFields = {
    plan_id: plan.id,
    stripe_price_id: plan.stripe_price_id ?? null,
    price_cents: plan.price_cents ?? null,
  }
  try {
    // Scoped to THIS kind's plan row twice: in the query, and again on each row (see `liveSubscription`).
    const rows = await deps.subs.listSubscriptions({ plan_id: plan.id, clerk_user_id: sellerClerkId }, { take: 50 })
    const live = liveSubscription(rows, shopId, plan.id)
    return { status: 200, body: { active: !!live, ...planFields, subscription_id: live?.stripe_subscription_id ?? null } }
  } catch (e) {
    // The resolved plan still goes back: the activation webhook needs `plan_id` to record a PAID subscription even
    // when this seller's rows could not be listed.
    deps.logError?.(`[${spec.logTag}] subscription lookup failed:`, e)
    return { status: 200, body: { active: false, reason: 'error', ...planFields, subscription_id: null } }
  }
}

/**
 * PATCH /internal/<kind>-subscription  { stripe_subscription_id, status }
 *
 * The lapse path. Answers `{ updated }` = the rows of THIS plan found for that Stripe id AND written successfully.
 * Re-setting the status a row already has (a replayed webhook) counts, on purpose, and so does a row that is already
 * `canceled` and is left that way (see the loop): 0 means the honest failure — no such row on this plan, or every
 * write failed.
 */
export async function setPlanSubscriptionStatus(
  spec: PlanKindSpec,
  input: { stripe_subscription_id?: unknown; status?: unknown },
  deps: PlanDeps,
): Promise<RouteAnswer> {
  const stripeSubscriptionId = typeof input.stripe_subscription_id === 'string' ? input.stripe_subscription_id : ''
  const status = typeof input.status === 'string' ? input.status : ''
  if (!stripeSubscriptionId || !status) {
    return { status: 400, body: { message: 'stripe_subscription_id and status are required' } }
  }
  if (!PLAN_SETTABLE_STATUSES.has(status)) {
    return { status: 400, body: { message: `unsupported status: ${status}` } }
  }

  // No `.catch`: a failed read throws (a 500 the caller treats as a failure), never `updated: 0` ("no such row").
  const plan: any = findPlanOfKind(await listPlatformPlans(deps), spec.kind)
  if (!plan) return { status: 409, body: { message: `${spec.label} plan is not seeded` } }
  // Scoped to this kind's plan: the Tienda route can only ever lapse a Tienda subscription, the Negocio route a
  // Negocio one. The row's own `plan_id` is re-checked for the reason given on `liveSubscription`.
  const rows = (await deps.subs.listSubscriptions({ stripe_subscription_id: stripeSubscriptionId, plan_id: plan.id }, { take: 50 }))
    .filter((r: any) => r?.plan_id === plan.id)

  let updated = 0
  for (const r of rows) {
    // `canceled` is FINAL. Stripe ends a subscription once, but it does not promise event order: a late
    // `customer.subscription.updated` (active / past_due / trialing) can arrive AFTER the deletion. Writing it would
    // set a cancelled row live again — a paid plan nobody is paying for, with no later event to end it. So a
    // cancelled row is never written. It is still COUNTED: the caller reads 0 as "no such subscription" and raises an
    // alarm, and this row was found and is in the only state it can be in. (`canceled` over `canceled`, a replayed
    // deletion, lands here too.) A new subscription for the same shop is a new Stripe id and a new row.
    if (r.status === 'canceled') {
      updated++
      continue
    }
    try {
      // `{ id, ...fields }` in ONE argument, the shape Medusa's generated `update<Model>s` takes. The lapse routes
      // of the older platform plans call `updateSubscriptions(id, { status })`; the generated method reads its
      // second argument as the shared context and its first as the data, so that call never reaches the row.
      // On a paid plan that is a cancelled subscription that stays live, so the shape is pinned in the spec.
      await deps.subs.updateSubscriptions({ id: r.id, status })
      updated++
    } catch (e) {
      deps.logError?.(`[${spec.logTag}] status update failed for ${r.id}:`, e)
    }
  }
  return { status: 200, body: { updated } }
}
