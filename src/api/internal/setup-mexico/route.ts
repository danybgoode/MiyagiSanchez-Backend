/**
 * POST /internal/setup-mexico
 *
 * Idempotent one-time configuration to make this a Mexico-native Medusa instance:
 *   1. Add MXN to the store's supported currencies (set as default)
 *   2. Create a "Mexico" region with currency MXN + country mx
 *   3. Create a Mexico tax region
 *   4. Rename the seeded "European Warehouse" stock location → "México"
 *   5. Update store name
 *   6. Delete the leftover seeded "Europe" region (pricing-money-path-remediation
 *      Finding F) — Medusa's starter template ships an EUR region by default;
 *      step 2 above ADDS Mexico alongside it but never removed the original.
 *      This surfaced live 2026-07-13 as an extra, irrelevant pricing column in
 *      Admin's price editor for every product platform-wide (Mexico-only
 *      marketplace). Confirmed safe before deleting: a live sweep of all 76
 *      real store products found zero EUR-currency price rows anywhere, and a
 *      repo-wide grep found no code keying off the Europe region id — this
 *      step re-verifies the price-safety check itself (not just trusting that
 *      one-time audit) before ever calling the delete workflow, so a future
 *      re-run on a database that somehow DOES have a real EUR price refuses
 *      instead of silently deleting live pricing data. Since 2026-07-28 it is
 *      additionally scoped by the market registry (D6): a region that any
 *      supported market resolves to — by id or by currency — is never deletable,
 *      so standing up a second market cannot be undone by re-running this route.
 *
 * Run once after deploy. Safe to re-run — each step checks before acting.
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  createRegionsWorkflow,
  updateRegionsWorkflow,
  createTaxRegionsWorkflow,
  deleteRegionsWorkflow,
} from '@medusajs/medusa/core-flows'
import { describeRegionKeep, planRegionDeletions } from '../_utils/market-protected-resources'
import { MX_PAYMENT_PROVIDERS } from '../../../lib/mx-payment-providers'

// All payment providers that should be enabled on the Mexico region. Keeping
// pp_system_default for backward-compat with any legacy sessions.

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const report: string[] = []

  // ── 1. Store: add MXN + set as default ───────────────────────────────────
  const storeService: any = req.scope.resolve(Modules.STORE)
  const [store] = await storeService.listStores({}, { select: ['id', 'supported_currencies'], take: 1 })

  if (!store) {
    return res.status(500).json({ message: 'No store found — seed first' })
  }

  const currencies: Array<{ currency_code: string; is_default?: boolean }> =
    store.supported_currencies ?? []
  const mxnEntry = currencies.find(c => c.currency_code === 'mxn')

  if (!mxnEntry) {
    await storeService.updateStores(store.id, {
      supported_currencies: [
        ...currencies.map(c => ({ ...c, is_default: false })),
        { currency_code: 'mxn', is_default: true },
      ],
    })
    report.push('✓ Added MXN to store currencies (default)')
  } else if (!mxnEntry.is_default) {
    await storeService.updateStores(store.id, {
      supported_currencies: currencies.map(c => ({
        ...c,
        is_default: c.currency_code === 'mxn',
      })),
    })
    report.push('✓ Set MXN as default store currency')
  } else {
    report.push('○ MXN already default — skipped')
  }

  // ── 2. Region: create Mexico / MXN ──────────────────────────────────────
  const regionService: any = req.scope.resolve(Modules.REGION)
  const regions = await regionService.listRegions({})
  const mexicoRegion = regions.find(
    (r: any) => r.name === 'Mexico' || r.currency_code === 'mxn'
  )

  if (!mexicoRegion) {
    await createRegionsWorkflow(req.scope).run({
      input: {
        regions: [{
          name: 'Mexico',
          currency_code: 'mxn',
          countries: ['mx'],
          payment_providers: MX_PAYMENT_PROVIDERS,
        }],
      },
    })
    report.push(`✓ Created Mexico region (MXN, country: mx) with providers: ${MX_PAYMENT_PROVIDERS.join(', ')}`)
  } else {
    // Idempotently ensure ALL providers are enabled on the existing region —
    // prod was created with only pp_system_default, so this is the migration
    // path that turns Stripe/MP/SPEI/Cash into first-class region providers.
    await updateRegionsWorkflow(req.scope).run({
      input: {
        selector: { id: mexicoRegion.id },
        update: { payment_providers: MX_PAYMENT_PROVIDERS },
      },
    })
    report.push(`✓ Mexico region (${mexicoRegion.id}) providers ensured: ${MX_PAYMENT_PROVIDERS.join(', ')}`)
  }

  // ── 3. Tax region: mx ────────────────────────────────────────────────────
  const taxService: any = req.scope.resolve(Modules.TAX)
  const taxRegions = await taxService.listTaxRegions({ country_code: 'mx' })

  if (!taxRegions.length) {
    await createTaxRegionsWorkflow(req.scope).run({
      input: [{ country_code: 'mx', provider_id: 'tp_system' }],
    })
    report.push('✓ Created Mexico tax region')
  } else {
    report.push('○ Mexico tax region already exists — skipped')
  }

  // ── 4. Stock location: rename to México ───────────────────────────────────
  const stockLocationService: any = req.scope.resolve(Modules.STOCK_LOCATION)
  const [location] = await stockLocationService.listStockLocations(
    {},
    { select: ['id', 'name'], take: 1, order: { created_at: 'ASC' } }
  )

  if (!location) {
    report.push('○ No stock location found — run inventory backfill first')
  } else if (location.name !== 'México') {
    await stockLocationService.updateStockLocations(location.id, {
      name: 'México',
      address: {
        city: 'Ciudad de México',
        country_code: 'mx',
        address_1: '',
      },
    })
    report.push(`✓ Renamed stock location "${location.name}" → "México"`)
  } else {
    report.push('○ Stock location already "México" — skipped')
  }

  // ── 5. Update store name ──────────────────────────────────────────────────
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: storeData } = await query.graph({
    entity: 'store',
    fields: ['id', 'name'],
  })
  const storeRecord = storeData?.[0] as any
  if (storeRecord?.name === 'Default Store') {
    await storeService.updateStores(storeRecord.id, { name: 'Miyagi Sánchez' })
    report.push('✓ Renamed store "Default Store" → "Miyagi Sánchez"')
  } else {
    report.push(`○ Store name "${storeRecord?.name}" — not changed`)
  }

  // ── 6. Delete the leftover seeded "Europe" region ────────────────────────
  //
  // SCOPED TO THE REGISTRY (epic market-architecture-foundation, D6): this step used
  // to be "delete every region that is not Mexico", which is only correct while
  // exactly one market exists. `planRegionDeletions` now protects the Mexico region,
  // every region a registry market resolves to, and every region whose currency
  // belongs to a registry market — before the pre-existing price-safety re-check.
  // `eur` is in no registry market, so the seeded Europe region this step exists to
  // remove is still removed; nothing about today's live behaviour changes.
  //
  // Safety re-check (unchanged): never delete a region if ANY product variant
  // carries a real price in that region's currency — that would mean real pricing
  // data depends on it, not just leftover seed scaffolding. Fetch every product's
  // variant prices and filter in plain JS rather than a nested remote-query filter
  // (no precedent for that shape anywhere in this codebase — a flat fetch is the
  // same approach already verified live against all 76 real products before writing
  // this route).
  const { data: allProducts } = await query.graph({
    entity: 'product',
    fields: ['id', 'variants.prices.currency_code'],
  })
  const currenciesInUse = new Set<string>()
  for (const p of (allProducts ?? []) as any[]) {
    for (const v of p.variants ?? []) {
      for (const pr of v.prices ?? []) {
        if (pr?.currency_code) currenciesInUse.add(String(pr.currency_code).toLowerCase())
      }
    }
  }

  const regionPlan = planRegionDeletions(regions as any[], {
    mexicoRegionId: mexicoRegion?.id ?? null,
    env: process.env,
    currenciesInUse,
  })
  // Report every KEPT non-Mexico region and why. A guard that silently protects
  // something is a guard nobody can audit — and this route's whole job is to be
  // re-runnable against an unfamiliar database.
  for (const kept of regionPlan.keep) {
    if (kept.reason === 'mexico_region') continue
    report.push(describeRegionKeep(kept))
  }
  if (!regionPlan.remove.length) {
    report.push('○ No deletable non-Mexico regions found — skipped')
  } else {
    for (const stale of regionPlan.remove) {
      await deleteRegionsWorkflow(req.scope).run({ input: { ids: [stale.id] } })
      report.push(`✓ Deleted stale region "${stale.name}" (${stale.id}, ${stale.currency_code}) — no registry market and no real pricing depended on it`)
    }
  }

  return res.json({ ok: true, report })
}
