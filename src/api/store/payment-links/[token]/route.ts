/**
 * GET /store/payment-links/:token — what the buyer's pay page shows (in-person-sales
 * S4.2, D15): the shop, the concept or products, the total and the link's state. Public
 * (the token is the credential); nothing seller-internal is returned.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { publicPaymentLink } from '../../../../lib/payment-link-cart'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const r = await publicPaymentLink(req.scope, String(req.params.token))
  res.setHeader('Cache-Control', 'private, no-store')
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message })
  return res.json({ payment_link: r.body })
}
