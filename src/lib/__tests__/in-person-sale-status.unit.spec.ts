import { deriveSaleState } from '../in-person-sale-status'

/**
 * in-person-sales S2 · D9/D10 — what a counter claim plus its order MEAN. "Paid"
 * comes only from an order (the provider webhook completes a cart only once its
 * payment is approved), and money taken is never hidden behind a cancel.
 */
describe('deriveSaleState', () => {
  const card = (status: string) => ({ kind: 'card', status })
  const transfer = (status: string) => ({ kind: 'transfer', status })
  const order = (over: Partial<{ payment_received: boolean; payment_status: string | null }> = {}) => ({
    payment_received: false, payment_status: 'authorized', ...over,
  })

  it('a card sale with no order is still waiting for the buyer', () => {
    expect(deriveSaleState(card('awaiting_payment'), null)).toBe('awaiting_payment')
  })
  it('a card sale whose cart became an order is paid', () => {
    expect(deriveSaleState(card('completed'), order())).toBe('paid')
  })
  it('a card sale paid moments after a cancel is reported PAID, never hidden', () => {
    expect(deriveSaleState(card('cancelled'), order())).toBe('paid')
  })
  it('a cancelled card sale with no order is cancelled', () => {
    expect(deriveSaleState(card('cancelled'), null)).toBe('cancelled')
  })
  it('a transfer order waits for «Ya me llegó» — nothing is auto-confirmed', () => {
    expect(deriveSaleState(transfer('completed'), order())).toBe('pending_confirmation')
  })
  it('a transfer is paid once the merchant confirms (or the payment is captured)', () => {
    expect(deriveSaleState(transfer('completed'), order({ payment_received: true }))).toBe('paid')
    expect(deriveSaleState(transfer('completed'), order({ payment_status: 'captured' }))).toBe('paid')
  })
  it('a failed claim with no order is failed', () => {
    expect(deriveSaleState(card('failed'), null)).toBe('failed')
  })
})
