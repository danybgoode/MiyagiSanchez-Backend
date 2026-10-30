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
import { resolveShippingOptionIds } from '../api/store/_utils/fulfillment'
import { readSellerOperatingMarket } from './seller-market'
import { sellerRowEnforcement } from './seller-status'
import { resolveOperatingChannelId, resolveRegionIdForMarket } from './market-medusa'
import {
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
        order_id: string
        total_cents: number
        change_cents: number
        replayed: boolean
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
): Promise<{ cart_id: string | null } | null> {
  const res = await knexOf(scope).raw(
    `update in_person_sale set claim_token = ?, claimed_at = ?, updated_at = now()
      where id = ? and claim_token = ? and status = 'claimed' and deleted_at is null
      returning cart_id`,
    [newToken, now, claimId, seenToken],
  )
  const row = res?.rows?.[0]
  return row ? { cart_id: row.cart_id ?? null } : null
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
 * Record one counter sale exactly once. `sale` must already be validated by
 * `validateInPersonSale`; `now` is injectable for the stale-claim boundary.
 */
export async function recordInPersonSale(
  scope: Scope,
  sellerId: string,
  sale: InPersonSaleInput,
  now: Date = new Date(),
): Promise<RecordResult> {
  // S1 ships cash; card (S2.1) and transfer (S2.2) are refused BEFORE any claim, so
  // a client that sends them early leaves nothing behind to clean up.
  if (sale.kind !== 'cash') {
    return refuse(422, 'KIND_NOT_AVAILABLE', 'Este método de cobro todavía no está disponible en el mostrador.')
  }

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
  let replayed = false
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
    if (!existing) throw new Error('in_person_sale conflict but no row — refusing to guess')
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
        break
      }
    }
  }

  // ── apply ────────────────────────────────────────────────────────────────────
  try {
    let cartId = existingCartId
    if (!cartId) {
      const { result: cart } = await createCartWorkflow(scope as any).run({
        input: {
          region_id: regionId,
          sales_channel_id: channelId,
          currency_code: 'mxn',
          email: sale.buyer_email ?? PLACEHOLDER_BUYER_EMAIL,
          items: sale.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity })),
          metadata: {
            source: 'in_person',
            seller_id: sellerId,
            payment_method: 'cash',
            fulfillment_method: 'in_person',
            in_person: {
              client_id: sale.client_id,
              kind: sale.kind,
              tendered_cents: sale.tendered_cents,
              sold_at: sale.sold_at ?? now.toISOString(),
              offline: sale.offline,
              buyer_email_placeholder: !sale.buyer_email,
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

    // D4: `replayed` means THIS call did not create the order — the cart had already
    // become one (a crash between completion and the claim update). A takeover that
    // creates the first order is not a replay.
    const priorOrderId = await orderForCart(scope, cartId)
    replayed = priorOrderId != null
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
    const { change_cents } = cashChange(total, sale.tendered_cents)
    await captureCash(scope, orderId, { tendered_cents: sale.tendered_cents, change_cents })
    // Unconditional on purpose: two owners can only ever complete the SAME recorded
    // cart, which Medusa resolves to the same order, so both write identical facts.
    await inPerson.updateInPersonSales({
      id: claimId,
      status: 'completed',
      order_id: orderId,
      metadata: { tendered_cents: sale.tendered_cents, change_cents, total_cents: total },
    })
    return { ok: true, status: replayed ? 200 : 201, body: { order_id: orderId, total_cents: total, change_cents, replayed } }
  } catch (e) {
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
