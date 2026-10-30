/**
 * POST /store/sellers/me/payment-links — create a «Cobrar con un link» link.
 * GET  /store/sellers/me/payment-links — this seller's links, newest first.
 *
 * in-person-sales S4.1 (D13). Clerk-authenticated (the `/store/sellers/me` subtree is
 * identity-verified and write-gated in middlewares.ts); the seller comes from the token.
 * The core is shared with the MCP internal routes (`lib/payment-link-apply.ts`).
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../_utils/clerk-auth'
import { createPaymentLink, listPaymentLinks } from '../../../../../lib/payment-link-apply'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })
  const r = await createPaymentLink(req.scope, seller.sellerId, req.body)
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message, details: r.details ?? null })
  return res.status(r.status).json({ payment_link: r.body })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })
  const r = await listPaymentLinks(req.scope, seller.sellerId)
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message })
  return res.json(r.body)
}
