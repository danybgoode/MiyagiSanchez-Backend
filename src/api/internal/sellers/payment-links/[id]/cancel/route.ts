/**
 * POST /internal/sellers/payment-links/:id/cancel?seller_slug=<slug> — an agent cancels
 * one of ITS OWN shop's links (in-person-sales S4.4). Another shop's link id is 404.
 * Auth: x-internal-secret, fail-closed.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { internalSecretOk } from '../../../../../../lib/internal-auth'
import { cancelPaymentLink } from '../../../../../../lib/payment-link-apply'
import { sellerIdFromSlug } from '../../route'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })
  const sellerId = await sellerIdFromSlug(req)
  if (!sellerId) return res.status(404).json({ code: 'SELLER_NOT_FOUND', message: 'Seller not found' })
  const r = await cancelPaymentLink(req.scope, sellerId, String(req.params.id))
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message })
  return res.json({ payment_link: r.body })
}
