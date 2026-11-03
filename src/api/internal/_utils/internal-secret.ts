import { timingSafeEqual } from 'node:crypto'

/**
 * The internal service door: does the `x-internal-secret` header match `MEDUSA_INTERNAL_SECRET`?
 *
 * Constant-time (a plain `!==` leaks how many leading characters matched), and closed when the secret is unset or
 * the header is missing, repeated or not a string — an unconfigured server must refuse, never accept an empty match.
 */
export function internalSecretMatches(expected: string | undefined, got: unknown): boolean {
  if (!expected || typeof got !== 'string' || !got) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
