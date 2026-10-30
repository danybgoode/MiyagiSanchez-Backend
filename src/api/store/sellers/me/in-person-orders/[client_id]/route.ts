/**
 * GET /store/sellers/me/in-person-orders/:client_id
 *
 * The counter polls this while a buyer pays a card QR, or until a transfer is
 * confirmed (in-person-sales S2 · D9/D10). Read from Medusa only — never from a
 * client signal. Scoped to the authenticated seller: another seller's client_id is 404.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../../_utils/clerk-auth'
import { getInPersonSaleStatus } from '../../../../../../lib/in-person-sale-status'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })
  const status = await getInPersonSaleStatus(req.scope, sellerAuth.sellerId, String(req.params.client_id).toLowerCase())
  if (!status) return res.status(404).json({ code: 'SALE_NOT_FOUND', message: 'No encontramos esa venta.' })
  return res.json(status)
}
