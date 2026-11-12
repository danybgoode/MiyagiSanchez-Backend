import { checkItemAmount, COUPON_ZERO_MESSAGE, ZERO_AMOUNT_MESSAGE } from '../zero-amount-guard'

describe('checkItemAmount', () => {
  it('accepts a positive amount', () => expect(checkItemAmount(100, null)).toEqual({ ok: true }))
  it.each([0, -1, NaN])('refuses %s', (n) => {
    expect(checkItemAmount(n, null)).toEqual({ ok: false, status: 422, code: 'ZERO_AMOUNT', message: ZERO_AMOUNT_MESSAGE })
  })
  it('leaves server-built carts to their own rules', () => {
    expect(checkItemAmount(0, 'in_person')).toEqual({ ok: true })
    expect(checkItemAmount(0, 'payment_link')).toEqual({ ok: true })
  })
  it('names the coupon when the coupon took a priced item to $0', () => {
    expect(checkItemAmount(0, null, 5000, 5000)).toMatchObject({ ok: false, code: 'ZERO_AMOUNT', message: COUPON_ZERO_MESSAGE })
    expect(COUPON_ZERO_MESSAGE).toBe('Este cupón deja el total en $0 y no se puede cobrar.')
  })
  it('keeps the price message when the item was already $0, coupon or not', () => {
    expect(checkItemAmount(0, null, 0, 0)).toMatchObject({ message: ZERO_AMOUNT_MESSAGE })
    expect(checkItemAmount(0, null, 100, 0)).toMatchObject({ message: ZERO_AMOUNT_MESSAGE })
  })
})
