/**
 * PATCH /store/sellers/me/orders/:id/confirm-payment
 *
 * Seller marks SPEI/cash payment as received. Triggers capturePaymentWorkflow
 * on the system provider (pp_system_default), which records the capture and
 * sets the order's payment_status to 'paid'.
 *
 * Only allowed for orders with payment_method 'spei' or 'cash' that have not
 * yet been confirmed.
 *
 * Auth: Clerk JWT — must be the seller who owns the order's product.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { captureOrderPayment } from '../../../../../../../lib/order-payment-capture'
import { recordLinkOrder } from '../../../../../../../lib/payment-link-cart'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import {
  resolveSellerProductIds,
  sellerOwnsEveryOrderItem,
} from '../../../../../_utils/seller-catalog-query'
import { logger } from '../../../../../../../lib/logger'

async function resolveOrderForSeller(req: MedusaRequest, orderId: string) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return { order: null, sellerId: null, code: 401 as const }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const [order] = await orderService.listOrders(
    { id: orderId },
    { select: ['id', 'status', 'payment_status', 'metadata'], relations: ['items'] }
  )
  if (!order) return { order: null, sellerId: null, code: 404 as const }

  // Reject outright when ownership can't be established at all (no resolvable
  // product ids on the order) — this route captures a payment and writes
  // order-level metadata, so silently allowing it through here would let any
  // authenticated seller confirm payment on any such order.
  const sellerProductIds = await resolveSellerProductIds(
    req.scope,
    sellerAuth.sellerId,
  )
  // Require ownership of EVERY item, not just one — capturing payment is an
  // ORDER-level action, so a seller who owns only some items must not be
  // able to trigger it for the whole order (cross-agent review catch,
  // 2026-07-07). A cart can only ever hold one seller's items in normal use
  // (lib/cart.ts on the frontend enforces this at checkout), so this is a
  // no-op for every real order today — pure defense-in-depth.
  if (!sellerOwnsEveryOrderItem(sellerProductIds, order.items)) {
    return { order: null, sellerId: null, code: 403 as const }
  }

  return { order, sellerId: sellerAuth.sellerId, code: 200 as const }
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) {
    return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })
  }

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const paymentMethod = meta.payment_method as string | undefined

  if (!['manual', 'spei', 'cash', 'dimo'].includes(paymentMethod ?? '')) {
    return res.status(422).json({ message: 'Este pedido no es de pago manual (SPEI/efectivo/DiMo).' })
  }

  if (meta.payment_received) {
    return res.status(409).json({ message: 'El pago ya fue confirmado para este pedido.' })
  }

  try {
    const capture = await captureOrderPayment(req.scope, orderId)
    if (!capture.ok) {
      return res.status(422).json({ message: 'No se encontró el registro de pago para este pedido.' })
    }
  } catch (e) {
    const msg = (e as Error).message ?? 'Capture failed'
    logger.error('confirm-payment', 'capture failed', { orderId, message: msg })
    return res.status(502).json({ message: `No se pudo confirmar el pago: ${msg}` })
  }

  const now = new Date().toISOString()
  const orderService: any = req.scope.resolve(Modules.ORDER)

  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      payment_received: true,
      payment_received_at: now,
      payment_confirmed_by: 'seller',
    },
  })

  // A «Pago directo» order paid through a payment link closes its single-use link only
  // now that the seller confirmed the money (in-person-sales S4, D13). Best effort: the
  // confirmation itself already stands.
  await recordLinkOrder(req.scope, orderId).catch((e: unknown) =>
    logger.error('confirm-payment', 'could not record the payment on its link', { orderId, message: (e as Error)?.message }))

  return res.json({
    confirmed: true,
    payment_received_at: now,
  })
}
