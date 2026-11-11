/**
 * Read-only Supabase client for GCP-hosted personalization reads.
 *
 * Boundary note (AGENTS rule #2): Supabase owns the non-commerce marketplace data
 * (favorites / offers / conversations) and the FRONTEND owns almost all WRITES to it.
 * This client READS that data (the marketplace-static-shell epic moved the homepage's
 * personalization read onto Cloud Run) and makes exactly these writes, all with the
 * frontend's service-role key:
 *   - one flag-serving resilience RPC;
 *   - start-checkout's offer reservation (lib/offer-checkout.ts): a conditional update of
 *     `marketplace_offers.checkout_reserved_at` to claim, release or keep an accepted offer.
 * It never writes an offer's status or amount. Supabase stays the source of truth.
 *
 * Lazy singleton + missing-config stub mirror the frontend `lib/supabase.ts`, so a
 * build/runtime without the env vars degrades to "no rows" instead of crashing.
 *
 * `realtime.transport` stub: `createClient()` unconditionally constructs a
 * `RealtimeClient` (a `SupabaseClient` constructor side effect with no opt-out),
 * which looks up a native `WebSocket` global if no `transport` is given —
 * absent on this Dockerfile's `node:20-slim` (native WebSocket landed in
 * Node 22), so every call THROWS at client-construction time, caught by the
 * lazy singleton's caller-side try/catch as "no rows" everywhere this client
 * is used — including `src/lib/flags.ts`'s `platform_flags` read, which
 * silently fell back to `DEFAULT_FLAGS` on every single request regardless
 * of the live DB value (found live via the catalog-management epic's Sprint
 * 3 smoke test — `catalog.bulk_enabled` stayed 423 even confirmed `true` in
 * Supabase). This client never calls `.channel()`/`.subscribe()` anywhere in
 * this codebase (grepped), so the realtime socket is never actually opened —
 * a no-op transport stub satisfies the constructor's type + skips the
 * WebSocket-constructor lookup entirely, with zero loss of real capability.
 */

import { createClient, type SupabaseClient, type WebSocketLikeConstructor } from '@supabase/supabase-js'

/** Never actually connects (this client is select()-only) — exists solely
 * to satisfy `RealtimeClientOptions.transport`'s type and skip the native-
 * WebSocket lookup that throws on Node < 22. Exported so a unit test can
 * assert this guard fires — if a future change ever adds `.channel()`/
 * `.subscribe()` to this client, it should fail loudly here rather than
 * silently no-op against a socket that's never actually open. */
export class NoopWebSocketTransport {
  constructor() {
    throw new Error('NoopWebSocketTransport should never be instantiated — supabaseRead never opens a realtime channel.')
  }
}

let _db: SupabaseClient | null = null

function makeMissingConfigQuery(): unknown {
  const result = { data: null, error: { message: 'supabase not configured' } }
  const query: Record<string, unknown> = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (
      resolve: (value: typeof result) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function getSupabase(): SupabaseClient {
  if (_db) return _db
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[supabase-read] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using stub')
    _db = {
      from: () => makeMissingConfigQuery(),
      rpc: () => Promise.resolve({ data: null, error: { message: 'supabase not configured' } }),
    } as unknown as SupabaseClient
    return _db
  }
  _db = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: NoopWebSocketTransport as unknown as WebSocketLikeConstructor },
  })
  return _db
}

/** Read-only Supabase accessor (proxied so the client is built on first use). */
export const supabaseRead = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    const client = getSupabase()
    const val = (client as unknown as Record<string | symbol, unknown>)[prop]
    return typeof val === 'function' ? val.bind(client) : val
  },
})
