import { model } from '@medusajs/framework/utils'

/**
 * PaymentLink — «Cobrar con un link» (in-person-sales S4, D13).
 *
 * A seller-owned request for payment: catalog products (`kind: products`, `lines`) or a
 * free amount with a concept (`kind: amount`). The `token` is the only thing a buyer
 * holds — 32 random bytes, base64url, unique — so it is unguessable and never derived
 * from an id. `expired` is NOT stored: it is derived from `expires_at` when read
 * (no cron), so a link can never be "pending" past its time because a job did not run.
 */
const PaymentLink = model
  .define('payment_link', {
    id: model.id({ prefix: 'plink' }).primaryKey(),
    seller_id: model.text(),
    token: model.text(),
    /** 'products' | 'amount'. */
    kind: model.text(),
    /** kind=products: [{ variant_id, quantity }]. */
    lines: model.json().nullable(),
    /** kind=amount: the concept the buyer sees («Anticipo pastel»). */
    concept: model.text().nullable(),
    /** kind=amount: integer centavos MXN. */
    amount_cents: model.number().nullable(),
    /** 'single' | 'multi'. */
    uses: model.text(),
    expires_at: model.dateTime(),
    /** 'pending' | 'paid' | 'cancelled' — expired is derived from expires_at. */
    status: model.text(),
    /** Every order this link has been paid by (a single-use link paid twice records both). */
    paid_order_ids: model.json().nullable(),
    metadata: model.json().nullable(),
  })
  .indexes([
    { on: ['token'], unique: true },
    { on: ['seller_id'] },
  ])

export default PaymentLink
