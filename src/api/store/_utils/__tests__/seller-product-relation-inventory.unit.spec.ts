import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const API_ROOT = path.resolve(__dirname, '../../..')
const CENTRAL_HELPER = path.resolve(__dirname, '../seller-catalog-query.ts')

const EXPECTED_MIGRATED_CALL_COUNTS: Record<string, number> = {
  'admin/sellers/route.ts': 1,
  'internal/events-ticketing/redeem/route.ts': 1,
  'internal/ml/publish/route.ts': 1,
  'store/_utils/profit-apply-price.ts': 1,
  // Two identical metadata queries were consolidated into one typed read.
  'store/_utils/support-product-ensure.ts': 1,
  'store/_utils/support-seller-resolution.ts': 1,
  'store/envia/rates/route.ts': 1,
  'store/home/personalization/route.ts': 1,
  'store/listings/[id]/route.ts': 1,
  'store/listings/route.ts': 1,
  'store/sellers/[slug]/products/route.ts': 1,
  'store/sellers/me/orders/[id]/confirm-payment/route.ts': 1,
  'store/sellers/me/orders/[id]/pickup-appointment/route.ts': 1,
  'store/sellers/me/orders/[id]/proof/route.ts': 1,
  'store/sellers/me/orders/[id]/release-escrow/route.ts': 1,
  'store/sellers/me/orders/[id]/return-request/route.ts': 1,
  'store/sellers/me/orders/[id]/route.ts': 2,
  'store/sellers/me/orders/[id]/ship/route.ts': 1,
  'store/sellers/me/orders/[id]/tags/route.ts': 1,
  'store/sellers/me/orders/bulk-status/route.ts': 1,
  'store/sellers/me/orders/route.ts': 1,
}

const ORDER_OWNERSHIP_CALL_COUNTS: Record<string, number> = {
  'store/sellers/me/orders/route.ts': 1,
  'store/sellers/me/orders/[id]/route.ts': 2,
  'store/sellers/me/orders/[id]/confirm-payment/route.ts': 1,
  'store/sellers/me/orders/[id]/pickup-appointment/route.ts': 1,
  'store/sellers/me/orders/[id]/proof/route.ts': 1,
  'store/sellers/me/orders/[id]/release-escrow/route.ts': 1,
  'store/sellers/me/orders/[id]/return-request/route.ts': 1,
  'store/sellers/me/orders/[id]/ship/route.ts': 1,
  'store/sellers/me/orders/[id]/tags/route.ts': 1,
  'store/sellers/me/orders/bulk-status/route.ts': 1,
}

/**
 * Files that used to pass `{ includeDeleted: true }`. Every one of them must now pass
 * ZERO — see below for why the option is gone.
 */
const FORMERLY_DELETED_INCLUSIVE: string[] = [
  ...Object.keys(ORDER_OWNERSHIP_CALL_COUNTS),
  'internal/events-ticketing/redeem/route.ts',
]

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(absolute)
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : []
  })
}

function relative(file: string): string {
  return path.relative(API_ROOT, file).split(path.sep).join('/')
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function directSellerProductFields(file: string): Array<{ field: string; line: number }> {
  const source = parse(file)
  const findings: Array<{ field: string; line: number }> = []

  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && node.text.startsWith('products.')) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      findings.push({ field: node.text, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings
}

function importedBindings(source: ts.SourceFile, exportedNames: Set<string>): Set<string> {
  const bindings = new Set<string>()

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.endsWith('seller-catalog-query')
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue
    }

    for (const element of statement.importClause.namedBindings.elements) {
      const exportedName = element.propertyName?.text ?? element.name.text
      if (exportedNames.has(exportedName)) bindings.add(element.name.text)
    }
  }

  return bindings
}

function includeDeletedResolverCallCount(file: string): number {
  const source = parse(file)
  const resolverBindings = importedBindings(source, new Set(['resolveSellerProductIds']))
  let count = 0

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && resolverBindings.has(node.expression.text)
    ) {
      const options = node.arguments[2]
      if (
        options
        && ts.isObjectLiteralExpression(options)
        && options.properties.some((property) =>
          ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name)
          && property.name.text === 'includeDeleted'
          && property.initializer.kind === ts.SyntaxKind.TrueKeyword
        )
      ) {
        count++
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return count
}

function typedResolverCallCount(file: string): number {
  const source = parse(file)
  const resolverNames = new Set([
    'resolveSellerProductIds',
    // The slot-counting sibling is the SAME central boundary — it just also reports
    // how many linked products were soft-deleted. Omitting it here would make the
    // order list route read as an un-migrated direct query.
    'resolveSellerProductIdsWithSlots',
    'resolveSellerProductIdsFromRemoteQuery',
    'resolveSellerProductMetadataRecords',
  ])
  const resolverBindings = importedBindings(source, resolverNames)
  let count = 0

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && resolverBindings.has(node.expression.text)
    ) {
      count++
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return count
}

function allItemOwnershipCallCount(file: string): number {
  const source = parse(file)
  const ownershipBindings = importedBindings(source, new Set(['sellerOwnsEveryOrderItem']))
  let count = 0

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && ownershipBindings.has(node.expression.text)
    ) {
      count++
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return count
}

describe('seller→products null-slot inventory', () => {
  it('keeps every direct seller relation field selection behind the typed helper', () => {
    const findings = sourceFiles(API_ROOT)
      .filter((file) => file !== CENTRAL_HELPER)
      .flatMap((file) =>
        directSellerProductFields(file).map((finding) => ({
          file: relative(file),
          ...finding,
        }))
      )

    if (findings.length) {
      throw new Error(
        `Direct seller→products relation field detected:\n${JSON.stringify(findings, null, 2)}\n`
        + 'Use resolveSellerProductIds() (or its typed metadata/legacy-query sibling) '
        + 'instead of selecting products.* in a route-local seller query.',
      )
    }
  })

  it('keeps all 21 incident files on the central resolver boundary', () => {
    const actual = Object.fromEntries(
      Object.keys(EXPECTED_MIGRATED_CALL_COUNTS).map((file) => [
        file,
        typedResolverCallCount(path.join(API_ROOT, file)),
      ]),
    )

    expect(actual).toEqual(EXPECTED_MIGRATED_CALL_COUNTS)
  })

  /**
   * This assertion is INVERTED from what it was, and that is the point.
   *
   * It used to pin `{ includeDeleted: true }` onto these 12 files as a feature. That
   * option built `context: { products: QueryContext({}) }`, which Medusa rejects with
   * `Trying to query by not existing property Product.context` — so every one of these
   * routes threw on every request. The seller order list swallowed it and reported "no
   * orders"; the detail routes and ticket redeem had no catch and 500'd. This guard
   * held the broken shape in place for months by asserting it was there.
   *
   * It now guards the opposite: the option is gone and must not return. Not scoped to
   * the 12 known files — the WHOLE api tree, so a new route cannot reintroduce it.
   */
  it('the includeDeleted option is gone from every route, and cannot come back', () => {
    const stillPassing = FORMERLY_DELETED_INCLUSIVE
      .map((file) => [file, includeDeletedResolverCallCount(path.join(API_ROOT, file))] as const)
      .filter(([, count]) => count > 0)
    expect(stillPassing).toEqual([])

    const anywhere = sourceFiles(API_ROOT)
      .map((file) => [relative(file), includeDeletedResolverCallCount(file)] as const)
      .filter(([, count]) => count > 0)
    expect(anywhere).toEqual([])
  })

  it('keeps every order-level seam on the fail-closed all-item ownership predicate', () => {
    const actual = Object.fromEntries(
      Object.keys(ORDER_OWNERSHIP_CALL_COUNTS).map((file) => [
        file,
        allItemOwnershipCallCount(path.join(API_ROOT, file)),
      ]),
    )

    expect(actual).toEqual(ORDER_OWNERSHIP_CALL_COUNTS)
  })
})
