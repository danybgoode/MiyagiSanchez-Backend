/**
 * POST /store/sellers/me/in-person-orders/:client_id/cancel
 *
 * The merchant cancels a card QR or a transfer that has not been paid
 * (in-person-sales S2 · D9). The provider checkout is expired before the sale is
 * closed, so a cancelled QR can no longer be paid; a sale the webhook already settled
 * is reported as paid, never hidden. Seller-scoped.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import { cancelInPersonSale } from '../../../../../../../lib/in-person-sale-status'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })
  const result = await cancelInPersonSale(req.scope, sellerAuth.sellerId, String(req.params.client_id).toLowerCase())
  if (!result.ok) return res.status(result.status).json({ code: result.code, message: result.message })
  return res.json(result.status)
}
