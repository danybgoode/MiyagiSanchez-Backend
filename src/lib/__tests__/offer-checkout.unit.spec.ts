import { resolveOfferCheckout, type OfferRecord, type OfferCheckoutInput } from '../offer-checkout'

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
