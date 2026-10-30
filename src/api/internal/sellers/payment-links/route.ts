/**
 * Internal service routes — a shop's MCP agent creates and lists ITS OWN payment links
 * (in-person-sales S4.4, D16). The agent's `ms_agent_` token is resolved to ONE shop by
 * the storefront, which calls these with the shop slug and the shared secret — the same
 * auth shape as `internal/sellers/orders`. Validation and scoping are the web routes'
 * own core (`lib/payment-link-apply.ts`), so an agent's link is a web link.
 *
 *   POST /internal/sellers/payment-links?seller_slug=<slug>   body: as the web create
 *   GET  /internal/sellers/payment-links?seller_slug=<slug>
 *
 * Auth: x-internal-secret, fail-closed.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import { internalSecretOk } from '../../../../lib/internal-auth'
import { createPaymentLink, listPaymentLinks } from '../../../../lib/payment-link-apply'

export async function sellerIdFromSlug(req: MedusaRequest): Promise<string | null> {
  const slug = typeof req.query.seller_slug === 'string' ? req.query.seller_slug : ''
  if (!slug) return null
  const sellers: any = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellers.listSellers({ slug } as never, { take: 1 })
  return seller?.id ?? null
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })
  const sellerId = await sellerIdFromSlug(req)
  if (!sellerId) return res.status(404).json({ code: 'SELLER_NOT_FOUND', message: 'Seller not found' })
  const r = await createPaymentLink(req.scope, sellerId, req.body)
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message, details: r.details ?? null })
  return res.status(r.status).json({ payment_link: r.body })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })
  const sellerId = await sellerIdFromSlug(req)
  if (!sellerId) return res.status(404).json({ code: 'SELLER_NOT_FOUND', message: 'Seller not found' })
  const r = await listPaymentLinks(req.scope, sellerId)
  if (!r.ok) return res.status(r.status).json({ code: r.code, message: r.message })
  return res.json(r.body)
}
