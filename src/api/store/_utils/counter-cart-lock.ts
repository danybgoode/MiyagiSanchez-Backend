import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IN_PERSON_MODULE } from '../../../modules/in-person'
import { cartMutationTarget } from '../../../lib/in-person-sale'

/**
 * Counter carts are server-owned (in-person-sales D8). Once the merchant rings a sale up,
 * Medusa's public cart and payment-session routes may not change it: rounds 5–9 of cross-
 * review on PR 218 were each a new way for someone holding the cart id to edit lines, add a
 * promotion, swap or add a payment session, or point the counter's QR at their own URL.
 * Every such route is refused here for a cart an `in_person_sale` claim owns; completion,
 * start-checkout and mp-authorize stay open (they guard counter carts themselves) — the
 * pure decision is `cartMutationTarget`. A cart with no claim is untouched.
 */
export async function refuseCounterCartMutation(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const target = cartMutationTarget(req.method, req.originalUrl ?? req.path)
  if (!target) return next()
  try {
    let cartId: string | null = null
    if ('cartId' in target) cartId = target.cartId
    else if ('bodyCart' in target) cartId = typeof (req.body as any)?.cart_id === 'string' ? (req.body as any).cart_id : null
    else {
      const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({ entity: 'payment_collection', fields: ['id', 'cart.id'], filters: { id: target.collectionId } })
      cartId = (data?.[0] as any)?.cart?.id ?? null
    }
    if (!cartId) return next()
    const inPerson: any = req.scope.resolve(IN_PERSON_MODULE)
    const [claim] = await inPerson.listInPersonSales({ cart_id: cartId }, { take: 1 })
    // Payment-link carts (S4) are server-owned the same way.
    const [linkCart] = claim ? [null] : await inPerson.listPaymentLinkCarts({ cart_id: cartId }, { take: 1 })
    if (!claim && !linkCart) return next()
    return res.status(409).json({ code: 'COUNTER_CART_LOCKED', message: 'Esta venta en persona no se puede modificar.' })
  } catch (e) {
    // Fail CLOSED: if we cannot tell whether this is a counter cart, a mutation waits.
    console.error('[counter-cart-lock] lookup failed', (e as Error)?.message)
    return res.status(503).json({ code: 'COUNTER_CART_CHECK_UNAVAILABLE', message: 'Intenta de nuevo en un momento.' })
  }
}
