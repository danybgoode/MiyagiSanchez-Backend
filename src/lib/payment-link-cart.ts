/**
 * Payment links — the BUYER side (in-person-sales S4.2, D14/D15).
 *
 * `/pagar/<token>` reads `publicPaymentLink` and, on «Pagar», calls `buildPaymentLinkCart`:
 * a fresh cart per opener, built and priced by the server, recorded in
 * `payment_link_cart`. That record — never the cart's client-writable metadata — is how
 * start-checkout, the cart lock and the completion hook know a link cart (the same
 * lesson as counter carts, PR 218).
 *
 * «Cobro libre» (D14) is a line on the seller's hidden payment-link product at a server
 * custom price, not a variant-less custom line: the seller's inbox finds orders by
 * product ownership, so a line with no product would hide the paid order from its seller.
 */
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createCartWorkflow } from '@medusajs/medusa/core-flows'
import { IN_PERSON_MODULE } from '../modules/in-person'
import { SELLER_MODULE } from '../modules/seller'
import { createSellerProduct } from '../api/store/_utils/seller-product-create'
import { resolveSellerProductMetadataRecords } from '../api/store/_utils/seller-catalog-query'
import { sellerRowEnforcement } from './seller-status'
import { resolveOperatingChannelId, resolveRegionIdForMarket } from './market-medusa'
import { inPersonPayloadHash } from './in-person-sale'
import { derivePaymentLinkState, isTokenShaped } from './payment-link'

type Scope = { resolve: (key: string) => any }

/** The email on a link cart until the buyer gives theirs at the provider's checkout. */
export const LINK_PLACEHOLDER_EMAIL = 'cobro@sin-correo.miyagisanchez.com'

/** The `kind` the link-cart payload hash is computed with (shared with counterCartMatchesClaim). */
export const LINK_HASH_KIND = 'link'

export const PAYMENT_LINK_PRODUCT_METADATA = {
  is_payment_link_product: true,
  hidden_from_catalog: true,
} as const

export type Refusal = { ok: false; status: number; code: string; message: string }

async function linkByToken(scope: Scope, token: string): Promise<any | null> {
  if (!isTokenShaped(token)) return null
  const [row] = await scope.resolve(IN_PERSON_MODULE).listPaymentLinks({ token }, { take: 1 })
  return row ?? null
}

/** Why this link cannot be paid now, in the words the pay page shows (D15). */
function closedRefusal(state: string): Refusal | null {
  if (state === 'paid') return { ok: false, status: 409, code: 'LINK_PAID', message: 'Este cobro ya se pagó.' }
  if (state === 'expired') return { ok: false, status: 410, code: 'LINK_EXPIRED', message: 'Este link ya venció. Pídele uno nuevo a la tienda.' }
  if (state === 'cancelled') return { ok: false, status: 410, code: 'LINK_CANCELLED', message: 'La tienda canceló este cobro.' }
  return null
}

/**
 * The public view of a link: what the buyer needs to decide to pay, and nothing else
 * (no seller id, no other links, no paid order ids).
 */
export async function publicPaymentLink(scope: Scope, token: string, now: Date = new Date()) {
  const link = await linkByToken(scope, token)
  if (!link) return { ok: false as const, status: 404, code: 'LINK_NOT_FOUND', message: 'Este link no existe.' }
  const [seller] = await scope.resolve(SELLER_MODULE).listSellers({ id: link.seller_id })
  const state = derivePaymentLinkState(link, now)
  let lines: Array<{ title: string; quantity: number; unit_price_cents: number }> = []
  if (link.kind === 'products') {
    const query = scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: 'variant',
      fields: ['id', 'title', 'product.title', 'prices.amount', 'prices.currency_code'],
      filters: { id: (link.lines ?? []).map((l: any) => l.variant_id) },
    })
    const byId = new Map<string, any>((data ?? []).map((v: any) => [v.id, v]))
    lines = (link.lines ?? []).map((l: any) => {
      const v = byId.get(l.variant_id)
      const price = (v?.prices ?? []).find((p: any) => String(p.currency_code).toLowerCase() === 'mxn')
      return { title: v?.product?.title ?? v?.title ?? 'Producto', quantity: l.quantity, unit_price_cents: Math.round(Number(price?.amount ?? 0)) }
    })
  }
  const total = link.kind === 'amount'
    ? Number(link.amount_cents ?? 0)
    : lines.reduce((sum, l) => sum + l.unit_price_cents * l.quantity, 0)
  return {
    ok: true as const,
    body: {
      state,
      kind: link.kind,
      concept: link.concept ?? null,
      lines,
      total_cents: total,
      currency: 'MXN',
      expires_at: new Date(link.expires_at).toISOString(),
      shop: seller ? { name: seller.name, slug: seller.slug, logo_url: seller.logo_url ?? null } : null,
    },
  }
}

/**
 * The seller's ONE hidden «Cobro libre» product (D14), found or created under a lock so
 * two concurrent first payments cannot create two. A `digital` listing: never stocked,
 * never "coordinated delivery" (so a card can pay it), hidden from every catalog.
 */
async function ensureLinkProductVariant(scope: Scope, seller: any): Promise<string> {
  const find = async () => {
    const remoteQuery = scope.resolve('remoteQuery')
    const products = await resolveSellerProductMetadataRecords(remoteQuery, seller.id)
    const found = products.find((p: any) => (p?.metadata as any)?.is_payment_link_product === true)
    if (!found) return null
    const { data } = await scope.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: 'product', fields: ['id', 'variants.id'], filters: { id: found.id },
    })
    return ((data?.[0] as any)?.variants?.[0]?.id as string | undefined) ?? null
  }
  const existing = await find()
  if (existing) return existing
  return scope.resolve(Modules.LOCKING).execute(`payment-link-product:${seller.id}`, async () => {
    const again = await find()
    if (again) return again
    const created = await createSellerProduct(scope as any, seller.id, {
      title: `Cobro libre — ${seller.name}`,
      description: 'Cobros con link por monto libre.',
      price_cents: 1_000,
      currency: 'MXN',
      listing_type: 'digital',
      status: 'published',
      metadata: { ...PAYMENT_LINK_PRODUCT_METADATA, payment_link_seller_id: seller.id },
    })
    if (!created.ok) throw new Error(`could not create the payment-link product: ${created.message}`)
    const { data } = await scope.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: 'product', fields: ['id', 'variants.id'], filters: { id: created.product_id },
    })
    const variantId = (data?.[0] as any)?.variants?.[0]?.id
    if (!variantId) throw new Error('payment-link product has no variant')
    return variantId as string
  }, { timeout: 30 })
}

/**
 * A fresh, server-priced cart for one opener of a link (D15). Multi-use and single-use
 * alike get a new cart per opener: a single-use link is closed by its first PAID order,
 * not by someone merely opening it.
 */
export async function buildPaymentLinkCart(scope: Scope, token: string, now: Date = new Date()): Promise<
  { ok: true; body: { cart_id: string; total_cents: number; kind: string; seller_slug: string } } | Refusal
> {
  const link = await linkByToken(scope, token)
  if (!link) return { ok: false, status: 404, code: 'LINK_NOT_FOUND', message: 'Este link no existe.' }
  const closed = closedRefusal(derivePaymentLinkState(link, now))
  if (closed) return closed

  const [seller] = await scope.resolve(SELLER_MODULE).listSellers({ id: link.seller_id })
  const gate = sellerRowEnforcement(seller)
  if (!gate.present || !gate.admits) return { ok: false, status: 409, code: 'seller_not_active', message: 'Esta tienda no está disponible en este momento.' }
  const regionId = resolveRegionIdForMarket('mx', process.env)
  const channelId = resolveOperatingChannelId('mx', process.env)
  if (!regionId || !channelId) return { ok: false, status: 503, code: 'MX_COMMERCE_UNCONFIGURED', message: 'Los cobros con link no están configurados.' }

  const items = link.kind === 'amount'
    ? [{
        variant_id: await ensureLinkProductVariant(scope, seller),
        quantity: 1,
        unit_price: Number(link.amount_cents),
        title: String(link.concept),
      }]
    : (link.lines ?? []).map((l: any) => ({ variant_id: l.variant_id, quantity: l.quantity }))

  const { result: cart } = await createCartWorkflow(scope as any).run({
    input: {
      region_id: regionId,
      sales_channel_id: channelId,
      currency_code: 'mxn',
      email: LINK_PLACEHOLDER_EMAIL,
      items,
      metadata: { source: 'payment_link', payment_link_id: link.id, seller_id: link.seller_id },
    },
  })
  const cartId = (cart as any).id as string
  const { data } = await scope.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: 'cart', fields: ['id', 'total', 'items.variant_id', 'items.quantity'], filters: { id: cartId },
  })
  const priced = data?.[0] as any
  const merged = new Map<string, number>()
  for (const it of priced?.items ?? []) merged.set(it.variant_id, (merged.get(it.variant_id) ?? 0) + Number(it.quantity))
  const lines = [...merged.entries()].sort(([a], [z]) => (a < z ? -1 : 1)).map(([variant_id, quantity]) => ({ variant_id, quantity }))
  const total = Math.round(Number(priced?.total ?? 0))
  await scope.resolve(IN_PERSON_MODULE).createPaymentLinkCarts({
    payment_link_id: link.id,
    cart_id: cartId,
    seller_id: link.seller_id,
    total_cents: total,
    payload_hash: inPersonPayloadHash({ kind: LINK_HASH_KIND as any, lines }),
  })
  return { ok: true, body: { cart_id: cartId, total_cents: total, kind: link.kind, seller_slug: seller.slug } }
}

/** The link record behind a cart, if this cart was built from a payment link. */
export async function linkCartFor(scope: Scope, cartId: string): Promise<any | null> {
  const [row] = await scope.resolve(IN_PERSON_MODULE).listPaymentLinkCarts({ cart_id: cartId }, { take: 1 })
  return row ?? null
}

export { closedRefusal }

/**
 * Take (or keep) a SINGLE-use link's one payable-checkout hold for `cartId` (codex, PR
 * 221: two buyers paying one single-use link at once would both be charged). Atomic: the
 * write succeeds only while the link is pending and the hold is free, expired, or already
 * this cart's. The hold lasts `ttlMs` — the checkout's own lifetime — so an abandoned
 * attempt frees the link by itself.
 */
export async function holdSingleUseLink(scope: Scope, linkId: string, cartId: string, ttlMs: number): Promise<boolean> {
  const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const r = await knex.raw(
    `update payment_link
        set metadata = coalesce(metadata, '{}'::jsonb)
              || jsonb_build_object('hold_cart_id', ?::text, 'hold_until', (now() + (? || ' milliseconds')::interval)::text),
            updated_at = now()
      where id = ? and status = 'pending'
        and (metadata->>'hold_until' is null
             or (metadata->>'hold_until')::timestamptz < now()
             or metadata->>'hold_cart_id' = ?)
      returning id`,
    [cartId, String(ttlMs), linkId, cartId],
  )
  return (r?.rows?.length ?? 0) > 0
}

/**
 * Record an order on the payment link it was paid through, if any (D13: "the order's
 * payment drives `paid`").
 *
 * Called on `order.placed` and again when the seller confirms a «Pago directo» order.
 * The order's id is always appended (idempotently) so the seller sees it. A SINGLE-use
 * link is closed only once the money is real: a processor-confirmed card payment, or a
 * manual payment the seller confirmed. A manual order that is merely pending must not
 * close the link — anyone holding the token could otherwise close it for free (verifier,
 * PR 221). The status write is conditional on `pending`, so a seller's cancel is never
 * overwritten.
 */
export async function recordLinkOrder(scope: Scope, orderId: string): Promise<void> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: oc } = await query.graph({ entity: 'order_cart', fields: ['cart_id'], filters: { order_id: orderId } })
  const cartId = (oc?.[0] as any)?.cart_id
  if (!cartId) return
  const [lc] = await scope.resolve(IN_PERSON_MODULE).listPaymentLinkCarts({ cart_id: cartId }, { take: 1 })
  if (!lc) return
  const { data } = await query.graph({
    entity: 'order',
    fields: ['id', 'metadata', 'payment_collections.payments.provider_id', 'payment_collections.payments.captured_at'],
    filters: { id: orderId },
  })
  const order = data?.[0] as any
  const payment = (order?.payment_collections ?? []).flatMap((pc: any) => pc?.payments ?? [])[0]
  const provider = String(payment?.provider_id ?? '')
  const moneyIsReal = provider === 'pp_stripe-connect_stripe-connect' || provider === 'pp_mercadopago_mercadopago'
    || Boolean(payment?.captured_at) || order?.metadata?.payment_received === true
  const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  await knex.raw(
    `update payment_link
        set paid_order_ids = case
              when coalesce(paid_order_ids, '[]'::jsonb) @> to_jsonb(?::text) then paid_order_ids
              else coalesce(paid_order_ids, '[]'::jsonb) || to_jsonb(?::text)
            end,
            status = case when ? and uses = 'single' and status = 'pending' then 'paid' else status end,
            updated_at = now()
      where id = ?`,
    [orderId, orderId, moneyIsReal, lc.payment_link_id],
  )
}

/** Take a link cart's one-and-only checkout. True only for the first caller. */
export async function claimLinkCartCheckout(scope: Scope, cartId: string): Promise<boolean> {
  const knex = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const r = await knex.raw(
    `update payment_link_cart
        set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('checkout_started_at', now()::text),
            updated_at = now()
      where cart_id = ? and (metadata->>'checkout_started_at') is null
      returning id`,
    [cartId],
  )
  return (r?.rows?.length ?? 0) > 0
}

/** Does `cartId` hold its single-use link right now? */
export function cartHoldsLink(link: { metadata?: any }, cartId: string, now: Date): boolean {
  const m = link?.metadata ?? {}
  return m.hold_cart_id === cartId && typeof m.hold_until === 'string' && new Date(m.hold_until).getTime() > now.getTime()
}
