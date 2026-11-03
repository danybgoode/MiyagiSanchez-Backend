/**
 * Internal service route — one seller's profit ledger, for the monthly business check-in (business-infrastructure
 * D12). The check-in runs from a timer with no Clerk session, so the storefront (which holds the shared secret and has
 * already chosen the seller from its own `business_models` row) asks here by seller id.
 *
 *   GET /internal/profit/ledger?seller_id=…   → { events, orders }   (the SAME shape as GET /store/sellers/me/profit)
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (the sibling internal routes' door). Gate order matches
 * the seller route: ops.profit_enabled → auth → the seller must exist → `readSellerLedger`, the one shared read.
 * Read-only.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { isEnabled } from '../../../../lib/flags'
import { readSellerLedger } from '../../../store/_utils/profit-ledger-read'
import { internalSecretMatches } from '../../_utils/internal-secret'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await isEnabled('ops.profit_enabled'))) {
    return res.status(404).json({ message: 'Not found' })
  }
  if (!internalSecretMatches(process.env.MEDUSA_INTERNAL_SECRET, req.headers['x-internal-secret'])) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const sellerId = typeof req.query?.seller_id === 'string' ? req.query.seller_id.trim() : ''
  if (!/^[A-Za-z0-9_]{1,80}$/.test(sellerId)) return res.status(400).json({ message: 'seller_id required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id: sellerId } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  res.json(await readSellerLedger(req.scope, seller.id))
}
