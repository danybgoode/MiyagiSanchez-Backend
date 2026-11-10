/**
 * The HTTP shell of a paid plan's two internal routes (epic 08 · plan-tienda-three-free-months S2.2).
 *
 * Plan Negocio and Plan Tienda expose the same three handlers. They are built here ONCE from a `PlanKindSpec`, so
 * the auth check, the module wiring and the response shape cannot differ between the two plans; each `route.ts`
 * is one line naming its plan. Every decision lives in `src/lib/plan-kind.ts` and is unit-tested there.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET (`internalSecretOk`, fail-closed on a missing
 * secret). It runs BEFORE anything is read from the request or the database.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SUBSCRIPTIONS_MODULE } from '../../../modules/subscriptions'
import { PLATFORM_SELLER_ID } from '../setup-custom-domain-plan/route'
import { internalSecretOk } from '../../../lib/internal-auth'
import {
  readPlanSubscription,
  setPlanSubscriptionStatus,
  setupPlanOfKind,
  type PlanDeps,
  type PlanKindSpec,
  type PlanStore,
  type RouteAnswer,
} from '../../../lib/plan-kind'

type Handler = (req: MedusaRequest, res: MedusaResponse) => Promise<unknown>
type Body = (spec: PlanKindSpec, input: Record<string, unknown>, deps: PlanDeps) => Promise<RouteAnswer>

function handler(spec: PlanKindSpec, body: Body, input: (req: MedusaRequest) => unknown): Handler {
  return async (req, res) => {
    if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })
    // The module is resolved LAZILY, on the body's first use of the store. Every body validates its input before it
    // reads anything, so a malformed request answers its 400 even when the module cannot be resolved; resolving up
    // front turned that into a 500, which a caller retries instead of fixing. It also keeps the order
    // secret -> input -> database in one place for both plans.
    let subs: PlanStore | undefined
    const deps: PlanDeps = {
      get subs() {
        return (subs ??= req.scope.resolve(SUBSCRIPTIONS_MODULE))
      },
      platformSellerId: PLATFORM_SELLER_ID,
      logError: (message, error) => console.error(message, error),
    }
    const answer = await body(spec, (input(req) ?? {}) as Record<string, unknown>, deps)
    return res.status(answer.status).json(answer.body)
  }
}

/** POST /internal/setup-<plan>-plan */
export const planSetupHandler = (spec: PlanKindSpec): Handler => handler(spec, setupPlanOfKind, (req) => req.body)

/** GET /internal/<plan>-subscription */
export const planSubscriptionReadHandler = (spec: PlanKindSpec): Handler =>
  handler(spec, readPlanSubscription, (req) => req.query)

/** PATCH /internal/<plan>-subscription */
export const planSubscriptionStatusHandler = (spec: PlanKindSpec): Handler =>
  handler(spec, setPlanSubscriptionStatus, (req) => req.body)
