/**
 * Payment links · an order was placed from a link cart (in-person-sales S4, D13).
 *
 * `order.placed` fires once per order. The order's cart is looked up through Medusa's
 * own `order_cart` link and then in `payment_link_cart` (the server's record — never
 * the order's client-written metadata); the rules are `recordLinkOrder`'s. A second payment of a single-use
 * link (two buyers who both opened it before either paid) is recorded, never refunded:
 * money taken is never hidden.
 */
import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { recordLinkOrder } from '../lib/payment-link-cart'

export default async function paymentLinkOrderPlaced({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  try {
    await recordLinkOrder(container as any, data.id)
  } catch (e) {
    // Best effort, loudly: the order itself is unaffected; the link's status is a view.
    console.error('[payment-link-order-placed] could not record the payment on its link', data.id, (e as Error)?.message)
  }
}

export const config: SubscriberConfig = { event: 'order.placed' }
