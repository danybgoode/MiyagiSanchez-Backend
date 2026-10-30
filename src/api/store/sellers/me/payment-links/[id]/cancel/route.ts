/**
 * POST /store/sellers/me/payment-links/:id/cancel — cancel one of THIS seller's links
 * that can still be paid (in-person-sales S4.1, D13). Another seller's id is 404.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import { cancelPaymentLink } from '../../../../../../../lib/payment-link-apply'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })
  const r = await cancelPaymentLink(req.scope, seller.sellerId, String(req.params.id))
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message })
  return res.json({ payment_link: r.body })
}
