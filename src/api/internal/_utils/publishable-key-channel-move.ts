/**
 * publishable-key-channel-move.ts — the pure planner behind
 * `/internal/publishable-key-channel-move` (owned-shop-operating-channel epic, S2.1).
 *
 * ── WHAT IT DECIDES ────────────────────────────────────────────────────────────
 * Which publishable API key is the storefront's, and exactly which channel links to
 * dismiss and create so that the key ends up holding **exactly one** channel: the
 * market's OPERATING channel. Link rows 1 → 1, never 1 → 2 → 1, never 2.
 *
 * ── WHY EXACTLY ONE, MEASURED IN MEDUSA 2.15.3'S OWN SOURCE ────────────────────
 * The scaffolded plan said "link the key to the operating channel IN ADDITION to the
 * marketplace channel". Traced through the installed packages, that is a total
 * checkout outage:
 *
 *   1. `@medusajs/medusa/dist/api/store/carts/middlewares.js` puts
 *      `maybeAttachPublishableKeyScopes` then `ensurePublishableKeyAndSalesChannelMatch`
 *      on `POST /store/carts`.
 *   2. `@medusajs/medusa/dist/api/utils/middlewares/common/ensure-pub-key-sales-channel-match.js`
 *      — with `pubKeySalesChannels.length > 1` and no `sales_channel_id` in the body —
 *      pushes "Cannot assign sales channel to cart. The Publishable API Key in the
 *      header has multiple associated sales channels." onto `req.errors` and calls
 *      `next()`. It does NOT set `validatedBody.sales_channel_id`.
 *   3. `@medusajs/framework/dist/http/utils/wrap-handler.js` — which
 *      `@medusajs/framework/dist/http/router.js` wraps EVERY route handler in —
 *      short-circuits on `req.errors.length` with **HTTP 400**
 *      `{ errors, message: "Provided request body contains errors…" }`.
 *
 * So every cart creation from the storefront 400s. (The epic README's D3 predicted a
 * *silent* fallback to `store.default_sales_channel_id` via
 * `@medusajs/core-flows/dist/cart/steps/find-sales-channel.js`; that step does hold
 * exactly that fallback, but it is unreachable here because `wrapHandler` answers
 * first. The conclusion is unchanged and the reason is stronger: two channels on this
 * key means nobody can check out at all.)
 *
 * The storefront never sends `sales_channel_id` — there is no call site in
 * `apps/storefront` — so there is no code path that avoids step 2. A single-channel
 * key makes the failure unrepresentable rather than merely unlikely.
 *
 * ── ROLLBACK (epic README, D9) ─────────────────────────────────────────────────
 * Two link operations, not a deploy: re-run this planner with the MARKETPLACE channel
 * as the desired set, i.e. POST `{ dry_run: false, desired_channel: "marketplace" }`.
 * The key returns to exactly one link row pointing at `MEDUSA_SALES_CHANNEL_ID` and
 * the catalog is byte-identical to today's. Operating-channel product memberships are
 * left in place — they are inert the moment the key points elsewhere.
 *
 * Pure over injected rows, so every refusal is unit-testable with no container and no
 * database. The I/O shell is the route.
 */

/** One `api_key` row as `query.graph` returns it — every field defensively optional. */
export interface PublishableKeyRow {
  id?: string | null
  title?: string | null
  token?: string | null
  sales_channels?: Array<{ id?: string | null; name?: string | null } | null | undefined> | null
}

/**
 * Three states, not two — copied in spirit from `api-key-cleanup.ts` because the same
 * distinction saved that route: `unavailable` means the check could not run, and must
 * never read as "the storefront key is missing".
 */
export type StorefrontTokenCheck = 'matched' | 'not_found' | 'unavailable'

export interface KeyLinkSnapshot {
  readonly key_id: string
  readonly title: string | null
  /** Publishable tokens ship in the browser bundle, but there is no reason to echo one whole. */
  readonly token_prefix: string | null
  /** Channel ids we could read off this key's link rows. */
  readonly channel_ids: readonly string[]
  /**
   * RAW link rows carrying a readable channel id, BEFORE de-duplication.
   *
   * Distinct from `channel_ids.length` on purpose. Medusa reasons about LINK ROWS,
   * not about the set of distinct channels: `maybeAttachPublishableKeyScopes` does
   * `apiKey.sales_channels.map((sc) => sc.id)` with no de-duplication, so two rows
   * naming ONE channel still yield a length-2 array — which trips
   * `ensurePublishableKeyAndSalesChannelMatch`'s `> 1` branch and 400s every cart
   * (D3). A plan that only ever looks at the deduped set cannot see that.
   */
  readonly link_row_count: number
  /**
   * Link rows that came back with no usable id — a link to a since-deleted channel.
   * Counted separately: "this key has one link" and "this key has one link plus one
   * we cannot read" are different facts, and the second one means we cannot promise
   * an exact after-count. 70 such rows existed in production in July 2026.
   */
  readonly unusable_link_rows: number
}

export interface KeyChannelMovePlan {
  /** Null exactly when `refuse` is set and no key could be identified. */
  readonly target: KeyLinkSnapshot | null
  /** Every publishable key seen, so a reviewer can check the population, not just the pick. */
  readonly all_keys: readonly KeyLinkSnapshot[]
  readonly storefront_token_check: StorefrontTokenCheck
  /** The channel set the key must end up holding. Exactly one id, or the plan refuses. */
  readonly desired_channel_ids: readonly string[]
  /** Links to create. */
  readonly add: readonly string[]
  /** Links to dismiss. */
  readonly remove: readonly string[]
  readonly links_before: number
  /** What `add`/`remove` arithmetic says the count will be. Verified by re-reading after the apply. */
  readonly links_after_predicted: number
  /** True when the key already holds exactly the desired set — the apply is a no-op. */
  readonly already_satisfied: boolean
  /** Non-null ⇒ do not apply. Returned verbatim. */
  readonly refuse: string | null
}

const trimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

function snapshot(row: PublishableKeyRow, id: string): KeyLinkSnapshot {
  const links = Array.isArray(row.sales_channels) ? row.sales_channels : []
  const channelIds: string[] = []
  let unusable = 0
  for (const link of links) {
    const channelId = link ? trimmed(link.id) : null
    if (channelId) channelIds.push(channelId)
    else unusable += 1
  }
  const token = trimmed(row.token)
  return {
    key_id: id,
    title: trimmed(row.title),
    token_prefix: token ? token.slice(0, 12) : null,
    // Deduped for reasoning about WHICH channels the key scopes to...
    channel_ids: [...new Set(channelIds)],
    // ...but the raw count is kept, because Medusa counts ROWS. See `link_row_count`.
    // An earlier comment here claimed de-duplication was safe because "two link rows
    // naming ONE channel is still one channel's worth of scope". That rationalisation
    // was WRONG and it hid a real defect: duplicates were reported as
    // `already_satisfied` while the key would still 400 every cart. Caught by the
    // codex cross-family review on PR 130.
    link_row_count: channelIds.length,
    unusable_link_rows: unusable,
  }
}

export interface KeyChannelMoveOptions {
  /**
   * The channel set the key must hold afterwards. The route always passes exactly
   * one id (the operating channel; or the marketplace channel for a D9 rollback).
   *
   * It is an INPUT rather than a constant so the D3 cap is a real, reachable refusal
   * instead of a tautology: hand this the scaffold's original two-channel plan and
   * the planner refuses, which is the spec that proves the guard works.
   */
  readonly desiredChannelIds: readonly string[]
  /** `MEDUSA_PUBLISHABLE_KEY` — the credential the storefront actually authenticates with. */
  readonly storefrontToken?: string | null
}

/**
 * Decide the move. Every refusal below is a case where the outcome cannot be SHOWN to
 * be safe; none of them is a case where it is merely unusual.
 */
export function planPublishableKeyChannelMove(
  rows: unknown,
  opts: KeyChannelMoveOptions,
): KeyChannelMovePlan {
  const list: PublishableKeyRow[] = Array.isArray(rows) ? (rows as PublishableKeyRow[]) : []
  const storefrontToken = trimmed(opts.storefrontToken)
  const desired = [...new Set(opts.desiredChannelIds.map((id) => trimmed(id)).filter((id): id is string => !!id))]

  const snapshots: KeyLinkSnapshot[] = []
  let unusableRows = 0
  let sawAnyToken = false
  let matched: KeyLinkSnapshot | null = null

  for (const row of list) {
    const id = trimmed(row?.id)
    if (!id) {
      // A key row with no id can neither be picked nor ruled out. Count it and let
      // the refusal fire — acting on a partially-unreadable population is how the
      // "70 of 72" incident nearly deleted the live credential.
      unusableRows += 1
      continue
    }
    const snap = snapshot(row, id)
    snapshots.push(snap)
    const token = trimmed(row.token)
    if (token) sawAnyToken = true
    if (storefrontToken && token === storefrontToken) matched = snap
  }

  const tokenCheck: StorefrontTokenCheck = !storefrontToken || !sawAnyToken
    ? 'unavailable'
    : matched
      ? 'matched'
      : 'not_found'

  // ── Pick the target key ──────────────────────────────────────────────────────
  // Token match is the only POSITIVE identification. When the token check could not
  // run at all, a database holding exactly one publishable key is unambiguous by
  // arithmetic; anything else is a guess, and this route repoints the credential the
  // whole storefront authenticates with.
  const target = matched ?? (tokenCheck === 'unavailable' && snapshots.length === 1 ? snapshots[0] : null)

  const before = target ? target.channel_ids : []
  const add = desired.filter((id) => !before.includes(id))
  const remove = before.filter((id) => !desired.includes(id))
  // Set arithmetic, not an assertion: the after-count is DERIVED from add/remove so a
  // bug in either is visible here rather than only in production.
  const after = [...new Set([...before.filter((id) => !remove.includes(id)), ...add])]

  return {
    target,
    all_keys: snapshots,
    storefront_token_check: tokenCheck,
    desired_channel_ids: desired,
    add,
    remove,
    links_before: before.length,
    links_after_predicted: after.length,
    already_satisfied: !!target && add.length === 0 && remove.length === 0,
    refuse: refusalFor({ list, snapshots, unusableRows, tokenCheck, target, desired, after }),
  }
}

function refusalFor(args: {
  list: PublishableKeyRow[]
  snapshots: KeyLinkSnapshot[]
  unusableRows: number
  tokenCheck: StorefrontTokenCheck
  target: KeyLinkSnapshot | null
  desired: readonly string[]
  after: readonly string[]
}): string | null {
  const { list, snapshots, unusableRows, tokenCheck, target, desired, after } = args

  // An empty read is the classic false-green: "no keys" and "the query failed" look
  // identical downstream. Never treat it as a completed no-op.
  if (list.length === 0) {
    return 'no publishable keys were returned — refusing to act on an empty read'
  }
  if (unusableRows > 0) {
    return `${unusableRows} key row(s) came back with no id — refusing while part of the population is unreadable`
  }
  if (tokenCheck === 'not_found') {
    return 'MEDUSA_PUBLISHABLE_KEY is configured but matches none of these keys — refusing while the live storefront credential is unaccounted for'
  }
  if (!target) {
    return `could not identify the storefront key: ${snapshots.length} publishable keys exist and none matches a configured MEDUSA_PUBLISHABLE_KEY — refusing to guess which one the storefront uses`
  }
  // ── THE D3 CAP ───────────────────────────────────────────────────────────────
  // More than one channel on the storefront key is a defect, not a milestone (epic
  // Definition of Done). This is the refusal the scaffold's own plan would have hit.
  if (desired.length !== 1) {
    return `refusing: the plan would leave the storefront key holding ${desired.length} sales channel(s). ` +
      'Medusa 2.15.3 rejects every cart creation from a key with more than one channel when the body carries no ' +
      'sales_channel_id (ensure-pub-key-sales-channel-match.js pushes onto req.errors; wrap-handler.js turns that ' +
      'into a 400), and the storefront never sends one. Exactly one link row, before and after (D3).'
  }
  if (after.length !== 1 || after[0] !== desired[0]) {
    return `refusing: add/remove arithmetic predicts ${after.length} link row(s) [${after.join(', ')}] instead of exactly [${desired[0]}]`
  }
  if (target.link_row_count !== target.channel_ids.length) {
    // Duplicate link rows to the SAME channel. `remove` is computed per channel id,
    // so dismissing "the" link leaves the surplus rows behind and the key keeps a
    // >1 row count — i.e. the D3 outage, reached from a plan that reported success.
    // The precedent is not hypothetical: 70 duplicate api_key link rows existed in
    // this database in July 2026.
    const duplicates = target.link_row_count - target.channel_ids.length
    return `refusing: the storefront key carries ${duplicates} DUPLICATE link row(s) ` +
      `(${target.link_row_count} rows naming ${target.channel_ids.length} distinct channel(s)). ` +
      'Medusa counts link rows, not distinct channels, so the surplus rows alone would 400 every cart ' +
      'creation (D3). Prune them first — see /internal/prune-api-keys.'
  }
  if (target.unusable_link_rows > 0) {
    // We cannot dismiss a link whose channel id we cannot read, so the real after-
    // count would exceed the predicted one. "I could not check" is not "there is
    // none": prune the dangling rows first (see /internal/prune-api-keys' header for
    // how they get there) and re-run.
    return `refusing: the storefront key carries ${target.unusable_link_rows} unreadable (dangling) link row(s). ` +
      'They cannot be dismissed by channel id, so the key would end up holding more than one link. Clear them first.'
  }
  return null
}
