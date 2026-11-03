import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * The Stripe Connect return URL must point at a route that EXISTS.
 *
 * It pointed at `/sell/pagos`, which is not a route in the storefront: payment
 * settings live under `/shop/manage/settings/`, and `/sell/*` is the listing wizard.
 * A seller who completed Connect onboarding was handed straight to a 404 — at the end
 * of the flow that decides whether they can take money at all. The `refresh_url` case
 * is worse, because that is where Stripe sends someone whose link already expired.
 *
 * Nothing failed loudly. The account was created, the link was valid, Stripe did
 * exactly as asked. Only the destination was wrong.
 *
 * ── Why this spec is shaped like this ────────────────────────────────────────
 * The two halves live in DIFFERENT REPOSITORIES. `apps/storefront` is its own git
 * repo, gitignored from this one, so in CI this repo is checked out alone and the
 * storefront tree is simply not there.
 *
 * THREE STATES, never two. A spec that silently skipped when the sibling is missing
 * would be green having checked nothing — worse than no spec, because it reads as a
 * passing gate (AGENTS.md rule 5). So:
 *
 *   · sibling PRESENT  → resolve the path against the real `app/` route tree;
 *   · sibling ABSENT   → say so out loud, and still assert everything checkable in
 *                        isolation (the namespace, and that the literal has not
 *                        regressed to the known-bad value).
 */

const STOREFRONT_APP = join(process.cwd(), '..', 'miyagisanchez', 'app')
const ROUTE_SOURCE = join(process.cwd(), 'src/api/store/sellers/me/stripe-connect/route.ts')

const source = readFileSync(ROUTE_SOURCE, 'utf8')

/** The single constant both Stripe URLs are built from. */
function connectReturnPath(): string {
  const match = source.match(/const CONNECT_RETURN_PATH = '([^']+)'/)
  if (!match) throw new Error('CONNECT_RETURN_PATH not found — the seam this spec guards was renamed or removed')
  return match[1]
}

/**
 * Does `app/` serve this URL path?
 *
 * Walks the route tree segment by segment, allowing Next's route groups (`(shell)`,
 * which do not appear in the URL) and dynamic segments (`[section]`). Returns false
 * only when no directory chain can produce the path.
 */
function routeExists(appDir: string, urlPath: string): boolean {
  const segments = urlPath.split('/').filter(Boolean)

  const walk = (dir: string, remaining: string[]): boolean => {
    if (!existsSync(dir)) return false
    if (remaining.length === 0) {
      // A leaf is only a page if something renders it.
      if (['page.tsx', 'page.ts', 'page.jsx', 'page.js'].some((f) => existsSync(join(dir, f)))) return true
      // …or a route group directly beneath it does.
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('('))
        .some((e) => walk(join(dir, e.name), []))
    }

    const [head, ...tail] = remaining
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())

    // Exact match first, then a dynamic segment, then transparently through any
    // route group — the same precedence Next itself uses.
    if (entries.some((e) => e.name === head) && walk(join(dir, head), tail)) return true
    if (entries.some((e) => e.name.startsWith('[')) &&
        entries.filter((e) => e.name.startsWith('[')).some((e) => walk(join(dir, e.name), tail))) return true
    return entries.filter((e) => e.name.startsWith('(')).some((e) => walk(join(dir, e.name), remaining))
  }

  return walk(appDir, segments)
}

describe('Stripe Connect onboarding return URL', () => {
  const path = connectReturnPath()

  it('is built from ONE constant, used by both Stripe URLs', () => {
    // refresh_url and return_url drifting apart is its own bug: the expired-link path
    // is the one a struggling seller hits, and it is the one nobody tests by hand.
    expect(source).toMatch(/refresh_url: `\$\{SITE_URL\}\$\{CONNECT_RETURN_PATH\}`/)
    expect(source).toMatch(/return_url: `\$\{SITE_URL\}\$\{CONNECT_RETURN_PATH\}`/)
  })

  it('has not regressed to the known-bad /sell/pagos', () => {
    // Checkable with or without the storefront. `/sell/*` is the LISTING WIZARD
    // namespace; seller settings have never lived there.
    expect(path).not.toBe('/sell/pagos')
    expect({ path, inWizardNamespace: path.startsWith('/sell/') })
      .toEqual({ path, inWizardNamespace: false })
    expect(path.startsWith('/')).toBe(true)
  })

  if (existsSync(STOREFRONT_APP)) {
    it('resolves to a real route in the storefront app tree', () => {
      expect({ path, exists: routeExists(STOREFRONT_APP, path) }).toEqual({ path, exists: true })
    })

    it('the resolver is not vacuous — it rejects the path that was actually broken', () => {
      // A resolver that returns true for everything would make the test above
      // meaningless. Pin it against the real bug and an obvious non-route.
      expect(routeExists(STOREFRONT_APP, '/sell/pagos')).toBe(false)
      expect(routeExists(STOREFRONT_APP, '/definitely/not/a/route')).toBe(false)
      // …and it must still find pages behind a route group and a dynamic segment,
      // or it would reject correct paths — the failure mode that gets guards deleted.
      expect(routeExists(STOREFRONT_APP, '/sell')).toBe(true)
    })
  } else {
    it('UNAVAILABLE: the storefront repo is not checked out beside this one', () => {
      // Deliberately a passing test that PRINTS the gap rather than a silent skip.
      // "I could not check" and "there is nothing to check" are different facts, and
      // collapsing them is how a gate quietly stops gating (AGENTS.md rule 5).
      console.warn(
        `[stripe-onboarding-return-url] storefront app tree not found at ${STOREFRONT_APP} — ` +
          `cannot verify that "${path}" resolves to a real route. The namespace assertions above still ran.`,
      )
      expect(existsSync(STOREFRONT_APP)).toBe(false)
    })
  }
})
