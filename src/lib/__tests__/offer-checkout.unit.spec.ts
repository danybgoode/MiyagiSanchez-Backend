import { claimOfferForCheckout, releaseOfferClaim, OFFER_RESERVATION_STALE_MS, OFFER_IN_CHECKOUT_MESSAGE, OFFER_SESSION_TTL_MS, OFFER_RESERVATION_PERMANENT_ISO, supabaseOfferClaim, resolveOfferCheckout, type OfferRecord, type OfferCheckoutInput } from '../offer-checkout'

/**
 * The offer-amount tamper guarantee: a checkout charges a negotiated price only when it is a
 * real accepted offer for this cart's listing. Before this, `offer_amount_cents: 1` paid 1 centavo.
 */
const NOW = new Date('2026-11-11T12:00:00Z')
const offer = (over: Partial<OfferRecord> = {}): OfferRecord => ({
  id: 'off_1',
  status: 'accepted',
  offer_amount_cents: 80000,
  counter_amount_cents: null,
  checkout_expires_at: '2026-11-12T12:00:00Z',
  buyer_clerk_user_id: 'user_1',
  buyer_email: 'Ana@Example.com',
  listing_medusa_product_id: 'prod_1',
  ...over,
})
const input = (over: Partial<OfferCheckoutInput> = {}): OfferCheckoutInput => ({
  offerAmountCents: 80000,
  offerId: 'off_1',
  cartItems: [{ product_id: 'prod_1', quantity: 1 }],
  clerkUserId: 'user_1',
  buyerEmails: [],
  now: NOW,
  ...over,
})
const run = (i: OfferCheckoutInput, o: OfferRecord | null | Error = offer()) =>
  resolveOfferCheckout(i, async () => { if (o instanceof Error) throw o; return o })
const refused = (r: any) => { expect(r.ok).toBe(false); expect(r.status).toBe(422); expect(r.message).toBe('Esta oferta no es válida para este carrito.') }

describe('resolveOfferCheckout', () => {
  it('accepts a real accepted offer at its amount', async () => {
    expect(await run(input())).toEqual({ ok: true, amountCents: 80000, offerId: 'off_1' })
  })
  it('accepts an accepted counter at the counter amount', async () => {
    const r = await run(input({ offerAmountCents: 90000 }), offer({ counter_amount_cents: 90000 }))
    expect(r).toEqual({ ok: true, amountCents: 90000, offerId: 'off_1' })
  })
  it('does nothing when no amount is sent (and drops the bare offer id)', async () => {
    expect(await run(input({ offerAmountCents: undefined }))).toEqual({ ok: true, amountCents: undefined, offerId: undefined })
  })
  it('refuses an amount with no offer_id', async () => refused(await run(input({ offerId: undefined }))))
  it('refuses a missing offer', async () => refused(await run(input(), null)))
  it('refuses an amount different from the agreed one (1 centavo)', async () => refused(await run(input({ offerAmountCents: 1 }))))
  it('refuses the original amount once a counter was accepted', async () =>
    refused(await run(input({ offerAmountCents: 80000 }), offer({ counter_amount_cents: 90000 }))))
  it('refuses a non-integer or non-positive amount', async () => {
    refused(await run(input({ offerAmountCents: 0.5 })))
    refused(await run(input({ offerAmountCents: -5 })))
    refused(await run(input({ offerAmountCents: '80000' })))
  })
  it.each(['pending', 'countered', 'declined', 'withdrawn', 'expired', 'paid'])('refuses status %s', async (status) =>
    refused(await run(input(), offer({ status }))))
  it('refuses an expired payment window', async () =>
    refused(await run(input(), offer({ checkout_expires_at: '2026-11-11T11:00:00Z' }))))
  it('refuses an offer for another listing', async () =>
    refused(await run(input(), offer({ listing_medusa_product_id: 'prod_other' }))))
  it('refuses an unmapped listing', async () =>
    refused(await run(input(), offer({ listing_medusa_product_id: null }))))
  it('refuses a multi-item cart and quantity > 1', async () => {
    refused(await run(input({ cartItems: [{ product_id: 'prod_1', quantity: 1 }, { product_id: 'prod_2', quantity: 1 }] })))
    refused(await run(input({ cartItems: [{ product_id: 'prod_1', quantity: 2 }] })))
  })
  it('refuses another signed-in buyer, even with the right email', async () =>
    refused(await run(input({ clerkUserId: 'user_2', buyerEmails: ['ana@example.com'] }))))
  it('refuses an unverified caller on an offer made by a signed-in buyer, even with the right email', async () =>
    refused(await run(input({ clerkUserId: null, buyerEmails: ['ana@example.com'] }))))
  it('refuses an offer with no buyer_clerk_user_id, even with a matching email (no email path; codex #231)', async () =>
    refused(await run(input({ clerkUserId: null, buyerEmails: [undefined, 'ana@example.com'] }), offer({ buyer_clerk_user_id: null }))))
  it('resolves the cart product from variant.product_id when product_id is absent', async () => {
    const r = await run(input({ cartItems: [{ variant: { product_id: 'prod_1' }, quantity: 1 }] as any }))
    expect(r.ok).toBe(true)
  })
  it('refuses an anonymous caller with no matching email', async () => {
    refused(await run(input({ clerkUserId: null, buyerEmails: ['eve@example.com'] })))
    refused(await run(input({ clerkUserId: null, buyerEmails: [] })))
  })
  it('reports unavailable (503), not invalid, when the lookup fails', async () => {
    const r: any = await run(input(), new Error('boom'))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(503)
  })
})

/**
 * One accepted offer opens ONE checkout at a time: validate -> claim -> apply. The claim is a
 * conditional write injected here as a fake that models the real predicate
 * (reserved_at IS NULL OR reserved_at < staleBefore).
 */
describe('claimOfferForCheckout', () => {
  const fakeStore = (reservedAt: string | null) => {
    const state = { reservedAt }
    const claim = async (_id: string, writeIso: string, staleBeforeIso: string) => {
      if (state.reservedAt === null || state.reservedAt < staleBeforeIso) { state.reservedAt = writeIso; return true }
      return false
    }
    return { state, claim }
  }

  it('wins the claim on a free offer and records when', async () => {
    const st = fakeStore(null)
    const r = await claimOfferForCheckout('off_1', NOW, st.claim)
    expect(r).toEqual({ ok: true, reservedAt: NOW.toISOString() })
    expect(st.state.reservedAt).toBe(NOW.toISOString())
  })
  it('a second checkout loses with 409 OFFER_IN_CHECKOUT', async () => {
    const st = fakeStore(null)
    await claimOfferForCheckout('off_1', NOW, st.claim)
    const r = await claimOfferForCheckout('off_1', new Date(NOW.getTime() + 60_000), st.claim)
    expect(r).toEqual({ ok: false, status: 409, code: 'OFFER_IN_CHECKOUT', message: OFFER_IN_CHECKOUT_MESSAGE })
    expect(OFFER_IN_CHECKOUT_MESSAGE).toBe('Ya tienes un pago abierto para esta oferta. Termínalo o inténtalo de nuevo en 36 minutos.')
  })
  it('a stale reservation can be reclaimed, a fresh one cannot', async () => {
    const old = new Date(NOW.getTime() - OFFER_RESERVATION_STALE_MS - 1000).toISOString()
    const fresh = new Date(NOW.getTime() - OFFER_RESERVATION_STALE_MS + 60_000).toISOString()
    expect((await claimOfferForCheckout('off_1', NOW, fakeStore(old).claim)).ok).toBe(true)
    expect((await claimOfferForCheckout('off_1', NOW, fakeStore(fresh).claim)).ok).toBe(false)
  })
  it('a claim error is 503, never "valid"', async () => {
    const r = await claimOfferForCheckout('off_1', NOW, async () => { throw new Error('db down') })
    expect(r).toMatchObject({ ok: false, status: 503, code: 'OFFER_UNAVAILABLE' })
  })
})

describe('releaseOfferClaim', () => {
  it('releases with the id and the timestamp that were written', async () => {
    const calls: Array<[string, string]> = []
    expect(await releaseOfferClaim('off_1', 't1', async (id, t) => { calls.push([id, t]) })).toBe(true)
    expect(calls).toEqual([['off_1', 't1']])
  })
  it('a failed release is logged, not thrown', async () => {
    const logs: string[] = []
    const ok = await releaseOfferClaim('off_1', 't1', async () => { throw new Error('boom') }, (m) => logs.push(m))
    expect(ok).toBe(false)
    expect(logs[0]).toContain('off_1')
    expect(logs[0]).toContain('boom')
  })
})

describe('offer reservation vs payment session', () => {
  it('outlives the session by 5 minutes and the session clears Stripe\'s 30 minute minimum', () => {
    expect(OFFER_SESSION_TTL_MS).toBeGreaterThan(30 * 60 * 1000)
    expect(OFFER_RESERVATION_STALE_MS).toBe(OFFER_SESSION_TTL_MS + 5 * 60 * 1000)
  })
  it('a MANUAL checkout claims with the far-future timestamp up front, never a second write', async () => {
    const written: string[] = []
    const r = await claimOfferForCheckout('off_1', NOW, async (_id, writeIso) => { written.push(writeIso); return true }, { permanent: true })
    expect(written).toEqual([OFFER_RESERVATION_PERMANENT_ISO])
    expect(r).toEqual({ ok: true, reservedAt: OFFER_RESERVATION_PERMANENT_ISO })
    expect(Date.parse(OFFER_RESERVATION_PERMANENT_ISO)).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000)
  })
  it('Stripe/MP claims write now()', async () => {
    const written: string[] = []
    await claimOfferForCheckout('off_1', NOW, async (_id, writeIso) => { written.push(writeIso); return true })
    expect(written).toEqual([NOW.toISOString()])
  })
  it('a failed manual checkout releases the permanent reservation using the value written', async () => {
    const r = await claimOfferForCheckout('off_1', NOW, async () => true, { permanent: true })
    const calls: string[][] = []
    if (r.ok) await releaseOfferClaim('off_1', r.reservedAt, async (id, t) => { calls.push([id, t]) })
    expect(calls).toEqual([['off_1', OFFER_RESERVATION_PERMANENT_ISO]])
  })
})

describe('supabaseOfferClaim conditions', () => {
  const recorder = () => {
    const calls: Array<[string, ...unknown[]]> = []
    const q: any = new Proxy({}, { get: (_t, name: string) => {
      if (name === 'then') return (res: any) => res({ data: [{ id: 'off_1' }], error: null })
      return (...a: unknown[]) => { calls.push([name, ...a]); return q }
    } })
    return { calls, db: { from: () => q } }
  }
  it('requires accepted, a free-or-stale reservation, and an unexpired (or absent) payment window', async () => {
    const { calls, db } = recorder()
    expect(await supabaseOfferClaim(db)('off_1', 'W', 'STALE', 'NOW')).toBe(true)
    const ors = calls.filter(([n]) => n === 'or').map(([, f]) => f)
    expect(ors).toEqual([
      'checkout_reserved_at.is.null,checkout_reserved_at.lt.STALE',
      'checkout_expires_at.is.null,checkout_expires_at.gt.NOW',
    ])
    expect(calls).toContainEqual(['eq', 'status', 'accepted'])
    expect(calls).toContainEqual(['update', { checkout_reserved_at: 'W' }])
  })
})
