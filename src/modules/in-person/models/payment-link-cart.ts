import { model } from '@medusajs/framework/utils'

/**
 * PaymentLinkCart — the server's record that a cart was built from a payment link
 * (in-person-sales S4, D15). Like `in_person_sale` for counter carts, this — never the
 * cart's client-writable metadata — is what makes start-checkout, the cart lock and the
 * completion hook treat a cart as a link cart. `total_cents` is the server total at
 * creation: a link cart whose lines or total changed is refused.
 */
const PaymentLinkCart = model
  .define('payment_link_cart', {
    id: model.id({ prefix: 'plcart' }).primaryKey(),
    payment_link_id: model.text(),
    cart_id: model.text(),
    seller_id: model.text(),
    total_cents: model.number(),
    /** The canonical-lines hash (same function as counter claims). */
    payload_hash: model.text(),
    metadata: model.json().nullable(),
  })
  .indexes([
    { on: ['cart_id'], unique: true },
    { on: ['payment_link_id'] },
  ])

export default PaymentLinkCart
