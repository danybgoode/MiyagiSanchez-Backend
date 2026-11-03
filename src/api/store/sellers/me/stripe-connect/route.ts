/**
 * US Stripe Connect onboarding + status for the authenticated seller.
 *
 *   POST /store/sellers/me/stripe-connect  → ensure a v2 account, return a hosted
 *                                            onboarding link
 *   GET  /store/sellers/me/stripe-connect  → re-read the account from Stripe, persist
 *                                            the projection, return readiness
 *
 * D17: the connected account is resolved SERVER-SIDE from the Clerk-authenticated
 * seller. Neither verb reads an account id, a return url or a readiness flag from the
 * caller — a request that could name its own account could point a shop's money at
 * someone else's Stripe, and a caller-supplied return url is an open redirect on a
 * page buyers are sent to.
 *
 * The thin half: every decision lives in `lib/stripe-onboarding.ts` and
 * `lib/stripe-account-projection.ts`, which are unit-tested without network.
 *
 * Uses fetch rather than the Stripe SDK: Accounts v2 (`/v2/core/accounts`) is not in
 * the pinned SDK's surface, and these exact calls were verified live on 2026-08-11.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { projectStripeV2Account } from '../../../../../lib/stripe-account-projection'
import {
  mergeStripeSettings,
  planStripeOnboarding,
  usAccountCreateParams,
} from '../../../../../lib/stripe-onboarding'
import { resolveStripeReadiness } from '../../../../../lib/stripe-market-strategy'

const STRIPE_API = 'https://api.stripe.com'
/** Pinned: v2 core accounts shapes are version-sensitive and were verified on this. */
const STRIPE_VERSION = '2026-04-22.dahlia'
const SITE_URL = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

/**
 * Where Stripe sends the seller back after hosted onboarding.
 *
 * THIS PATH MUST EXIST. It was `/sell/pagos`, which is not a route — the seller
 * portal's payment settings live under `/shop/manage/settings/`, and `/sell/*` is the
 * listing wizard. A seller who completed Connect onboarding was handed straight to a
 * 404, at the end of the flow that decides whether they can take money at all; the
 * `refresh_url` case is worse still, because that is where Stripe sends someone whose
 * link expired and who is therefore already retrying.
 *
 * Nothing failed loudly: the account was created, the link was valid, Stripe did
 * exactly as asked. Only the destination was wrong, and no backend test can see that
 * because the route lives in the other repo. `stripe-onboarding-return-url.unit.spec.ts`
 * pins the literal against `apps/storefront`'s own route tree, which is the only
 * place the two halves can be compared.
 */
const CONNECT_RETURN_PATH = '/shop/manage/settings/pagos'

async function stripeV2(path: string, key: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_VERSION,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, json: json as Record<string, unknown> }
}

type ResolvedSeller =
  | { readonly error: { readonly status: number; readonly message: string } }
  | { readonly seller: { id: string; metadata?: unknown }; readonly sellerService: SellerModuleService }

async function resolveSeller(req: MedusaRequest): Promise<ResolvedSeller> {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) return { error: { status: 401, message: 'Unauthorized' } }
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId } as never, { take: 1 })
  if (!seller) return { error: { status: 404, message: 'No shop for this account.' } }
  return { seller, sellerService }
}

/** Persist a fresh Stripe read onto the seller, preserving sibling settings. */
async function persistProjection(
  sellerService: SellerModuleService,
  seller: { id: string; metadata?: unknown },
  account: Record<string, unknown>,
) {
  const projection = projectStripeV2Account(account)
  if (!projection) return null
  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...meta, settings: mergeStripeSettings(settings, { ...projection }) },
  } as never)
  return projection
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const resolved = await resolveSeller(req)
  if ('error' in resolved) return res.status(resolved.error.status).json({ message: resolved.error.message })
  const { seller, sellerService } = resolved

  const plan = planStripeOnboarding(seller)
  if (plan.action === 'refuse') return res.status(plan.status).json({ message: plan.message, code: plan.code })

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return res.status(500).json({ message: 'Stripe not configured' })

  // Creating the account is SERIALIZED per seller, and the decision is re-taken
  // inside the lock — validate, then claim, then apply.
  //
  // Two concurrent POSTs (a double-click, or a retry racing the original) would
  // otherwise both read "no account", both create one at Stripe, and both persist:
  // last write wins, leaving the seller onboarding account A while checkout later
  // charges through the account B that got stored. The orphan is invisible — it is a
  // real connected account nobody points at. The plan read outside the lock is not a
  // claim; only the re-read inside it is.
  const locking = req.scope.resolve(Modules.LOCKING) as {
    execute: <T>(key: string, fn: () => Promise<T>, opts?: { timeout?: number }) => Promise<T>
  }

  type EnsureResult =
    | { readonly ok: true; readonly account_id: string }
    | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> }

  // The lock RETURNS its outcome rather than assigning to outer state: a closure
  // mutating captured variables defeats TypeScript's narrowing, and more importantly
  // it makes the "what did the critical section decide" question ambiguous to read.
  const ensured: EnsureResult = plan.action === 'reuse'
    ? { ok: true, account_id: plan.account_id }
    : await locking.execute(`stripe-onboarding:${seller.id}`, async (): Promise<EnsureResult> => {
      const [fresh] = await sellerService.listSellers({ id: seller.id } as never, { take: 1 })
      const row = (fresh ?? seller) as { email?: string; name?: string; metadata?: unknown }
      const freshPlan = planStripeOnboarding(row)
      // Re-read wins: a racing request may have created the account already.
      if (freshPlan.action === 'reuse') return { ok: true, account_id: freshPlan.account_id }
      if (freshPlan.action === 'refuse') {
        return { ok: false, status: freshPlan.status, body: { message: freshPlan.message, code: freshPlan.code } }
      }

      const email = row.email ?? `shop+${seller.id}@miyagisanchez.com`
      const created = await stripeV2('/v2/core/accounts', key, {
        method: 'POST',
        body: usAccountCreateParams(email, row.name ?? 'Miyagi shop'),
      })
      // A failed create must NOT return a green body: the seller would be told to
      // onboard against an account that does not exist.
      if (!created.ok || typeof created.json.id !== 'string') {
        return { ok: false, status: 502, body: { message: 'Could not create the Stripe account.', detail: created.json.error ?? null } }
      }
      await persistProjection(sellerService, { id: seller.id, metadata: row.metadata }, created.json)
      return { ok: true, account_id: created.json.id }
    }, { timeout: 10 })

  if (!ensured.ok) return res.status(ensured.status).json(ensured.body)
  const accountId = ensured.account_id

  const link = await stripeV2('/v2/core/account_links', key, {
    method: 'POST',
    body: {
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          // Server-owned, never caller-supplied — these are redirect targets.
          refresh_url: `${SITE_URL}${CONNECT_RETURN_PATH}`,
          return_url: `${SITE_URL}${CONNECT_RETURN_PATH}`,
        },
      },
    },
  })
  if (!link.ok || typeof link.json.url !== 'string') {
    return res.status(502).json({ message: 'Could not start Stripe onboarding.', detail: link.json.error ?? null })
  }

  return res.json({ account_id: accountId, onboarding_url: link.json.url, expires_at: link.json.expires_at ?? null })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const resolved = await resolveSeller(req)
  if ('error' in resolved) return res.status(resolved.error.status).json({ message: resolved.error.message })
  const { seller, sellerService } = resolved

  const plan = planStripeOnboarding(seller)
  if (plan.action === 'refuse') return res.status(plan.status).json({ message: plan.message, code: plan.code })
  if (plan.action === 'create') {
    // Known-absent is a distinct answer from "unavailable" — say so plainly rather
    // than reporting a not-ready account that does not exist.
    return res.json({ connected: false, ready: false, reason: 'STRIPE_ACCOUNT_ABSENT', requirements: [] })
  }

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return res.status(500).json({ message: 'Stripe not configured' })

  const account = await stripeV2(
    `/v2/core/accounts/${plan.account_id}?include[0]=configuration.merchant&include[1]=identity&include[2]=requirements`,
    key,
  )
  if (!account.ok) {
    // Three states, and 404 is the third one. An account that no longer exists —
    // deleted in the dashboard, or lost to a test-mode reset — is KNOWN-ABSENT, not
    // unavailable. Reporting it as an outage sends clients into an endless retry
    // against an account that will never come back.
    if (account.status === 404) {
      return res.json({ connected: false, ready: false, reason: 'STRIPE_ACCOUNT_ABSENT', requirements: [] })
    }
    // Genuinely unavailable is NOT "not ready": a Stripe outage must not read as a
    // seller who failed onboarding, which would make support chase the wrong problem.
    return res.status(503).json({ message: 'Stripe is unavailable; readiness is unknown.', code: 'STRIPE_UNAVAILABLE' })
  }

  const projection = await persistProjection(sellerService, seller, account.json)
  if (!projection) return res.status(502).json({ message: 'Stripe returned an unreadable account.' })

  // Readiness must be computed over the MERGED settings, not the bare projection.
  // The projection has no `enabled` key, but `start-checkout` reads the persisted
  // settings where a seller-set `enabled: false` short-circuits to
  // SELLER_STRIPE_ACCOUNT_MISSING. Reading only the projection let this endpoint tell
  // a seller `ready: true` while every checkout 422'd — the worst kind of wrong,
  // because it sends them to support insisting the page said they were fine.
  const mergedSettings = mergeStripeSettings(
    ((((seller.metadata ?? {}) as Record<string, unknown>).settings ?? {}) as Record<string, unknown>),
    { ...projection },
  ).stripe as Record<string, unknown>
  const readiness = resolveStripeReadiness({
    metadata: { operating_market: 'us', settings: { stripe: mergedSettings } },
  })
  return res.json({
    connected: true,
    account_id: projection.account_id,
    ready: readiness.ready,
    reason: readiness.reason,
    requirements: projection.blocking_requirements,
    outstanding_requirements: projection.outstanding_requirements,
  })
}
