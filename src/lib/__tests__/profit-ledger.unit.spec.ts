/**
 * profit-ledger unit specs (profit-analyzer S1 · US-2) — the append-only +
 * exactly-once PROOFS the sprint doc demands:
 *  - replaying a source event regenerates identical dedupe keys → the filter
 *    (and the DB unique constraint behind it) writes nothing new;
 *  - changing COGS afterward produces only NEW events for NEW sales — an
 *    existing sale's snapshot is a frozen input, nothing rewrites it;
 *  - the defensive ML parser never invents an amount from a missing/odd shape.
 */
import {
  buildLedgerDedupeKey,
  filterNewLedgerEvents,
  buildNativeOrderEvents,
  buildMlOrderEvents,
  parseMlLineFinancials,
  parseMlShipmentCost,
  parseEnviaLabelCost,
  buildNativeShippingEvent,
} from '../profit-ledger'

const capturedAt = new Date('2026-07-06T12:00:00Z')

const nativeInput = {
  order_id: 'order_1',
  seller_id: 'sel_1',
  currency_code: 'mxn',
  captured_at: capturedAt,
  lines: [
    { line_id: 'li_1', quantity: 2, unit_price_cents: 10000, unit_cost_cents: 4500 },
    { line_id: 'li_2', quantity: 1, unit_price_cents: 5000, unit_cost_cents: null },
  ],
}

describe('buildNativeOrderEvents', () => {
  it('emits revenue per line and cogs_snapshot only where a cost exists', () => {
    const events = buildNativeOrderEvents(nativeInput)
    expect(events.map((e) => e.event_type)).toEqual(['revenue', 'cogs_snapshot', 'revenue'])
    const [rev1, cogs1, rev2] = events
    expect(rev1.amount_cents).toBe(20000)
    expect(cogs1.amount_cents).toBe(9000)
    expect(rev2.amount_cents).toBe(5000)
    // No invented zero-COGS event for the line without a recorded cost.
    expect(events.filter((e) => e.order_line_id === 'li_2' && e.event_type === 'cogs_snapshot')).toHaveLength(0)
  })

  it('is deterministic — a replay regenerates byte-identical dedupe keys', () => {
    const first = buildNativeOrderEvents(nativeInput).map((e) => e.dedupe_key)
    const replay = buildNativeOrderEvents(nativeInput).map((e) => e.dedupe_key)
    expect(replay).toEqual(first)
  })

  it('replay writes nothing new once keys are persisted (append-only no-op)', () => {
    const events = buildNativeOrderEvents(nativeInput)
    const persisted = new Set(events.map((e) => e.dedupe_key))
    expect(filterNewLedgerEvents(persisted, buildNativeOrderEvents(nativeInput))).toEqual([])
  })

  it('changing COGS later never touches an existing sale — the old snapshot amount is a frozen input', () => {
    const events = buildNativeOrderEvents(nativeInput)
    const persisted = new Set(events.map((e) => e.dedupe_key))
    // The seller edits the variant's COGS 4500 → 9999, then the same sale replays
    // (webhook redelivery / backfill): the snapshot's dedupe key is unchanged, so
    // NOTHING is appended — the persisted 9000-centavos snapshot stands.
    const afterEdit = buildNativeOrderEvents({
      ...nativeInput,
      lines: [{ ...nativeInput.lines[0], unit_cost_cents: 9999 }, nativeInput.lines[1]],
    })
    expect(filterNewLedgerEvents(persisted, afterEdit)).toEqual([])
    // A NEW sale after the edit snapshots the new cost — history diverges forward only.
    const newSale = buildNativeOrderEvents({
      ...nativeInput,
      order_id: 'order_2',
      lines: [{ ...nativeInput.lines[0], unit_cost_cents: 9999 }],
    })
    const fresh = filterNewLedgerEvents(persisted, newSale)
    expect(fresh.find((e) => e.event_type === 'cogs_snapshot')?.amount_cents).toBe(19998)
  })

  it('skips zero/negative-quantity lines', () => {
    const events = buildNativeOrderEvents({
      ...nativeInput,
      lines: [{ line_id: 'li_x', quantity: 0, unit_price_cents: 100, unit_cost_cents: 50 }],
    })
    expect(events).toEqual([])
  })
})

describe('buildLedgerDedupeKey', () => {
  it('is stable and line-scoped', () => {
    expect(buildLedgerDedupeKey('o1', 'l1', 'revenue')).toBe('o1:l1:revenue')
    expect(buildLedgerDedupeKey('o1', null, 'shipping_cost')).toBe('o1:order:shipping_cost')
    expect(buildLedgerDedupeKey('o1', 'l1', 'shipping_cost', 'label2')).toBe('o1:l1:shipping_cost:label2')
  })
})

// ── ML parse (defensive — raw shapes unconfirmed against a live sandbox) ─────

const mlRawOrder = {
  id: 999,
  currency_id: 'MXN',
  order_items: [
    { item: { id: 'MLM1', title: 'Producto' }, quantity: 2, unit_price: 150.5, sale_fee: 21.07 },
    { item: { id: 'MLM_OTHER' }, quantity: 1, unit_price: 80, sale_fee: 10 },
  ],
}

describe('parseMlLineFinancials', () => {
  it('filters to the link item and converts pesos → centavos', () => {
    const lines = parseMlLineFinancials(mlRawOrder, 'MLM1')
    expect(lines).toEqual([{ quantity: 2, unit_price_cents: 15050, sale_fee_cents: 4214 }])
  })

  it('missing sale_fee yields null fee (partial), never zero', () => {
    const lines = parseMlLineFinancials(
      { order_items: [{ item: { id: 'MLM1' }, quantity: 1, unit_price: 100 }] },
      'MLM1',
    )
    expect(lines[0].sale_fee_cents).toBeNull()
    expect(lines[0].unit_price_cents).toBe(10000)
  })

  it('garbage shapes yield no lines, not a throw', () => {
    expect(parseMlLineFinancials(null, 'MLM1')).toEqual([])
    expect(parseMlLineFinancials({ order_items: 'nope' }, 'MLM1')).toEqual([])
    expect(parseMlLineFinancials({ order_items: [{ item: { id: 'MLM1' }, quantity: 'two' }] }, 'MLM1')).toEqual([])
  })
})

describe('parseMlShipmentCost', () => {
  it('prefers shipping_option.list_cost and reports the source field', () => {
    expect(parseMlShipmentCost({ shipping_option: { list_cost: 95.5, cost: 0 }, base_cost: 80 }))
      .toEqual({ amount_cents: 9550, source_field: 'shipping_option.list_cost' })
  })

  it('falls through candidates in order', () => {
    expect(parseMlShipmentCost({ base_cost: 80 }))
      .toEqual({ amount_cents: 8000, source_field: 'base_cost' })
    expect(parseMlShipmentCost({ shipping_option: { cost: 60 } }))
      .toEqual({ amount_cents: 6000, source_field: 'shipping_option.cost' })
  })

  it('returns null (partial row) when nothing parses — never a guess', () => {
    expect(parseMlShipmentCost(null)).toBeNull()
    expect(parseMlShipmentCost({})).toBeNull()
    expect(parseMlShipmentCost({ base_cost: 'free' })).toBeNull()
    expect(parseMlShipmentCost({ base_cost: -5 })).toBeNull()
  })
})

describe('buildMlOrderEvents', () => {
  const input = {
    order_id: 'order_ml_1',
    seller_id: 'sel_1',
    currency_code: 'mxn',
    captured_at: capturedAt,
    ml_item_id: 'MLM1',
    ml_raw_order: mlRawOrder,
    ml_raw_shipment: { shipping_option: { list_cost: 95.5 } },
    order_line_ids: ['li_ml_1'],
    unit_cost_cents: 4500,
  }

  it('emits revenue + ml_fee + cogs per line and one order-level shipping event', () => {
    const events = buildMlOrderEvents(input)
    expect(events.map((e) => e.event_type).sort()).toEqual(['cogs_snapshot', 'ml_fee', 'revenue', 'shipping_cost'])
    expect(events.find((e) => e.event_type === 'revenue')?.amount_cents).toBe(30100)
    expect(events.find((e) => e.event_type === 'ml_fee')?.amount_cents).toBe(4214)
    expect(events.find((e) => e.event_type === 'cogs_snapshot')?.amount_cents).toBe(9000)
    expect(events.find((e) => e.event_type === 'shipping_cost')?.amount_cents).toBe(9550)
    // Every parsed ML amount carries provenance for the owed sandbox eyeball.
    expect(events.find((e) => e.event_type === 'ml_fee')?.metadata).toMatchObject({ source_field: 'order_items[].sale_fee' })
    expect(events.find((e) => e.event_type === 'shipping_cost')?.metadata).toMatchObject({ source_field: 'shipping_option.list_cost' })
  })

  it('replay is an append-only no-op', () => {
    const persisted = new Set(buildMlOrderEvents(input).map((e) => e.dedupe_key))
    expect(filterNewLedgerEvents(persisted, buildMlOrderEvents(input))).toEqual([])
  })

  it('unparseable shipment/fee → partial events, no invention', () => {
    const events = buildMlOrderEvents({
      ...input,
      ml_raw_order: { order_items: [{ item: { id: 'MLM1' }, quantity: 1, unit_price: 100 }] },
      ml_raw_shipment: null,
      unit_cost_cents: null,
    })
    expect(events.map((e) => e.event_type)).toEqual(['revenue'])
  })
})

describe('parseEnviaLabelCost', () => {
  it('parses totalPrice from the data entry (array or object) with provenance', () => {
    expect(parseEnviaLabelCost({ data: [{ totalPrice: 123.45 }] }))
      .toEqual({ amount_cents: 12345, source_field: 'data.totalPrice' })
    expect(parseEnviaLabelCost({ data: { basePrice: 80 } }))
      .toEqual({ amount_cents: 8000, source_field: 'data.basePrice' })
  })

  it('returns null when nothing parses — never a guess', () => {
    expect(parseEnviaLabelCost(null)).toBeNull()
    expect(parseEnviaLabelCost({})).toBeNull()
    expect(parseEnviaLabelCost({ data: [{ totalPrice: 'free' }] })).toBeNull()
    expect(parseEnviaLabelCost({ data: [{ totalPrice: 0 }] })).toBeNull()
  })
})

describe('buildNativeShippingEvent', () => {
  it('builds an order-level follow-up event with a stable key', () => {
    const ev = buildNativeShippingEvent({
      order_id: 'order_1', seller_id: 'sel_1', currency_code: 'mxn',
      captured_at: capturedAt, amount_cents: 12345, metadata: { rate_id: 'r1' },
    })
    expect(ev).toMatchObject({
      event_type: 'shipping_cost',
      amount_cents: 12345,
      dedupe_key: 'order_1:order:shipping_cost',
    })
  })

  it('rejects negative/non-finite amounts', () => {
    expect(buildNativeShippingEvent({
      order_id: 'o', seller_id: null, currency_code: 'mxn',
      captured_at: capturedAt, amount_cents: -1,
    })).toBeNull()
    expect(buildNativeShippingEvent({
      order_id: 'o', seller_id: null, currency_code: 'mxn',
      captured_at: capturedAt, amount_cents: Number.NaN,
    })).toBeNull()
  })
})

describe('orderSourceOf (in-person-sales D17)', () => {
  const { orderSourceOf, buildNativeOrderEvents } = require('../profit-ledger')
  it('maps every known source and defaults the rest to native', () => {
    expect(orderSourceOf({ source: 'in_person' })).toBe('in_person')
    expect(orderSourceOf({ source: 'payment_link' })).toBe('payment_link')
    expect(orderSourceOf({ source: 'mercadolibre' })).toBe('mercadolibre')
    expect(orderSourceOf({ source: 'something-else' })).toBe('native')
    expect(orderSourceOf(null)).toBe('native')
  })
  it('a counter sale writes its revenue and COGS rows labelled in_person', () => {
    const events = buildNativeOrderEvents({
      order_id: 'o', seller_id: 's', currency_code: 'mxn', captured_at: new Date(0), source: 'in_person',
      lines: [{ line_id: 'l', quantity: 1, unit_price_cents: 100, unit_cost_cents: 40 }],
    })
    expect(events.map((e: { source: string }) => e.source)).toEqual(['in_person', 'in_person'])
  })
})
