/**
 * POST /store/sellers/me/in-person-orders
 *
 * Record a counter sale («Vender en persona») as a real Medusa order, exactly once
 * per device `client_id` (in-person-sales epic, S1.2 · D1–D6). A replay — a double
 * tap, a flaky reconnect, an offline resend — returns the first order with
 * `replayed: true`.
 *
 * Body: { client_id: uuid, kind: 'cash', lines: [{ variant_id, quantity }],
 *         tendered_cents?: int, offline?: bool, sold_at?: iso, buyer_email?: string }
 *
 * Auth: Clerk JWT (the `/store/sellers/me` subtree is identity-verified and
 * write-gated in middlewares.ts). The seller is resolved from the token, never the body.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../_utils/clerk-auth'
import { validateInPersonSale } from '../../../../../lib/in-person-sale'
import { recordInPersonSale } from '../../../../../lib/in-person-sale-apply'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })

  const validated = validateInPersonSale(req.body)
  if (!validated.ok) return res.status(400).json({ code: validated.code, message: validated.message })

  const result = await recordInPersonSale(req.scope, sellerAuth.sellerId, validated.sale)
  if (!result.ok) {
    return res.status(result.status).json({ code: result.code, message: result.message, details: result.details ?? null })
  }
  return res.status(result.status).json(result.body)
}
