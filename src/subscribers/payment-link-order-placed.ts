/**
 * Payment links · an order was placed from a link cart (in-person-sales S4, D13).
 *
 * `order.placed` fires once per order. The order's cart is looked up through Medusa's
 * own `order_cart` link and then in `payment_link_cart` (the server's record — never
 * the order's client-written metadata). The order id is appended to the link's
 * `paid_order_ids`; a single-use link becomes `paid` — conditionally on still being
 * `pending`, so a seller's cancel is never overwritten. A second payment of a single-use
 * link (two buyers who both opened it before either paid) is recorded, never refunded:
 * money taken is never hidden.
 */
import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { IN_PERSON_MODULE } from '../modules/in-person'

export default async function paymentLinkOrderPlaced({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: oc } = await query.graph({ entity: 'order_cart', fields: ['cart_id'], filters: { order_id: data.id } })
    const cartId = (oc?.[0] as any)?.cart_id
    if (!cartId) return
    const inPerson: any = container.resolve(IN_PERSON_MODULE)
    const [lc] = await inPerson.listPaymentLinkCarts({ cart_id: cartId }, { take: 1 })
    if (!lc) return
    const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    // Append idempotently (a redelivered event must not list the order twice), then close
    // a single-use link only while it is still pending.
    await knex.raw(
      `update payment_link
          set paid_order_ids = case
                when coalesce(paid_order_ids, '[]'::jsonb) @> to_jsonb(?::text) then paid_order_ids
                else coalesce(paid_order_ids, '[]'::jsonb) || to_jsonb(?::text)
              end,
              status = case when uses = 'single' and status = 'pending' then 'paid' else status end,
              updated_at = now()
        where id = ?`,
      [data.id, data.id, lc.payment_link_id],
    )
  } catch (e) {
    // Best effort, loudly: the order itself is unaffected; the link's status is a view.
    console.error('[payment-link-order-placed] could not record the payment on its link', data.id, (e as Error)?.message)
  }
}

export const config: SubscriberConfig = { event: 'order.placed' }
