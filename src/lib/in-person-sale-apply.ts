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
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  addShippingMethodToCartWorkflow,
  capturePaymentWorkflow,
  completeCartWorkflow,
  createCartWorkflow,
  createPaymentCollectionForCartWorkflow,
} from '@medusajs/medusa/core-flows'
import { IN_PERSON_MODULE } from '../modules/in-person'
import { SELLER_MODULE } from '../modules/seller'
import { isUniqueViolationError } from '../modules/mercadolibre/sync-utils'
import { resolveSellerProductIds } from '../api/store/_utils/seller-catalog-query'
import { isHiddenCatalogProduct } from '../api/store/_utils/support'
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

/** The manual provider every live "Pago directo" checkout already uses (D5). */
const MANUAL_PROVIDER_ID = 'pp_manual_manual'

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
    fields: ['id', 'product_id', 'product.metadata', 'product.status'],
    filters: { id: variantIds },
  })
  const byId = new Map<string, any>((data ?? []).map((v: any) => [v.id, v]))
  const refused = variantIds.filter((id) => {
    const v = byId.get(id)
    return !v || !owned.has(v.product_id) || isHiddenCatalogProduct(v.product?.metadata)
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
    await addShippingMethodToCartWorkflow(scope as any).run({
      input: { cart_id: cartId, options: [{ id: optionId }] },
    })
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
    // Direct module call, exactly as start-checkout's live manual branch does: the
    // workflow variant re-checks region providers, which this path does not need.
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

/** Capture the order's cash payment unless it is already captured (takeover-safe). */
async function captureCash(scope: Scope, orderId: string): Promise<void> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'order',
    fields: ['id', 'metadata', 'payment_collections.payments.id', 'payment_collections.payments.captured_at'],
    filters: { id: orderId },
  })
  const order = data?.[0] as any
  const payment = order?.payment_collections?.[0]?.payments?.[0]
  if (!payment?.id) throw new Error(`order ${orderId} has no payment to capture`)
  if (!payment.captured_at) {
    await capturePaymentWorkflow(scope as any).run({ input: { payment_id: payment.id } })
  }
  const meta = (order?.metadata ?? {}) as Record<string, unknown>
  if (meta.payment_received !== true) {
    const orderService = scope.resolve(Modules.ORDER)
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        payment_received: true,
        payment_received_at: new Date().toISOString(),
        payment_confirmed_by: 'seller_counter',
      },
    })
  }
}

async function orderTotalCents(scope: Scope, orderId: string): Promise<number> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'order', fields: ['id', 'total'], filters: { id: orderId } })
  return Math.round(Number((data?.[0] as any)?.total ?? 0))
}

function isStockError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e)
  return /inventory|stock|required quantity/i.test(msg)
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
  // D1: an unreadable market is NOT treated as mx here — a counter sale writes stock
  // and money, so "I could not tell" refuses rather than guessing.
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
  let claimId: string
  let existingCartId: string | null = null
  let replayed = false
  try {
    const row = await inPerson.createInPersonSales({
      seller_id: sellerId,
      client_id: sale.client_id,
      kind: sale.kind,
      status: 'claimed',
      payload_hash: payloadHash,
      offline: sale.offline,
      claimed_at: now,
    })
    claimId = row.id
  } catch (e) {
    if (!isUniqueViolationError(e)) throw e
    const [existing] = await inPerson.listInPersonSales({ seller_id: sellerId, client_id: sale.client_id })
    if (!existing) throw e
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
            change_cents: cashChange(total, sale.tendered_cents).change_cents,
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
        // Re-stamp claimed_at so a third caller sees an in-flight claim, not a stale one.
        await inPerson.updateInPersonSales({ id: existing.id, claimed_at: now })
        claimId = existing.id
        existingCartId = outcome.cart_id
        replayed = true
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
      cartId = (cart as any).id as string
      await inPerson.updateInPersonSales({ id: claimId, cart_id: cartId })
    }

    const amountCents = await prepareCartForCash(scope, cartId)
    if (cashChange(amountCents, sale.tendered_cents).short_cents > 0) {
      // Refused before the order exists. The claim is released, not failed: the
      // payload hash excludes the cash amount on purpose, so a resend with the
      // corrected amount takes the claim over and completes the same cart.
      await inPerson.updateInPersonSales({ id: claimId, claimed_at: new Date(0) })
      return refuse(422, 'TENDERED_SHORT', 'El efectivo recibido no cubre el total.', { total_cents: amountCents })
    }
    const { result: completed } = await completeCartWorkflow(scope as any).run({ input: { id: cartId } })
    const orderId = (completed as any).id as string
    await captureCash(scope, orderId)
    await inPerson.updateInPersonSales({ id: claimId, status: 'completed', order_id: orderId })

    const total = await orderTotalCents(scope, orderId)
    const { change_cents } = cashChange(total, sale.tendered_cents)
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
    await inPerson.updateInPersonSales({ id: claimId, claimed_at: new Date(0) }).catch(() => {})
    throw e
  }
}
