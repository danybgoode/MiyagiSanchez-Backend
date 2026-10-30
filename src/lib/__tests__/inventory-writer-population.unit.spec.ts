import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(process.cwd(), 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('inventory-writer population is closed over market admission', () => {
  const users = sources(ROOT)
    .filter((file) => {
      const source = readFileSync(file, 'utf8')
      return source.includes('resolveStockLocationId')
        && /from ['"][^'"]*inventory['"]/.test(source)
        && !file.endsWith('/inventory.ts')
    })
    .map((file) => relative(process.cwd(), file))
    .sort()

  it('forces review when a new market-sensitive inventory writer appears', () => {
    expect(users).toEqual([
      'src/api/internal/backfill-inventory/route.ts',
      'src/api/store/_utils/seller-product-create.ts',
      'src/api/store/_utils/seller-product-update.ts',
      'src/lib/in-person-sale-oversold.ts',
      'src/lib/ml-fulfillment-apply.ts',
      'src/lib/ml-order-cancel-apply.ts',
      'src/lib/ml-sync-apply.ts',
    ])
  })

  it('keeps legacy ML writers behind a server-resolved MX seller assertion', () => {
    for (const file of users.filter((name) => name.includes('/ml-'))) {
      expect(readFileSync(join(process.cwd(), file), 'utf8')).toMatch(/isMxSeller\(/)
    }
  })

  it('keeps the counter oversell writer MX-only: it is reached only after the seller is proved MX', () => {
    // in-person-sales D1/D12: recordInPersonSale refuses a non-MX seller before any claim,
    // and the oversell fallback is called only from inside it.
    const apply = readFileSync(join(process.cwd(), 'src/lib/in-person-sale-apply.ts'), 'utf8')
    expect(apply).toMatch(/readSellerOperatingMarket\(seller\)\.market !== 'mx'/)
    expect(apply).toMatch(/IN_PERSON_MX_ONLY/)
    const oversold = readFileSync(join(process.cwd(), 'src/lib/in-person-sale-oversold.ts'), 'utf8')
    expect(oversold).toMatch(/resolveStockLocationId\(scope, 'mx'\)/)
  })

  it('keeps the repair backfill ownership-scoped with no Store-default fallback', () => {
    const source = readFileSync(join(process.cwd(), 'src/api/internal/backfill-inventory/route.ts'), 'utf8')
    expect(source).toMatch(/ownerMarket/)
    expect(source).toMatch(/resolveStockLocationId\(req\.scope, market\)/)
    expect(source).not.toMatch(/default_sales_channel_id/)
  })
})
