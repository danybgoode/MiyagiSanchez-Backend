import { checkItemAmount, ZERO_AMOUNT_MESSAGE } from '../zero-amount-guard'

describe('checkItemAmount', () => {
  it('accepts a positive amount', () => expect(checkItemAmount(100, null)).toEqual({ ok: true }))
  it.each([0, -1, NaN])('refuses %s', (n) => {
    expect(checkItemAmount(n, null)).toEqual({ ok: false, status: 422, code: 'ZERO_AMOUNT', message: ZERO_AMOUNT_MESSAGE })
  })
  it('leaves server-built carts to their own rules', () => {
    expect(checkItemAmount(0, 'in_person')).toEqual({ ok: true })
    expect(checkItemAmount(0, 'payment_link')).toEqual({ ok: true })
  })
})
