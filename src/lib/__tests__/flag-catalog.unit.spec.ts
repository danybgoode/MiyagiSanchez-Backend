import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  BACKEND_FLAG_CATALOG,
  BACKEND_FLAG_DEFAULTS,
  BACKEND_FLAG_KEYS,
  validateBackendFlagCallsiteInventory,
  type FlagCallsite,
} from '../flag-catalog'

const SOURCE_ROOT = path.resolve(__dirname, '../..')

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(absolute)
    }
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [absolute] : []
  })
}

function slashRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/')
}

function deriveFlagCallsites(): FlagCallsite[] {
  const unique = new Map<string, FlagCallsite>()

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const flagBindings = new Set<string>()
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.endsWith('/flags') ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      )
        continue

      for (const element of statement.importClause.namedBindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'isEnabled') {
          flagBindings.add(element.name.text)
        }
      }
    }

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        flagBindings.has(node.expression.text)
      ) {
        const argument = node.arguments[0]
        const key =
          argument && ts.isStringLiteralLike(argument)
            ? argument.text
            : '<non-literal-flag-key>'
        const owner = slashRelative(file)
        unique.set(`${key}\u0000${owner}`, { key, owner })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return [...unique.values()].sort((left, right) =>
    `${left.key}:${left.owner}`.localeCompare(`${right.key}:${right.owner}`),
  )
}

describe('Medusa flag inventory', () => {
  it('pins the complete typed catalog and its compile-time defaults', () => {
    expect(BACKEND_FLAG_CATALOG).toHaveLength(13)
    expect(new Set(BACKEND_FLAG_KEYS).size).toBe(13)
    expect(Object.keys(BACKEND_FLAG_DEFAULTS).sort()).toEqual(
      [...BACKEND_FLAG_KEYS].sort(),
    )
    expect(
      BACKEND_FLAG_CATALOG.filter((entry) => entry.criticality === 'high'),
    ).toHaveLength(11)
    expect(
      BACKEND_FLAG_CATALOG.filter((entry) => entry.criticality === 'medium').map(
        (entry) => entry.key,
      ),
    ).toEqual(['ops.profit_enabled'])
    expect(
      BACKEND_FLAG_CATALOG.filter((entry) => entry.criticality === 'low').map(
        (entry) => entry.key,
      ),
    ).toEqual(['ml.sync_paywall_enabled'])
  })

  it('matches every real isEnabled callsite to its classified owning seam', () => {
    const callsites = deriveFlagCallsites()
    // owned-shop-operating-channel epic, S3: +2 new callsites on
    // catalog.owned_shop_only_enabled — seller-product-create.ts (S3.1's null
    // acceptance) and seller-product-update.ts (S3.2's publish/unpublish, both
    // directions) — both registered in flag-catalog.ts's owners array above.
    // business-infrastructure D12: +1 on ops.profit_enabled — the internal ledger read for the monthly check-in
    // (src/api/internal/profit/ledger/route.ts), registered in the same owners array.
    // checkout-trust-hardening: +1 on shipping.correos_enabled — start-checkout re-derives the delivery
    // methods the buyer was offered (lib/fulfillment-method-guard.ts), registered in the owners array.
    expect(callsites).toHaveLength(37)
    const validation = validateBackendFlagCallsiteInventory(callsites)
    expect(validation).toEqual({ ok: true })
  })

  it('fails closed on duplicate, unknown, missing, or stale owner inventory', () => {
    const actual = deriveFlagCallsites()
    const duplicate = validateBackendFlagCallsiteInventory([actual[0], ...actual])
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.errors.join('\n')).toContain('duplicate callsite')

    const unknown = validateBackendFlagCallsiteInventory([
      ...actual,
      { key: 'not.registered', owner: 'src/unknown.ts' },
    ])
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.errors.join('\n')).toContain('unknown flag callsite')

    const missing = validateBackendFlagCallsiteInventory(actual.slice(1))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.errors.join('\n')).toContain('missing callsite')

    const stale = validateBackendFlagCallsiteInventory([
      ...actual.slice(1),
      { ...actual[0], owner: 'src/stale-owner.ts' },
    ])
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.errors.join('\n')).toContain('unregistered owner')
      expect(stale.errors.join('\n')).toContain('missing callsite')
    }
  })
})
