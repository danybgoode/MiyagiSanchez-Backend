/**
 * Payment links — the seller-side I/O shell (in-person-sales S4.1 / S4.4, D13/D16).
 *
 * ONE core for both doors: the Clerk routes under `/store/sellers/me/payment-links` and
 * the internal routes the storefront calls for a shop's MCP agent. Both pass a seller id
 * they resolved themselves (Clerk token / `ms_agent_` token); nothing here takes a seller
 * from the request body, and every read and write is scoped to that seller.
 */
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IN_PERSON_MODULE } from '../modules/in-person'
import { SELLER_MODULE } from '../modules/seller'
import { sellerRowEnforcement } from './seller-status'
import { readSellerOperatingMarket } from './seller-market'
import { assertSellerOwnsVariants } from './in-person-sale-apply'
import {
  derivePaymentLinkState,
  newPaymentLinkToken,
  validatePaymentLinkInput,
  type PaymentLinkState,
} from './payment-link'

type Scope = { resolve: (key: string) => any }

export interface PaymentLinkView {
  id: string
  token: string
  kind: string
  lines: Array<{ variant_id: string; quantity: number }> | null
  concept: string | null
  amount_cents: number | null
  uses: string
  expires_at: string
  state: PaymentLinkState
  paid_order_ids: string[]
  created_at: string
}

export type LinkResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; code: string; message: string; details?: unknown }

export function toView(row: any, now: Date = new Date()): PaymentLinkView {
  return {
    id: row.id,
    token: row.token,
    kind: row.kind,
    lines: row.lines ?? null,
    concept: row.concept ?? null,
    amount_cents: row.amount_cents ?? null,
    uses: row.uses,
    expires_at: new Date(row.expires_at).toISOString(),
    state: derivePaymentLinkState(row, now),
    paid_order_ids: Array.isArray(row.paid_order_ids) ? row.paid_order_ids : [],
    created_at: new Date(row.created_at ?? now).toISOString(),
  }
}

/** The seller may take payments: present, active, Mexico (D1 — links are MX/MXN only). */
async function sellerMayCharge(scope: Scope, sellerId: string): Promise<LinkResult<never> | null> {
  const [seller] = await scope.resolve(SELLER_MODULE).listSellers({ id: sellerId })
  const gate = sellerRowEnforcement(seller)
  if (!gate.present) return { ok: false, status: 404, code: 'SELLER_NOT_FOUND', message: 'No encontramos tu tienda.' }
  if (!gate.admits) return { ok: false, status: 409, code: 'seller_not_active', message: 'Tu tienda no está activa.' }
  if (readSellerOperatingMarket(seller).market !== 'mx') {
    return { ok: false, status: 422, code: 'LINKS_MX_ONLY', message: 'Cobrar con un link está disponible para tiendas de México.' }
  }
  return null
}

export async function createPaymentLink(scope: Scope, sellerId: string, body: unknown, now: Date = new Date()): Promise<LinkResult<PaymentLinkView>> {
  const v = validatePaymentLinkInput(body, now)
  if (!v.ok) return { ok: false, status: 400, code: v.code, message: v.message }
  const refused = await sellerMayCharge(scope, sellerId)
  if (refused) return refused
  if (v.link.kind === 'products') {
    // Same proof as the counter (D3): every variant is the seller's own, sellable product.
    const owned = await assertSellerOwnsVariants(scope, sellerId, v.link.lines!.map((l) => l.variant_id))
    if (owned) return owned as LinkResult<never>
  }
  const row = await scope.resolve(IN_PERSON_MODULE).createPaymentLinks({
    seller_id: sellerId,
    token: newPaymentLinkToken(),
    kind: v.link.kind,
    lines: v.link.lines,
    concept: v.link.concept,
    amount_cents: v.link.amount_cents,
    uses: v.link.uses,
    expires_at: v.link.expires_at,
    status: 'pending',
    paid_order_ids: [],
  })
  return { ok: true, status: 201, body: toView(row, now) }
}

export async function listPaymentLinks(scope: Scope, sellerId: string, now: Date = new Date()): Promise<LinkResult<{ payment_links: PaymentLinkView[] }>> {
  const rows = await scope.resolve(IN_PERSON_MODULE).listPaymentLinks(
    { seller_id: sellerId },
    { order: { created_at: 'DESC' }, take: 200 },
  )
  return { ok: true, status: 200, body: { payment_links: (rows ?? []).map((r: any) => toView(r, now)) } }
}

/**
 * Cancel a link that can still be paid. Seller-scoped: another seller's id is 404, not
 * 403 — its existence is not this seller's business. A paid single-use link cannot be
 * cancelled (the money is in); the status write is conditional on `pending`, so a cancel
 * never overwrites a payment that landed in between.
 */
export async function cancelPaymentLink(scope: Scope, sellerId: string, linkId: string, now: Date = new Date()): Promise<LinkResult<PaymentLinkView>> {
  const svc = scope.resolve(IN_PERSON_MODULE)
  const [row] = await svc.listPaymentLinks({ id: linkId, seller_id: sellerId }, { take: 1 })
  if (!row) return { ok: false, status: 404, code: 'LINK_NOT_FOUND', message: 'No encontramos ese cobro.' }
  const state = derivePaymentLinkState(row, now)
  if (state === 'cancelled') return { ok: true, status: 200, body: toView(row, now) }
  if (state === 'paid') return { ok: false, status: 409, code: 'LINK_PAID', message: 'Este cobro ya se pagó.' }
  const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  await knex.raw(
    `update payment_link set status = 'cancelled', updated_at = now()
      where id = ? and seller_id = ? and status = 'pending'`,
    [linkId, sellerId],
  )
  const [after] = await svc.listPaymentLinks({ id: linkId, seller_id: sellerId }, { take: 1 })
  return { ok: true, status: 200, body: toView(after, now) }
}
