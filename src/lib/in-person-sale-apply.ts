/**
 * In-person sale — the I/O shell (in-person-sales epic, D1–D6).
 *
 * `recordInPersonSale` is the ONE core behind `POST /store/sellers/me/in-person-orders`
 * and the money-path integration spec. Every decision it makes is delegated to the
 * pure `in-person-sale.ts`; this file only moves data in the order the lock fixes:
 *
 *   validate (pure + the ownership read) → claim (unique insert) → apply
 *
 * and inside apply: build the cart → RECORD cart_id on the claim → complete the cart
 * → capture the cash → mark the claim completed. Recording the cart before completing
 * it is what makes a takeover safe: the taker re-completes the SAME cart and Medusa's
 * `completeCartWorkflow` returns that cart's existing order (it reads `order_cart`
 * first — confirmed in the installed core-flows 2.21.2), never a second order.
 */
import { randomUUID } from 'node:crypto'
import { ContainerRegistrationKeys, Modules, generateEntityId } from '@medusajs/framework/utils'
import {
  completeCartWorkflow,
  createCartWorkflow,
  createPaymentCollectionForCartWorkflow,
} from '@medusajs/medusa/core-flows'
import { IN_PERSON_MODULE } from '../modules/in-person'
import { SELLER_MODULE } from '../modules/seller'
import { resolveSellerProductIds } from '../api/store/_utils/seller-catalog-query'
import { isHiddenCatalogProduct, isSupportProductMetadata } from '../api/store/_utils/support'
import { captureOrderPayment } from './order-payment-capture'
import { OversoldOwnershipLost, recordOversoldOfflineSale } from './in-person-sale-oversold'
import { getInPersonSaleStatus, type InPersonSaleState } from './in-person-sale-status'
import { resolveShippingOptionIds } from '../api/store/_utils/fulfillment'
import { readSellerOperatingMarket } from './seller-market'
import { sellerRowEnforcement } from './seller-status'
import { resolveOperatingChannelId, resolveRegionIdForMarket } from './market-medusa'
import {
  CLAIM_STALE_MS,
  cashChange,
  decideExistingClaim,
  inPersonPayloadHash,
  type InPersonSaleInput,
} from './in-person-sale'

type Scope = { resolve: (key: string) => any }

/** D6: a walk-in buyer has no account and usually no email. Nothing is ever sent here. */
export const PLACEHOLDER_BUYER_EMAIL = 'mostrador@sin-correo.miyagisanchez.com'

/**
 * D5 (amended at build): the CASH provider, not the unified `pp_manual_manual`.
 * `completeCartWorkflow` refuses a provider that is not enabled in the cart's region,
 * and the live MX region enables `pp_cash_cash` but NOT `pp_manual_manual`
 * (GET /store/payment-providers?region_id=<mx>, 2026-10-30; `setup-mexico` never
 * added it). Same `ManualMxPaymentProvider` class, so capture behaves identically.
 */
const MANUAL_PROVIDER_ID = 'pp_cash_cash'

export type RecordResult =
  | {
      ok: true
      status: 200 | 201
      body: {
        /** Cash: the recorded order. Card/transfer: null until the payment completes the cart. */
        order_id: string | null
        total_cents: number
        change_cents: number
        replayed: boolean
        /** Card/transfer (S2): the cart the checkout runs on, and the claim's state. */
        cart_id?: string
        status?: InPersonSaleState
        checkout_url?: string | null
      }
    }
  | { ok: false; status: number; code: string; message: string; details?: unknown }

function refuse(status: number, code: string, message: string, details?: unknown): RecordResult {
  return { ok: false, status, code, message, ...(details ? { details } : {}) }
}

/**
 * D3 — every variant must belong to a product linked to THIS seller, and that
 * product must be a sellable catalog product (not the support or a hidden product).
 * The proof is keyed to the variant, because the variant is what the cart buys
 * (LEARNINGS: an admission proof must match what is consumed).
 */
async function assertSellerOwnsVariants(
  scope: Scope,
  sellerId: string,
  variantIds: string[],
): Promise<RecordResult | null> {
  const owned = await resolveSellerProductIds(scope, sellerId)
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'variant',
    fields: ['id', 'product_id', 'product.metadata'],
    filters: { id: variantIds },
  })
  const byId = new Map<string, any>((data ?? []).map((v: any) => [v.id, v]))
  const refused = variantIds.filter((id) => {
    const v = byId.get(id)
    // Status is deliberately NOT checked: a paused (draft) listing is a product the
    // merchant still physically holds and may hand over at the counter; "paused"
    // governs online buyability, not ownership. Support/hidden products are not
    // goods at all, so both predicates refuse them.
    return !v || !owned.has(v.product_id)
      || isHiddenCatalogProduct(v.product?.metadata) || isSupportProductMetadata(v.product?.metadata)
  })
  if (refused.length) {
    return refuse(422, 'VARIANT_NOT_OWNED', 'Uno o más productos no son de tu tienda.', { variant_ids: refused })
  }
  return null
}

async function cartPaymentCollectionId(scope: Scope, cartId: string): Promise<string | null> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'cart',
    fields: ['id', 'payment_collection.id', 'shipping_methods.id'],
    filters: { id: cartId },
  })
  return (data?.[0] as any)?.payment_collection?.id ?? null
}

async function cartHasShippingMethod(scope: Scope, cartId: string): Promise<boolean> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'cart',
    fields: ['id', 'shipping_methods.id'],
    filters: { id: cartId },
  })
  return ((data?.[0] as any)?.shipping_methods?.length ?? 0) > 0
}

/**
 * Make the cart completable: a $0 hand-over shipping method on the seeded pickup
 * option (completeCart requires one when items require shipping — same reason
 * start-checkout adds one) and a payment collection with one manual session.
 * Each step checks before it writes, so a takeover that resumes a half-built cart
 * does not add a second method or a second session.
 */
async function prepareCartForCash(scope: Scope, cartId: string): Promise<number> {
  if (!(await cartHasShippingMethod(scope, cartId))) {
    const optionIds = await resolveShippingOptionIds(scope)
    const optionId = optionIds.pickup ?? optionIds.coord
    if (!optionId) throw new Error('no seeded pickup/coord shipping option — run /internal/setup-fulfillment')
    // Direct module call with an explicit $0 amount, exactly as start-checkout's live
    // path does: `addShippingMethodToCartWorkflow` asks the provider to PRICE the
    // option, and the manual fulfillment provider refuses ("Manual fulfillment does
    // not support price calculation" — the money-path CI run of PR #214).
    await scope.resolve(Modules.CART).addShippingMethods(cartId, [{
      name: 'Entregado en persona',
      amount: 0,
      shipping_option_id: optionId,
      data: {},
    }])
  }

  let collectionId = await cartPaymentCollectionId(scope, cartId)
  if (!collectionId) {
    const { result } = await createPaymentCollectionForCartWorkflow(scope as any).run({
      input: { cart_id: cartId },
    })
    collectionId = (result as any).id as string
  }

  const paymentService = scope.resolve(Modules.PAYMENT)
  const [collection] = await paymentService.listPaymentCollections(
    { id: collectionId },
    { relations: ['payment_sessions'] },
  )
  if (!collection?.payment_sessions?.length) {
    // Direct module call, exactly as start-checkout's live manual branch does.
    // `completeCartWorkflow` still requires the provider to be enabled in the cart's
    // REGION (validate-cart-payments) — see MANUAL_PROVIDER_ID for why that is cash.
    await paymentService.createPaymentSession(collectionId, {
      provider_id: MANUAL_PROVIDER_ID,
      data: { payment_method: 'cash', payment_received: false },
      amount: collection.amount,
      currency_code: collection.currency_code,
      context: {},
    })
  }
  // The collection's amount is the cart total Medusa computed from stored prices.
  return Math.round(Number(collection.amount ?? 0))
}

/** D5: capture via the shared helper, then stamp the order as paid with its cash facts. */
async function captureCash(scope: Scope, orderId: string, cash: { tendered_cents: number | null; change_cents: number }): Promise<void> {
  const capture = await captureOrderPayment(scope, orderId)
  if (!capture.ok) throw new Error(`order ${orderId} has no payment to capture`)
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'order', fields: ['id', 'metadata'], filters: { id: orderId } })
  const meta = ((data?.[0] as any)?.metadata ?? {}) as Record<string, any>
  if (meta.payment_received === true && meta.in_person?.change_cents != null) return
  const orderService = scope.resolve(Modules.ORDER)
  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      payment_received: true,
      payment_received_at: meta.payment_received_at ?? new Date().toISOString(),
      payment_confirmed_by: 'seller_counter',
      in_person: { ...(meta.in_person ?? {}), tendered_cents: cash.tendered_cents, change_cents: cash.change_cents },
    },
  })
}

/** The cash facts of the sale an existing order recorded (stamped, or derived from its original tender). */
async function orderCashFacts(scope: Scope, orderId: string): Promise<{ tendered_cents: number | null; change_cents: number }> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'order', fields: ['id', 'metadata'], filters: { id: orderId } })
  const order = data?.[0] as any
  const ip = (order?.metadata?.in_person ?? {}) as Record<string, unknown>
  const tendered = typeof ip.tendered_cents === 'number' ? ip.tendered_cents : null
  if (typeof ip.change_cents === 'number') return { tendered_cents: tendered, change_cents: ip.change_cents }
  // No change stamped yet (the capture's metadata write failed): the ORIGINAL tendered
  // amount still rides the order, copied from the cart at completion — derive from it,
  // never from the retry's amount (codex re-review, #214).
  const total = await orderTotalCents(scope, orderId)
  return { tendered_cents: tendered, change_cents: cashChange(total, tendered).change_cents }
}

/** The order this cart already became, if any (Medusa's own `order_cart` link). */
async function orderForCart(scope: Scope, cartId: string): Promise<string | null> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'order_cart', fields: ['order_id'], filters: { cart_id: cartId } })
  return (data?.[0] as any)?.order_id ?? null
}

async function orderTotalCents(scope: Scope, orderId: string): Promise<number> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'order', fields: ['id', 'total'], filters: { id: orderId } })
  return Math.round(Number((data?.[0] as any)?.total ?? 0))
}

/**
 * The claim itself: `insert … on conflict do nothing returning id`. Returns the new
 * id, or null when this (seller, client_id) already exists.
 *
 * Raw SQL rather than the generated `create`, because the generated path re-throws
 * the unique violation as a generic `MedusaError(invalid_data, "… already exists")`
 * (utils `dbErrorMapper`) — indistinguishable from real bad data. Matching its
 * message would be guessing; ON CONFLICT is the database saying so (verifier, #214).
 */
async function insertClaim(
  scope: Scope,
  row: { seller_id: string; client_id: string; kind: string; payload_hash: string; offline: boolean; claimed_at: Date; claim_token: string },
): Promise<string | null> {
  const res = await knexOf(scope).raw(
    `insert into in_person_sale
       (id, seller_id, client_id, kind, status, payload_hash, offline, oversold, claimed_at, claim_token)
     values (?, ?, ?, ?, 'claimed', ?, ?, false, ?, ?)
     on conflict (seller_id, client_id) do nothing
     returning id`,
    [generateEntityId(undefined, 'ips'), row.seller_id, row.client_id, row.kind, row.payload_hash, row.offline, row.claimed_at, row.claim_token],
  )
  return res?.rows?.[0]?.id ?? null
}

function isStockError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e)
  // Only Medusa's two "not enough" messages (core-flows confirm-inventory and the
  // inventory module). A bare /stock/ also matched "not associated with any stock
  // location" — a configuration fault that must NOT close the claim as sold out.
  return /does not have the required inventory|not enough stock available/i.test(msg)
}

// ── Conditional claim writes ─────────────────────────────────────────────────────
// Raw SQL on purpose: the generated service `update` cannot say "only if I still own
// it", and every one of these writes is meaningless unless it can. Each returns
// whether THIS caller's write landed (LEARNINGS: a read is not a claim — make the
// write conditional and read the result back).

function knexOf(scope: Scope): any {
  return scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
}

/** Take over a claim judged stale. Wins only if nobody re-stamped it since we read it. */
async function takeOverClaim(
  scope: Scope,
  claimId: string,
  seenToken: string,
  newToken: string,
  now: Date,
): Promise<{ cart_id: string | null; metadata: Record<string, unknown> | null } | null> {
  // Staleness is re-checked IN the write, not only on the snapshot we read: the current
  // owner renews `claimed_at` while it works (the D12 fence), and a takeover decided on an
  // older read must lose to that renewal. The row returned is the row as taken over — its
  // metadata, not the earlier snapshot's, decides whether to resume the D12 fallback
  // (codex security lens, PR 220 round 4).
  const res = await knexOf(scope).raw(
    `update in_person_sale set claim_token = ?, claimed_at = ?, updated_at = now()
      where id = ? and claim_token = ? and status = 'claimed' and deleted_at is null
        and claimed_at <= ?
      returning cart_id, metadata`,
    [newToken, now, claimId, seenToken, new Date(now.getTime() - CLAIM_STALE_MS)],
  )
  const row = res?.rows?.[0]
  return row ? { cart_id: row.cart_id ?? null, metadata: row.metadata ?? null } : null
}

/** Record the cart this owner built. Fails if ownership moved, or a cart is already recorded. */
async function recordClaimCart(scope: Scope, claimId: string, token: string, cartId: string): Promise<boolean> {
  const res = await knexOf(scope).raw(
    `update in_person_sale set cart_id = ?, updated_at = now()
      where id = ? and claim_token = ? and cart_id is null and deleted_at is null
      returning id`,
    [cartId, claimId, token],
  )
  return (res?.rows?.length ?? 0) > 0
}

/** Make the claim immediately stale so the next resend takes it over (still owner-conditional). */
async function releaseClaim(scope: Scope, claimId: string, token: string): Promise<void> {
  await knexOf(scope).raw(
    `update in_person_sale set claimed_at = to_timestamp(0), updated_at = now()
      where id = ? and claim_token = ? and status = 'claimed'`,
    [claimId, token],
  )
}

/**
 * The answer for a card/transfer sale whose cart is built (fresh, resumed or replayed).
 * The STATE comes from the status read — the cart may already have become an order (a
 * buyer who paid before this resend), and a replay must never report a paid sale as
 * waiting (codex, PR 218).
 */
async function awaitingResult(scope: Scope, claim: any, status: 200 | 201, replayed: boolean): Promise<RecordResult> {
  const st = await getInPersonSaleStatus(scope, claim.seller_id, claim.client_id)
  return {
    ok: true,
    status,
    body: {
      order_id: st?.order_id ?? claim.order_id ?? null,
      total_cents: st?.total_cents ?? 0,
      change_cents: 0,
      replayed,
      cart_id: claim.cart_id,
      status: st?.state ?? 'awaiting_payment',
      // Read back from the payment session start-checkout opened — never stored from,
      // or trusted to, a client (verifier, PR 218).
      checkout_url: st?.checkout_url ?? null,
    },
  }
}

/**
 * Record one counter sale exactly once. `sale` must already be validated by
 * `validateInPersonSale`; `now` is injectable for the stale-claim boundary.
 */
export async function recordInPersonSale(
  scope: Scope,
  sellerId: string,
  sale: InPersonSaleInput,
  now: Date = new Date(),
): Promise<RecordResult> {
  // ── validate: the seller may transact, in MX, with its own variants ──────────
  const sellerService = scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id: sellerId })
  const gate = sellerRowEnforcement(seller)
  if (!gate.present) return refuse(404, 'SELLER_NOT_FOUND', 'No encontramos tu tienda.')
  if (!gate.admits) return refuse(409, 'seller_not_active', 'Tu tienda no está activa.')
  // D1: MX sellers only. A seller with no stored market reads as the legacy default
  // (mx) — the same rule start-checkout applies to every live seller today.
  if (readSellerOperatingMarket(seller).market !== 'mx') {
    return refuse(422, 'IN_PERSON_MX_ONLY', 'Vender en persona está disponible para tiendas de México.')
  }
  const channelId = resolveOperatingChannelId('mx', process.env)
  const regionId = resolveRegionIdForMarket('mx', process.env)
  if (!channelId || !regionId) {
    return refuse(503, 'MX_COMMERCE_UNCONFIGURED', 'La venta en persona no está configurada en este servidor.')
  }
  const owned = await assertSellerOwnsVariants(scope, sellerId, sale.lines.map((l) => l.variant_id))
  if (owned) return owned

  // ── claim ────────────────────────────────────────────────────────────────────
  const inPerson = scope.resolve(IN_PERSON_MODULE)
  const payloadHash = inPersonPayloadHash(sale)
  const token = randomUUID()
  let claimId: string
  let existingCartId: string | null = null
  let resumeOversold = false
  const insertedId = await insertClaim(scope, {
    seller_id: sellerId,
    client_id: sale.client_id,
    kind: sale.kind,
    payload_hash: payloadHash,
    offline: sale.offline,
    claimed_at: now,
    claim_token: token,
  })
  if (insertedId) {
    claimId = insertedId
  } else {
    const [existing] = await inPerson.listInPersonSales({ seller_id: sellerId, client_id: sale.client_id })
    // The index still conflicts on a soft-deleted claim (deliberately — a removed
    // claim must still block a replay); that is a closed sale, not a server error.
    if (!existing) return refuse(409, 'SALE_CLOSED', 'Esta venta ya no se puede registrar.', { status: 'deleted' })
    const outcome = decideExistingClaim(existing, payloadHash, now)
    switch (outcome.action) {
      case 'replay': {
        const total = await orderTotalCents(scope, outcome.order_id)
        return {
          ok: true,
          status: 200,
          body: {
            order_id: outcome.order_id,
            total_cents: total,
            // The change of the sale that was CAPTURED, stored at completion — not
            // recomputed from this retry's amount, which may differ (cross-review #214).
            change_cents: Number((existing.metadata as any)?.change_cents ?? 0),
            replayed: true,
          },
        }
      }
      case 'awaiting':
        return awaitingResult(scope, existing, 200, true)
      case 'reject_reused':
        return refuse(409, 'CLIENT_ID_REUSED', 'Este identificador ya se usó para otra venta.')
      case 'reject_closed':
        return refuse(409, 'SALE_CLOSED', 'Esta venta ya no se puede registrar.', { status: outcome.status })
      case 'in_progress':
        return refuse(409, 'IN_PROGRESS', 'La venta se está registrando. Intenta en un momento.')
      case 'takeover': {
        // Conditional on the token we READ: of two callers that both judged this claim
        // stale, exactly one wins; the other is told the sale is in progress.
        const won = await takeOverClaim(scope, existing.id, existing.claim_token, token, now)
        if (!won) return refuse(409, 'IN_PROGRESS', 'La venta se está registrando. Intenta en un momento.')
        claimId = existing.id
        existingCartId = won.cart_id
        // A previous attempt reached the D12 fallback: its order may already exist
        // OUTSIDE any cart. Resume THAT path (it adopts the order and finishes stock and
        // ledger) — the cart path cannot see it, and with stock back it would complete a
        // second order (verifier, PR 220).
        resumeOversold = Boolean((won.metadata as any)?.oversold_fallback_at)
        break
      }
    }
  }

  // D12 fallback, shared by a stock refusal and by a takeover that resumes it.
  const runOversoldFallback = async (): Promise<RecordResult> => {
    try {
      const { orderId, totalCents, oversold, adopted } = await recordOversoldOfflineSale(scope, {
        sellerId, sale, regionId, channelId,
        email: PLACEHOLDER_BUYER_EMAIL,
        soldAt: sale.sold_at ?? now.toISOString(),
        claimId, claimToken: token,
      })
      const { change_cents, short_cents } = cashChange(totalCents, sale.tendered_cents)
      // Token-conditional: only the current owner settles the claim.
      await knexOf(scope).raw(
        `update in_person_sale
            set status = 'completed', order_id = ?, oversold = ?, updated_at = now(),
                metadata = coalesce(metadata, '{}'::jsonb) || ?::jsonb
          where id = ? and claim_token = ?`,
        [orderId, oversold.length > 0, JSON.stringify({
          tendered_cents: sale.tendered_cents, change_cents, total_cents: totalCents, oversold,
          // The sale happened, so it is recorded even if the cash noted was short — but
          // the merchant sees it (verifier, PR 220).
          ...(short_cents > 0 ? { short_cents } : {}),
        }), claimId, token],
      )
      return { ok: true, status: adopted ? 200 : 201, body: { order_id: orderId, total_cents: totalCents, change_cents, replayed: adopted } }
    } catch (fallbackError) {
      if (fallbackError instanceof OversoldOwnershipLost) {
        return refuse(409, 'IN_PROGRESS', 'La venta se está registrando. Intenta en un momento.')
      }
      // Not a refusal: the sale happened. Keep the claim retryable (the queue resends).
      await releaseClaim(scope, claimId, token).catch(() => {})
      console.error('[in-person] offline oversell fallback failed', { claimId, message: (fallbackError as Error)?.message })
      return refuse(503, 'RETRY_SAME_ID', 'No se pudo registrar la venta sin señal. Se reintentará.')
    }
  }

  // ── apply ────────────────────────────────────────────────────────────────────
  if (resumeOversold) return runOversoldFallback()
  try {
    let cartId = existingCartId
    if (!cartId) {
      const { result: cart } = await createCartWorkflow(scope as any).run({
        input: {
          region_id: regionId,
          sales_channel_id: channelId,
          currency_code: 'mxn',
          // ALWAYS the placeholder, never the typed address: the cart workflow resolves
          // its email to an existing customer, and buyer order pages list by customer —
          // a seller typing a registered buyer's email would inject this order into that
          // buyer's account (codex security lens, #214). The typed address is receipt-only.
          email: PLACEHOLDER_BUYER_EMAIL,
          items: sale.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity })),
          metadata: {
            source: 'in_person',
            seller_id: sellerId,
            // Card/transfer: start-checkout overwrites this with the provider it opens.
            payment_method: sale.kind === 'cash' ? 'cash' : 'pending',
            fulfillment_method: 'in_person',
            in_person: {
              client_id: sale.client_id,
              kind: sale.kind,
              tendered_cents: sale.tendered_cents,
              sold_at: sale.sold_at ?? now.toISOString(),
              offline: sale.offline,
              receipt_email: sale.buyer_email,
            },
          },
        },
      })
      const builtCartId = (cart as any).id as string
      // If ownership moved while we built the cart (we were slow past the stale window
      // and someone took over), our cart is abandoned uncompleted — the new owner's
      // cart is the sale. Abandoned carts hold no reservation and no payment.
      if (!(await recordClaimCart(scope, claimId, token, builtCartId))) {
        return refuse(409, 'IN_PROGRESS', 'La venta se está registrando. Intenta en un momento.')
      }
      cartId = builtCartId
    }

    if (sale.kind !== 'cash') {
      // D9/D10: card and transfer stop here — the cart is the sale; the shop's own
      // checkout (start-checkout) takes the payment and the webhook / «Ya me llegó»
      // completes it. `awaiting_payment` is settled: a resend returns this same cart.
      // Record the server-computed total WITH the state change: start-checkout and the
      // completeCart hook refuse a cart whose lines or total no longer match it (a
      // promotion or a line edit through the public cart routes — codex, PR 218).
      const { data: priced } = await scope.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'cart', fields: ['id', 'total'], filters: { id: cartId },
      })
      await knexOf(scope).raw(
        `update in_person_sale
            set status = 'awaiting_payment',
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('total_cents', ?::int),
                updated_at = now()
          where id = ? and status = 'claimed'`,
        [Math.round(Number((priced?.[0] as any)?.total ?? 0)), claimId],
      )
      const [row] = await inPerson.listInPersonSales({ id: claimId })
      return awaitingResult(scope, row, existingCartId ? 200 : 201, Boolean(existingCartId))
    }

    // D4: `replayed` means THIS call did not create the order — the cart had already
    // become one (a crash between completion and the claim update). A takeover that
    // creates the first order is not a replay.
    const priorOrderId = await orderForCart(scope, cartId)
    const replayed = priorOrderId != null
    const amountCents = await prepareCartForCash(scope, cartId)
    if (!priorOrderId && cashChange(amountCents, sale.tendered_cents).short_cents > 0) {
      // Refused before the order exists. The claim is released, not failed: the
      // payload hash excludes the cash amount on purpose, so a resend with the
      // corrected amount takes the claim over and completes the same cart.
      await releaseClaim(scope, claimId, token)
      return refuse(422, 'TENDERED_SHORT', 'El efectivo recibido no cubre el total.', { total_cents: amountCents })
    }
    const { result: completed } = await completeCartWorkflow(scope as any).run({ input: { id: cartId } })
    const orderId = (completed as any).id as string
    const total = await orderTotalCents(scope, orderId)
    // A RESUMED order already carries the cash facts of the sale that was handed over;
    // those win over this retry's amount (codex re-review, #214). Only a fresh order
    // takes its change from this request.
    const stored = priorOrderId ? await orderCashFacts(scope, orderId) : null
    const tendered_cents = stored ? stored.tendered_cents : sale.tendered_cents
    const change_cents = stored ? stored.change_cents : cashChange(total, sale.tendered_cents).change_cents
    await captureCash(scope, orderId, { tendered_cents, change_cents })
    // Unconditional on purpose: two owners can only ever complete the SAME recorded
    // cart, which Medusa resolves to the same order, so both write identical facts.
    await inPerson.updateInPersonSales({
      id: claimId,
      status: 'completed',
      order_id: orderId,
      metadata: { tendered_cents, change_cents, total_cents: total },
    })
    return { ok: true, status: replayed ? 200 : 201, body: { order_id: orderId, total_cents: total, change_cents, replayed } }
  } catch (e) {
    if (isStockError(e) && sale.offline && sale.kind === 'cash') {
      // D12: an OFFLINE cash sale already happened — record it anyway, decrement what
      // stock has, and flag the shortfall (in-person-sale-oversold.ts). Online sales keep
      // the normal refusal below.
      return runOversoldFallback()
    }
    if (isStockError(e)) {
      // A definitive refusal: this sale can never complete as rung up. Close the
      // claim so a resend of the same client_id is told so instead of retrying.
      await inPerson.updateInPersonSales({ id: claimId, status: 'failed', metadata: { reason: 'out_of_stock' } })
      return refuse(409, 'OUT_OF_STOCK', 'No hay suficiente inventario para esta venta.', { message: (e as Error).message })
    }
    // Transient: release the claim (stale now) so an immediate retry takes it over
    // and resumes the recorded cart instead of waiting out the stale window.
    await releaseClaim(scope, claimId, token).catch(() => {})
    // Answered, never re-thrown: Medusa's error handler maps a thrown error by its
    // type (NOT_ALLOWED/INVALID_DATA → 400, CONFLICT → 409), and a 4xx after the claim
    // reads to a client as "this sale was refused, start over" — which, after an order
    // may already exist (a capture that failed post-completion), is a double sale. One
    // explicit code says the only safe thing: resend THIS client_id (verifier, #458).
    console.error('[in-person] post-claim failure — client must resend the same client_id', {
      claimId, message: (e as Error)?.message,
    })
    return refuse(503, 'RETRY_SAME_ID', 'No se pudo terminar de registrar la venta. Toca «Reintentar»: no se cobra doble.')
  }
}
