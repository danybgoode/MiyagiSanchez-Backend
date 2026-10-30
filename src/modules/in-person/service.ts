import { MedusaService } from '@medusajs/framework/utils'
import InPersonSale from './models/in-person-sale'

/**
 * In-person sales module (in-person-sales epic, D4).
 *
 * `in_person_sale` is the CLAIM ledger for counter sales: one row per device
 * `client_id`, unique per seller. The row exists so "exactly once" is a database
 * fact, not a read-then-write — the insert is the claim, and a unique violation
 * is how a replay (double tap, flaky reconnect, offline resend) is recognised.
 */
class InPersonModuleService extends MedusaService({ InPersonSale }) {}

export default InPersonModuleService
