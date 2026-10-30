/**
 * Store API middlewares.
 *
 * This file exists for exactly one reason: to cryptographically verify Clerk
 * session JWTs before any route reads an identity out of one.
 *
 * `src/api/store/_utils/clerk-auth.ts` carried this comment for months —
 *
 *   "we decode the Clerk JWT ourselves — which is safe because Clerk's public key
 *    validation happens at the edge (middleware), not here"
 *
 * — and there was no middleware. No `src/api/middlewares.ts` existed in this repo at
 * all. `extractClerkUserId` base64-decoded the payload and returned `sub`, so the
 * entire `/store/sellers/me/**` and `/store/buyer/me/**` surface authenticated on a
 * string the caller supplied. Forging `eyJhbGciOiJub25lIn0.<base64 {"sub":"user_x"}>.x`
 * was enough to read and write another shop's products, orders, coupons, payouts and
 * Stripe Connect onboarding. It is the paraphrased-contract failure in its purest
 * form: a comment asserting a control that was never built.
 *
 * ## The shape of the fix
 *
 * The middleware VERIFIES and RECORDS; it does not reject. On a valid token it stores
 * the verified `sub` for the request; on an invalid one it records "unverified" and
 * calls `next()`. Routes then answer for themselves, exactly as they do today —
 * `extractClerkUserId` returns `null` and the route's own 401/404 fires.
 *
 * Rejecting here would look stricter and would be worse: `/store/carts/:id/start-checkout`
 * serves GUEST buyers, where identity is optional by design. A 401 on an unreadable
 * token would turn an anonymous checkout into a hard failure. Denying identity is the
 * security property; denying the request is not.
 *
 * ## Coverage is a population, not a list
 *
 * `matchers` below is exported, and `__tests__/clerk-middleware-coverage.unit.spec.ts`
 * walks every `route.ts` under `src/api`, finds each one that imports `clerk-auth`, and
 * asserts its URL path is covered here. A new authenticated route that forgets this
 * file turns that spec red rather than shipping unverified.
 */

import { defineMiddlewares, type MedusaNextFunction, type MedusaRequest, type MedusaResponse } from '@medusajs/framework/http'
import {
  bearerToken,
  recordVerifiedClerkIdentity,
  verifyClerkJwt,
} from './store/_utils/clerk-verify'
import { extractClerkUserId } from './store/_utils/clerk-auth'
import { decidePortalGate } from './store/_utils/seller-portal-gate'
import { SELLER_MODULE } from '../modules/seller'
import { refuseCounterCartMutation } from './store/_utils/counter-cart-lock'
import type SellerModuleService from '../modules/seller/service'

/**
 * Every Store API prefix whose routes read a caller's identity out of a Clerk JWT.
 *
 * These are Express `app.use` prefixes: each covers itself and everything beneath it.
 * Keep them as prefixes rather than per-route entries — a subtree is a population, and
 * a list of leaves is the thing that goes stale when someone adds a sibling.
 */
export const CLERK_VERIFIED_MATCHERS = [
  '/store/sellers/me',
  '/store/buyer/me',
  '/store/customers/sync',
  // Guest-capable: identity is optional here, but a supplied token still has to be
  // real before it can attach an order to a customer.
  '/store/carts/:id/start-checkout',
] as const

export async function verifyClerkIdentity(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const token = bearerToken(req)
  if (!token) {
    // Recorded, so a downstream route can tell a request this middleware SAW and
    // found anonymous from one it never ran on at all. Note it does NOT distinguish
    // "no bearer" from "bad bearer" — both collapse to `unverified`, deliberately,
    // because they grant exactly the same thing (nothing) and the distinction would
    // only tempt a caller into treating one as softer than the other.
    recordVerifiedClerkIdentity(req, null)
    return next()
  }
  try {
    recordVerifiedClerkIdentity(req, await verifyClerkJwt(token))
  } catch (e) {
    // A JWKS fetch failure must not grant identity, and must not 500 a guest
    // checkout either. Fail closed on IDENTITY, open on the request.
    console.error('[clerk-middleware] verification threw:', (e as Error).message)
    recordVerifiedClerkIdentity(req, null)
  }
  return next()
}

/**
 * A paused or deleted shop may READ its own portal but may not WRITE through it
 * (tenant-lifecycle-admin · D2c). The rule and the reasoning live in
 * `store/_utils/seller-portal-gate.ts`; this is the shell.
 *
 * Registered on the `/store/sellers/me` SUBTREE for the same reason the verification
 * matchers are prefixes: a subtree is a population, and a list of leaves is what goes
 * stale when someone adds a sibling route. `resolveSeller` has 45 call sites — this
 * covers every one of them that can mutate, including ones not written yet.
 *
 * Runs AFTER `verifyClerkIdentity` (order within the array is preserved), so the
 * identity it reads is a verified one. An unresolvable seller passes through and the
 * route answers with its own 401/404 — refusing here would turn "not a seller yet"
 * into "your account is locked" and break onboarding.
 */
export async function gateSellerPortalWrites(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  // Cheapest check first: a read never needs the seller row at all.
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes((req.method ?? '').toUpperCase())) {
    return next()
  }

  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return next()

  // No initializer, and that STRENGTHENS the fail-closed contract below rather than
  // weakening it: the `= null` seed was dead (both branches assign), and null is the
  // permissive value here — decidePortalGate reads it as "no seller row, not our
  // concern". Dropping it means a future branch that forgets to assign is a
  // TypeScript error, not a silent grant of the write this gate exists to refuse.
  let seller: { status?: unknown } | null | 'unavailable'
  try {
    const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
    const [row] = await sellerService.listSellers({ clerk_user_id: clerkUserId } as never, { take: 1 })
    seller = (row as { status?: unknown } | undefined) ?? null
  } catch (e) {
    // FAIL CLOSED. An earlier revision called next() here, reasoning that a gate
    // firing on a database blip was worse than one that occasionally missed — wrong
    // trade for a WRITE gate, because inducing a transient failure would then grant
    // exactly the mutation this gate exists to prohibit. The caller gets a retryable
    // 503 that says so, never a 423 claiming their account is paused.
    // `(e as Error).message` throws on a null/undefined rejection, which would skip
    // the fail-closed assignment below and 500 instead — a different bypass of the
    // same gate.
    console.error('[portal-gate] seller read threw:', e instanceof Error ? e.message : String(e))
    seller = 'unavailable'
  }

  const refusal = decidePortalGate({ method: req.method, seller })
  if (refusal) {
    res.status(refusal.status).json(refusal.body)
    return
  }
  return next()
}

export default defineMiddlewares({
  routes: [
    ...CLERK_VERIFIED_MATCHERS.map((matcher) => ({
      matcher,
      middlewares: [verifyClerkIdentity],
    })),
    {
      matcher: '/store/sellers/me',
      middlewares: [gateSellerPortalWrites],
    },
    // Counter carts are server-owned once rung up (in-person-sales D8).
    { matcher: '/store/carts/*', middlewares: [refuseCounterCartMutation] },
    { matcher: '/store/payment-collections*', middlewares: [refuseCounterCartMutation] },
  ],
})
