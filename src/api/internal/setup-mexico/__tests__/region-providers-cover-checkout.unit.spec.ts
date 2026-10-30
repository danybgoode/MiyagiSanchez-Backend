import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every payment provider checkout opens a session on must be enabled in the Mexico
 * region, or Medusa's `completeCartWorkflow` (validate-cart-payments) refuses to turn
 * the paid cart into an order.
 *
 * Why a source scan: `start-checkout` moved manual payments to `pp_manual_manual` on
 * 2026-06-01 and nobody added it to `MX_PAYMENT_PROVIDERS` — the two lists live in
 * different files and only production noticed (2026-10-30). This derives the
 * population from the checkout's own `providerId = '…'` assignments, so a new provider
 * there reddens here until the region list carries it.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

function regionProviders(): Set<string> {
  const src = read('src/api/internal/setup-mexico/route.ts')
  const block = src.match(/const MX_PAYMENT_PROVIDERS = \[([\s\S]*?)\]/)
  if (!block) throw new Error('MX_PAYMENT_PROVIDERS not found — the guard cannot see the list it guards')
  return new Set([...block[1].matchAll(/'(pp_[^']+)'/g)].map((m) => m[1]))
}

function checkoutProviders(): string[] {
  const src = read('src/api/store/carts/[id]/start-checkout/route.ts')
  const ids = [...src.matchAll(/providerId = '(pp_[^']+)'/g)].map((m) => m[1])
  if (ids.length === 0) throw new Error('no providerId assignments found in start-checkout — the scan is blind')
  return [...new Set(ids)]
}

describe('Mexico region enables every provider checkout uses', () => {
  it('finds the checkout providers it is guarding (the scan is not blind)', () => {
    expect(checkoutProviders()).toEqual(expect.arrayContaining(['pp_manual_manual', 'pp_stripe-connect_stripe-connect', 'pp_mercadopago_mercadopago']))
  })

  it('every start-checkout provider is in MX_PAYMENT_PROVIDERS', () => {
    const region = regionProviders()
    expect(checkoutProviders().filter((id) => !region.has(id))).toEqual([])
  })

  it('the counter cash provider is in MX_PAYMENT_PROVIDERS (in-person-sales D5)', () => {
    expect(regionProviders().has('pp_cash_cash')).toBe(true)
  })
})
