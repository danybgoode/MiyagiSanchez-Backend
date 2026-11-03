/**
 * Internal service route — read/write the Envía comp-grant on a Medusa
 * seller's own metadata (shipping-provider-expansion · Sprint 2:
 * `seller.metadata.envia_grant`). Lives on the Medusa seller — NOT the
 * Supabase `marketplace_shops` mirror — because the money-path routes that
 * must enforce it (quote + label seams) only ever resolve the seller
 * directly via SellerModuleService, with no Supabase access. Callers
 * without a Medusa seller row on hand (the FE admin surface, the legacy
 * Supabase-order ship route) reach it here instead of writing/reading
 * Medusa's DB directly.
 *
 *   GET  /internal/sellers/:id/grant             → { grant: CompGrant | null }
 *   POST /internal/sellers/:id/grant  { action: 'grant'|'revoke', note? }
 *        → { grant: CompGrant | null }
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET (same pattern as
 * the sibling /internal/sellers and /internal/sellers/:id/claim routes).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

type CompGrant = { type: 'comp'; granted_at: string; note?: string }

function buildCompGrant(note?: string): CompGrant {
  return { type: 'comp', granted_at: new Date().toISOString(), ...(note ? { note } : {}) }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const grant = ((seller.metadata ?? {}) as Record<string, unknown>).envia_grant ?? null
  res.json({ grant })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { id } = req.params
  const body = req.body as { action?: unknown; note?: unknown }
  if (body.action !== 'grant' && body.action !== 'revoke') {
    return res.status(400).json({ message: 'action must be "grant" or "revoke"' })
  }
  const note = typeof body.note === 'string' ? body.note : undefined

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ id } as never, { take: 1 })
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  // Read-modify-write the whole metadata blob (established pattern — see
  // apps/storefront app/api/admin/tenants/[id]/route.ts for the sibling
  // Supabase-side precedent this mirrors).
  const metadata: Record<string, unknown> = { ...(seller.metadata ?? {}) }
  if (body.action === 'grant') {
    metadata.envia_grant = buildCompGrant(note)
  } else {
    delete metadata.envia_grant
  }

  const updated = await sellerService.updateSellers({ id, metadata })
  const updatedOne = Array.isArray(updated) ? updated[0] : updated
  res.json({ grant: ((updatedOne?.metadata ?? {}) as Record<string, unknown>).envia_grant ?? null })
}
