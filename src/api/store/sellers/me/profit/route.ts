import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { resolveSeller } from '../../../_utils/clerk-auth'
import { isEnabled } from '../../../../../lib/flags'
import { readSellerLedger } from '../../../_utils/profit-ledger-read'

/**
 * GET /store/sellers/me/profit — the seller's financial-events ledger, with
 * just enough order/line enrichment (titles, product ids) for the frontend's
 * pure margin math (`lib/profit.ts`) to aggregate per order and per SKU.
 * Raw events out, no margin math here — the calc lives in ONE pure, spec'd
 * seam on the frontend (profit-analyzer S1 · US-3).
 *
 * The read itself is `readSellerLedger` (shared with the internal check-in read,
 * business-infrastructure D12), so the two can never return different shapes.
 *
 * Gate order: flag → auth (LEARNINGS — the flag decides whether the route
 * "exists" before any other gate answers).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await isEnabled('ops.profit_enabled'))) {
    return res.status(404).json({ message: 'Not found' })
  }

  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return res.status(401).json({ message: 'Unauthorized' })

  res.json(await readSellerLedger(req.scope, sellerAuth.sellerId))
}
