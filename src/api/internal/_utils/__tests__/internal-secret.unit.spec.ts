import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { internalSecretMatches } from '../internal-secret'

/**
 * business-infrastructure D12 — the internal ledger read for the monthly check-in.
 * Pure: the secret check, and source-level facts about the two routes that share one ledger read.
 */

describe('internalSecretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(internalSecretMatches('s3cret-value', 's3cret-value')).toBe(true)
    expect(internalSecretMatches('s3cret-value', 's3cret-valuX')).toBe(false)
    expect(internalSecretMatches('s3cret-value', 's3cret')).toBe(false)
  })

  it('is CLOSED when the server has no secret, or the header is missing, empty, repeated or not a string', () => {
    expect(internalSecretMatches(undefined, 'anything')).toBe(false)
    expect(internalSecretMatches('', '')).toBe(false)
    expect(internalSecretMatches('s', undefined)).toBe(false)
    expect(internalSecretMatches('s', '')).toBe(false)
    expect(internalSecretMatches('s', ['s', 's'])).toBe(false)
  })
})

describe('the ledger read is ONE function for both doors', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8')

  it('the seller route and the internal route both answer with readSellerLedger', () => {
    expect(read('store/sellers/me/profit/route.ts')).toContain('res.json(await readSellerLedger(req.scope, sellerAuth.sellerId))')
    expect(read('internal/profit/ledger/route.ts')).toContain('res.json(await readSellerLedger(req.scope, seller.id))')
  })

  it('the internal route checks the flag, then the secret, then that the seller exists — before any read', () => {
    const src = read('internal/profit/ledger/route.ts')
    const flag = src.indexOf("isEnabled('ops.profit_enabled')")
    const secret = src.indexOf('internalSecretMatches(')
    const seller = src.indexOf('listSellers(')
    const ledger = src.indexOf('readSellerLedger(req.scope')
    expect(flag).toBeGreaterThan(-1)
    expect(flag).toBeLessThan(secret)
    expect(secret).toBeLessThan(seller)
    expect(seller).toBeLessThan(ledger)
  })
})
