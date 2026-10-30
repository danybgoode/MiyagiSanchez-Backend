import { model } from '@medusajs/framework/utils'

/**
 * InPersonSale — the exactly-once claim for one counter sale (in-person-sales D4).
 *
 * The unique index on (seller_id, client_id) IS the idempotency guarantee. The
 * order of writes is validate → claim (this insert) → apply (cart → order), and
 * `cart_id` is recorded BEFORE the cart is completed: a takeover of a stale claim
 * re-completes the SAME cart, and Medusa returns that cart's existing order rather
 * than creating a second one. Redis is deliberately not involved — Redis-specific
 * behaviour is ungated in the money-path CI.
 */
const InPersonSale = model
  .define('in_person_sale', {
    id: model.id({ prefix: 'ips' }).primaryKey(),
    seller_id: model.text(),
    /** Device-generated UUID, minted when the sale is rung up (survives offline resends). */
    client_id: model.text(),
    /** 'cash' | 'card' | 'transfer'. */
    kind: model.text(),
    /** 'claimed' | 'completed' | 'cancelled' | 'failed'. */
    status: model.text(),
    /** sha256 of the canonical payload — the same client_id with a different sale is refused. */
    payload_hash: model.text(),
    cart_id: model.text().nullable(),
    order_id: model.text().nullable(),
    offline: model.boolean().default(false),
    oversold: model.boolean().default(false),
    /** When the current owner took the claim; a claim older than the stale window may be taken over. */
    claimed_at: model.dateTime(),
    metadata: model.json().nullable(),
  })
  .indexes([
    { on: ['seller_id', 'client_id'], unique: true },
    { on: ['seller_id'] },
  ])

export default InPersonSale
