/**
 * POST /internal/setup-negocio-plan  { stripe_price_id, price_cents? }
 *
 * Seed (idempotently) the ONE platform-owned SubscriptionPlan behind Negocio's MONTHLY billing (epic 08 ·
 * plans-gratis-negocio S1.1, README D3). A clone of `/internal/setup-ml-sync-plan` with one cadence: Negocio's
 * yearly price is a one-time payment handled entirely by the Storefront (a dated grant), so this plan only ever
 * carries the monthly recurring price, in its `stripe_price_id` column.
 *
 * The Stripe Product + Price are created by the Storefront's `scripts/seed-negocio-plan.mjs` (it holds the Stripe
 * lib), which then POSTs the price id here. Re-running updates the existing plan instead of creating a duplicate.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import type SubscriptionsModuleService from '../../../modules/subscriptions/service'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'
import { NEGOCIO_DEFAULT_MONTHLY_CENTS, NEGOCIO_PLAN_KIND, findNegocioPlan } from '../../../lib/negocio-plan'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as { stripe_price_id?: string; price_cents?: number }
  if (!body.stripe_price_id) {
    return res.status(400).json({ message: 'stripe_price_id is required' })
  }
  const priceCents =
    typeof body.price_cents === 'number' && Number.isInteger(body.price_cents) && body.price_cents > 0
      ? body.price_cents
      : NEGOCIO_DEFAULT_MONTHLY_CENTS

  const subs = req.scope.resolve(SUBSCRIPTIONS_MODULE) as SubscriptionsModuleService
  const platformPlans: any[] = await (subs as any)
    .listSubscriptionPlans({ seller_id: PLATFORM_SELLER_ID }, { take: 100 })
    .catch(() => [])
  const existing = findNegocioPlan(platformPlans)
  const prevMeta = (existing?.metadata ?? {}) as Record<string, unknown>

  const fields = {
    label: 'Negocio',
    description: 'Plan Negocio de Miyagi Sánchez, pago mensual.',
    price_cents: priceCents,
    currency: 'mxn',
    interval: 'month' as const,
    stripe_price_id: body.stripe_price_id,
    is_active: true,
    metadata: { ...prevMeta, kind: NEGOCIO_PLAN_KIND },
  }

  let plan
  if (existing) {
    // A by-id update returns a SINGLE object, not an array — normalize either shape (same guard as ML sync).
    const updated = await (subs as any).updateSubscriptionPlans({ id: existing.id, ...fields })
    plan = Array.isArray(updated) ? updated[0] : updated
  } else {
    plan = await (subs as any).createSubscriptionPlans({
      seller_id: PLATFORM_SELLER_ID,
      product_id: null,
      mp_plan_id: null,
      ...fields,
    })
  }

  return res.status(existing ? 200 : 201).json({ plan, created: !existing })
}
