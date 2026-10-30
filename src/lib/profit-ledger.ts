/**
 * profit-ledger — the PURE half of the append-only financial-events ledger
 * (profit-analyzer S1 · US-2). No I/O, no Medusa imports: every decision
 * (what events a sale produces, their deterministic dedupe keys, which are
 * already persisted) lives here so the append-only + exactly-once semantics
 * are provable in unit specs. The I/O half is `ProfitModuleService
 * .appendFinancialEvents` and the write points (order.placed subscriber,
 * ml-order-apply, the ship route, the backfill route).
 *
 * Money units: `amount_cents` is ALWAYS integer centavos. Native Medusa
 * amounts are already centavos platform-wide (create paths write
 * `price_cents` as the price amount); Mercado Libre raw payloads carry
 * decimal PESOS — `parseMl*` converts with Math.round(x * 100).
 *
 * ML parse discipline: the exact ML fee/shipping field semantics are
 * UNCONFIRMED against a live sandbox order (Epic A stored the raw payloads
 * verbatim for this reason). Every parsed amount records its source field +
 * assumption in event metadata, and a missing/odd shape yields NO event
 * (a partial row the dashboard renders honestly) — never an invented number.
 */

export type LedgerSource = 'mercadolibre' | 'native' | 'in_person' | 'payment_link'

/**
 * Where an order was sold, from its `metadata.source` — the ONE mapping the ledger
 * writer and the Ganancias route both use (in-person-sales D17). Counter sales
 * (`in_person`) and payment links (`payment_link`) are native Medusa orders with
 * native revenue/COGS; only the label differs, so Ganancias can split by it.
 * Anything unrecognised is `native` — the pre-existing default for an online order.
 */
export function orderSourceOf(metadata: unknown): LedgerSource {
  const src = (metadata as Record<string, unknown> | null | undefined)?.source
  return src === 'mercadolibre' || src === 'in_person' || src === 'payment_link' ? src : 'native'
}
export type LedgerEventType = 'revenue' | 'ml_fee' | 'shipping_cost' | 'cogs_snapshot'

export interface LedgerEventInput {
  order_id: string
  order_line_id: string | null
  seller_id: string | null
  source: LedgerSource
  event_type: LedgerEventType
  /** Integer centavos, always ≥ 0; event_type carries sign semantics. */
  amount_cents: number
  currency_code: string
  dedupe_key: string
  captured_at: Date
  metadata?: Record<string, unknown> | null
}

/**
 * Deterministic idempotency key. Replaying the same source event (webhook
 * redelivery, reconcile pass, backfill re-run) MUST regenerate the identical
 * key — that, plus the DB unique constraint, is the exactly-once guarantee.
 * `qualifier` distinguishes repeatable same-type events on one line (unused
 * in S1; reserved so a second shipping label can be a new event, not a clash).
 */
export function buildLedgerDedupeKey(
  orderId: string,
  lineId: string | null,
  eventType: LedgerEventType,
  qualifier?: string,
): string {
  return [orderId, lineId ?? 'order', eventType, ...(qualifier ? [qualifier] : [])].join(':')
}

/** Events whose dedupe_key is not yet persisted — the replay no-op filter. */
export function filterNewLedgerEvents(
  existingKeys: Set<string>,
  events: LedgerEventInput[],
): LedgerEventInput[] {
  return events.filter((e) => !existingKeys.has(e.dedupe_key))
}

// ── Native orders (order.placed) ─────────────────────────────────────────────

export interface NativeOrderLine {
  line_id: string
  quantity: number
  /** Line unit price in centavos (native Medusa amounts are centavos). */
  unit_price_cents: number
  /** The variant's `metadata.unit_cost_cents` at sale time; null when unset. */
  unit_cost_cents: number | null
}

/**
 * A native sale's ledger events: one `revenue` per line, plus a
 * `cogs_snapshot` per line that HAS a cost recorded (no invented zeros —
 * "no COGS set" and "COGS $0" are different facts). Processor fees are not
 * captured in S1 (platform fee is 0%; Stripe balance_transaction capture is
 * a named follow-up) — native rows carry no fee event, honestly.
 */
export function buildNativeOrderEvents(input: {
  order_id: string
  seller_id: string | null
  currency_code: string
  captured_at: Date
  lines: NativeOrderLine[]
  /** Counter / link / online — all native orders; defaults to 'native'. */
  source?: Exclude<LedgerSource, 'mercadolibre'>
}): LedgerEventInput[] {
  const events: LedgerEventInput[] = []
  const source = input.source ?? 'native'
  for (const line of input.lines) {
    const qty = Number.isFinite(line.quantity) ? Math.max(0, Math.trunc(line.quantity)) : 0
    const unitCents = Number.isFinite(line.unit_price_cents) ? Math.round(line.unit_price_cents) : 0
    if (qty <= 0) continue
    events.push({
      order_id: input.order_id,
      order_line_id: line.line_id,
      seller_id: input.seller_id,
      source,
      event_type: 'revenue',
      amount_cents: unitCents * qty,
      currency_code: input.currency_code,
      dedupe_key: buildLedgerDedupeKey(input.order_id, line.line_id, 'revenue'),
      captured_at: input.captured_at,
      metadata: { quantity: qty, unit_price_cents: unitCents },
    })
    if (line.unit_cost_cents != null && Number.isInteger(line.unit_cost_cents) && line.unit_cost_cents >= 0) {
      events.push({
        order_id: input.order_id,
        order_line_id: line.line_id,
        seller_id: input.seller_id,
        source,
        event_type: 'cogs_snapshot',
        amount_cents: line.unit_cost_cents * qty,
        currency_code: input.currency_code,
        dedupe_key: buildLedgerDedupeKey(input.order_id, line.line_id, 'cogs_snapshot'),
        captured_at: input.captured_at,
        metadata: { quantity: qty, unit_cost_cents: line.unit_cost_cents },
      })
    }
  }
  return events
}

// ── Mercado Libre orders (materialized) ──────────────────────────────────────

/** Round decimal pesos → integer centavos; null on any non-finite/negative input. */
function pesosToCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

export interface MlLineFinancials {
  quantity: number
  unit_price_cents: number | null
  /** Line-total ML fee in centavos (sale_fee × quantity — see metadata assumption). */
  sale_fee_cents: number | null
}

/**
 * Per-line money facts for THIS link's item from the raw ML order payload
 * (`order.metadata.ml_raw_order`, stored verbatim by Epic A). Mirrors
 * `buildMlOrderLineItems`' filtering exactly (same item id, one entry per ML
 * line, zero-qty lines skipped) so ledger lines match the materialized order
 * lines 1:1 by array position. `sale_fee` is documented by ML as per-unit —
 * unverified against a live sandbox, so the assumption is recorded in the
 * event metadata for the owed eyeball.
 */
export function parseMlLineFinancials(mlRawOrder: unknown, mlItemId: string): MlLineFinancials[] {
  const orderItems = (mlRawOrder as { order_items?: unknown[] } | null)?.order_items
  if (!Array.isArray(orderItems)) return []
  const lines: MlLineFinancials[] = []
  for (const raw of orderItems) {
    const oi = raw as { item?: { id?: unknown }; quantity?: unknown; unit_price?: unknown; sale_fee?: unknown }
    if (String(oi?.item?.id ?? '') !== mlItemId) continue
    const qty = typeof oi.quantity === 'number' && Number.isFinite(oi.quantity) ? Math.max(0, Math.trunc(oi.quantity)) : 0
    if (qty <= 0) continue
    const unitCents = pesosToCents(oi.unit_price)
    const perUnitFeeCents = pesosToCents(oi.sale_fee)
    lines.push({
      quantity: qty,
      unit_price_cents: unitCents,
      sale_fee_cents: perUnitFeeCents != null ? perUnitFeeCents * qty : null,
    })
  }
  return lines
}

/**
 * The seller-side shipping cost from the raw ML shipment payload, tried
 * across the candidate fields ML shipments are known to carry — first
 * parseable wins, and WHICH field it was is returned for provenance. Null
 * (no event, partial row) when none parse — never a guess.
 */
export function parseMlShipmentCost(
  mlRawShipment: unknown,
): { amount_cents: number; source_field: string } | null {
  const s = mlRawShipment as Record<string, unknown> | null
  if (!s || typeof s !== 'object') return null
  const option = (s.shipping_option ?? null) as Record<string, unknown> | null
  const candidates: Array<[string, unknown]> = [
    ['shipping_option.list_cost', option?.list_cost],
    ['base_cost', s.base_cost],
    ['shipping_option.cost', option?.cost],
    ['order_cost', s.order_cost],
  ]
  for (const [field, value] of candidates) {
    const cents = pesosToCents(value)
    if (cents != null) return { amount_cents: cents, source_field: field }
  }
  return null
}

/**
 * A materialized ML order's ledger events from the raw payloads Epic A
 * stored on its metadata: per-line `revenue` + `ml_fee` (when parseable) +
 * `cogs_snapshot` (when the variant has a cost), plus one order-level
 * `shipping_cost` (when the shipment payload carries a parseable cost).
 * `order_line_ids` maps by position to `parseMlLineFinancials`' output —
 * both mirror `buildMlOrderLineItems`' filtering, so position IS identity.
 */
export function buildMlOrderEvents(input: {
  order_id: string
  seller_id: string | null
  currency_code: string
  captured_at: Date
  ml_item_id: string
  ml_raw_order: unknown
  ml_raw_shipment: unknown
  order_line_ids: (string | null)[]
  /** The linked variant's unit_cost_cents at capture time; null when unset. */
  unit_cost_cents: number | null
}): LedgerEventInput[] {
  const events: LedgerEventInput[] = []
  const lines = parseMlLineFinancials(input.ml_raw_order, input.ml_item_id)

  lines.forEach((line, i) => {
    const lineId = input.order_line_ids[i] ?? null
    // Without a mapped Medusa line id, the dedupe key would collapse every
    // line onto the same 'order' scope — qualify by the line's INDEX in the
    // raw payload instead. Deterministic across replays because
    // `ml_raw_order` is stored verbatim on the order and never changes.
    const qualifier = lineId == null ? String(i) : undefined
    const base = {
      order_id: input.order_id,
      order_line_id: lineId,
      seller_id: input.seller_id,
      source: 'mercadolibre' as const,
      currency_code: input.currency_code,
      captured_at: input.captured_at,
    }
    if (line.unit_price_cents != null) {
      events.push({
        ...base,
        event_type: 'revenue',
        amount_cents: line.unit_price_cents * line.quantity,
        dedupe_key: buildLedgerDedupeKey(input.order_id, lineId, 'revenue', qualifier),
        metadata: { quantity: line.quantity, unit_price_cents: line.unit_price_cents },
      })
    }
    if (line.sale_fee_cents != null) {
      events.push({
        ...base,
        event_type: 'ml_fee',
        amount_cents: line.sale_fee_cents,
        dedupe_key: buildLedgerDedupeKey(input.order_id, lineId, 'ml_fee', qualifier),
        metadata: {
          quantity: line.quantity,
          source_field: 'order_items[].sale_fee',
          assumption: 'sale_fee is per unit; amount = sale_fee × quantity',
        },
      })
    }
    if (input.unit_cost_cents != null && Number.isInteger(input.unit_cost_cents) && input.unit_cost_cents >= 0) {
      events.push({
        ...base,
        event_type: 'cogs_snapshot',
        amount_cents: input.unit_cost_cents * line.quantity,
        dedupe_key: buildLedgerDedupeKey(input.order_id, lineId, 'cogs_snapshot', qualifier),
        metadata: { quantity: line.quantity, unit_cost_cents: input.unit_cost_cents },
      })
    }
  })

  const shipping = parseMlShipmentCost(input.ml_raw_shipment)
  if (shipping) {
    events.push({
      order_id: input.order_id,
      order_line_id: null,
      seller_id: input.seller_id,
      source: 'mercadolibre',
      event_type: 'shipping_cost',
      amount_cents: shipping.amount_cents,
      currency_code: input.currency_code,
      dedupe_key: buildLedgerDedupeKey(input.order_id, null, 'shipping_cost'),
      captured_at: input.captured_at,
      metadata: { source_field: shipping.source_field },
    })
  }

  return events
}

// ── Native shipping (Envia label purchase) ───────────────────────────────────

/**
 * The label's cost from the raw Envia `/ship/generate/` response
 * (`createShipment().raw`) — same defensive candidates-with-provenance shape
 * as `parseMlShipmentCost`. Envia responses carry `data[0].totalPrice` on the
 * quote shape; the generate shape is unconfirmed, so null (no event, "envío
 * pendiente" on the dashboard) when nothing parses.
 */
export function parseEnviaLabelCost(
  raw: unknown,
): { amount_cents: number; source_field: string } | null {
  const res = raw as { data?: unknown } | null
  if (!res || typeof res !== 'object') return null
  const d = (Array.isArray(res.data) ? res.data[0] : res.data) as Record<string, unknown> | undefined
  if (!d || typeof d !== 'object') return null
  const candidates: Array<[string, unknown]> = [
    ['data.totalPrice', d.totalPrice],
    ['data.total_price', d.total_price],
    ['data.basePrice', d.basePrice],
    ['data.price', d.price],
  ]
  for (const [field, value] of candidates) {
    const cents = pesosToCents(value)
    if (cents != null && cents > 0) return { amount_cents: cents, source_field: field }
  }
  return null
}

/**
 * The shipping-cost event a bought Envia label appends — a FOLLOW-UP event
 * that completes a partial row (the sale's revenue/COGS landed at
 * order.placed; the label cost lands when the label is bought). Never
 * mutates anything; same dedupe key on a re-generated label = no-op.
 */
export function buildNativeShippingEvent(input: {
  order_id: string
  seller_id: string | null
  currency_code: string
  captured_at: Date
  amount_cents: number
  metadata?: Record<string, unknown>
}): LedgerEventInput | null {
  if (!Number.isFinite(input.amount_cents) || input.amount_cents < 0) return null
  return {
    order_id: input.order_id,
    order_line_id: null,
    seller_id: input.seller_id,
    source: 'native',
    event_type: 'shipping_cost',
    amount_cents: Math.round(input.amount_cents),
    currency_code: input.currency_code,
    dedupe_key: buildLedgerDedupeKey(input.order_id, null, 'shipping_cost'),
    captured_at: input.captured_at,
    metadata: input.metadata ?? null,
  }
}
