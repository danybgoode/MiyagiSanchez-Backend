import { MedusaService } from '@medusajs/framework/utils'
import InPersonSale from './models/in-person-sale'
import PaymentLink from './models/payment-link'
import PaymentLinkCart from './models/payment-link-cart'

/**
 * In-person sales module (in-person-sales epic).
 *
 * `in_person_sale` is the CLAIM ledger for counter sales: one row per device
 * `client_id`, unique per seller. The row exists so "exactly once" is a database
 * fact, not a read-then-write — the insert is the claim, and a unique violation
 * is how a replay (double tap, flaky reconnect, offline resend) is recognised.
 *
 * `payment_link` + `payment_link_cart` (S4, D13/D15) are «Cobrar con un link»: the
 * seller's link and the server's record of every cart built from it.
 */
class InPersonModuleService extends MedusaService({ InPersonSale, PaymentLink, PaymentLinkCart }) {}

export default InPersonModuleService
