/**
 * POST /internal/mx-region-payment-providers
 *
 * The NARROW live repair for the Mexico region's payment providers: it touches the
 * region↔provider links of the one MX region and nothing else.
 *
 * Why not just re-run `POST /internal/setup-mexico`: that route also writes store
 * currencies and the store name to whichever Store row `listStores({take:1})` returns
 * first, and production has two Store rows (backend #142) — row order is never a
 * selector. It also renames the oldest stock location. A provider fix must not risk
 * any of that (verifier, PR #217).
 *
 * The region is the one the MX market registry names (MEDUSA_MXN_REGION_ID), never
 * "the region whose currency is mxn". The update only ADDS: if the live region enables
 * a provider the list does not name, the route refuses rather than remove it, because
 * `updateRegionsWorkflow` REPLACES the set (set-regions-payment-providers dismisses
 * every link not in its input).
 *
 * Auth: x-internal-secret, fail-closed. Body: { dry_run?: boolean }.
 */
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { updateRegionsWorkflow } from '@medusajs/medusa/core-flows'
import { internalSecretOk } from '../../../lib/internal-auth'
import { resolveRegionIdForMarket } from '../../../lib/market-medusa'
import { MX_PAYMENT_PROVIDERS } from '../../../lib/mx-payment-providers'

async function regionProviderIds(req: MedusaRequest, regionId: string): Promise<string[]> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'region', fields: ['id', 'payment_providers.id'], filters: { id: regionId } })
  return (((data?.[0] as any)?.payment_providers ?? []) as Array<{ id: string }>).map((p) => p.id).sort()
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) return res.status(401).json({ message: 'Unauthorized' })
  const dryRun = (req.body as { dry_run?: unknown } | undefined)?.dry_run === true

  const regionId = resolveRegionIdForMarket('mx', process.env)
  if (!regionId) return res.status(503).json({ code: 'MX_REGION_UNCONFIGURED', message: 'MEDUSA_MXN_REGION_ID is not set' })

  const before = await regionProviderIds(req, regionId)
  const target = [...MX_PAYMENT_PROVIDERS]
  const wouldRemove = before.filter((id) => !target.includes(id))
  if (wouldRemove.length) {
    return res.status(409).json({
      code: 'WOULD_REMOVE_PROVIDERS',
      message: 'The live region enables providers the list does not name; refusing to remove them.',
      region_id: regionId, before, would_remove: wouldRemove,
    })
  }
  const toAdd = target.filter((id) => !before.includes(id))
  if (!toAdd.length || dryRun) {
    return res.json({ region_id: regionId, dry_run: dryRun, before, to_add: toAdd, after: before })
  }

  await updateRegionsWorkflow(req.scope).run({
    input: { selector: { id: regionId }, update: { payment_providers: target } },
  })
  const after = await regionProviderIds(req, regionId)
  // Read back: report a write that did not land as the failure it is.
  const missing = target.filter((id) => !after.includes(id))
  if (missing.length) {
    return res.status(500).json({ code: 'WRITE_NOT_OBSERVED', region_id: regionId, before, after, missing })
  }
  return res.json({ region_id: regionId, dry_run: false, before, to_add: toAdd, after })
}
