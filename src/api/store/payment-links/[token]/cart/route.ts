/**
 * POST /store/payment-links/:token/cart — build a fresh, server-priced cart for this
 * opener of the link (in-person-sales S4.2, D15). Refuses a paid single-use, expired or
 * cancelled link with the pay page's own words. The cart then goes to start-checkout.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { buildPaymentLinkCart } from '../../../../../lib/payment-link-cart'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const r = await buildPaymentLinkCart(req.scope, String(req.params.token))
  res.setHeader('Cache-Control', 'private, no-store')
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message })
  return res.status(201).json(r.body)
}
