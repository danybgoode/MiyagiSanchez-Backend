import {
  nightsBetween,
  rentalUnits,
  computeRentalTotal,
  rentalUnitsLabel,
  ratePeriodLabel,
  toRatePeriod,
  formatRentalCents,
  readDepositCents,
  isValidYmd,
} from '../rental-pricing'

/**
 * Rental line-item pricing (epic 02) — Sprint 1, Story 1.1.
 *
 * The charged rental total MUST be exact (S1.2 bills what these functions return),
 * so the math is a pure seam proven here. Ported 1:1 from the frontend's
 * `apps/storefront/e2e/rental-pricing.spec.ts`, PLUS the backend-only
 * `readDepositCents` pesos→cents normalization.
 */

describe('rental-pricing · nightsBetween', () => {
  it('whole nights between two YYYY-MM-DD dates', () => {
    expect(nightsBetween('2026-06-13', '2026-06-16')).toBe(3)
    expect(nightsBetween('2026-06-13', '2026-06-14')).toBe(1)
  })

  it('non-positive / invalid ranges yield 0', () => {
    expect(nightsBetween('2026-06-16', '2026-06-13')).toBe(0) // reversed
    expect(nightsBetween('2026-06-13', '2026-06-13')).toBe(0) // same day
    expect(nightsBetween('', '2026-06-16')).toBe(0)
    expect(nightsBetween('2026-06-13', null)).toBe(0)
    expect(nightsBetween('not-a-date', '2026-06-16')).toBe(0)
  })

  it('does not drift across a DST boundary (UTC math)', () => {
    expect(nightsBetween('2026-04-04', '2026-04-07')).toBe(3)
  })
})

describe('rental-pricing · billed units (ceil per period)', () => {
  it('día bills one unit per night', () => {
    expect(rentalUnits(3, 'dia')).toBe(3)
    expect(rentalUnits(1, 'dia')).toBe(1)
  })

  it('semana / mes bill whole partial periods up', () => {
    expect(rentalUnits(7, 'semana')).toBe(1)
    expect(rentalUnits(8, 'semana')).toBe(2)
    expect(rentalUnits(30, 'mes')).toBe(1)
    expect(rentalUnits(31, 'mes')).toBe(2)
  })

  it('a non-positive night count is 0 units', () => {
    expect(rentalUnits(0, 'dia')).toBe(0)
    expect(rentalUnits(-2, 'semana')).toBe(0)
  })
})

describe('rental-pricing · computeRentalTotal (exact)', () => {
  it('acceptance: a 3-day range = 3 × daily + deposit', () => {
    // $1,200/día daily, $2,000 deposit, 3 nights.
    const p = computeRentalTotal({ rateCents: 120000, depositCents: 200000, nights: 3, period: 'dia' })
    expect(p.units).toBe(3)
    expect(p.rentCents).toBe(360000) // 3 × 120000
    expect(p.depositCents).toBe(200000)
    expect(p.totalCents).toBe(560000) // 360000 + 200000
    expect(formatRentalCents(p.totalCents)).toBe('$5,600')
  })

  it('zero deposit drops out of the total', () => {
    const p = computeRentalTotal({ rateCents: 50000, depositCents: 0, nights: 2, period: 'dia' })
    expect(p.totalCents).toBe(100000)
    expect(p.depositCents).toBe(0)
  })

  it('weekly rate over 10 nights bills 2 weeks', () => {
    const p = computeRentalTotal({ rateCents: 300000, depositCents: 0, nights: 10, period: 'semana' })
    expect(p.units).toBe(2)
    expect(p.totalCents).toBe(600000)
  })

  it('no range → rent 0, deposit still surfaced', () => {
    const p = computeRentalTotal({ rateCents: 120000, depositCents: 200000, nights: 0, period: 'dia' })
    expect(p.units).toBe(0)
    expect(p.rentCents).toBe(0)
    expect(p.totalCents).toBe(200000)
  })

  it('negative / NaN inputs are clamped, never produce a negative total', () => {
    const p = computeRentalTotal({ rateCents: -100, depositCents: Number.NaN, nights: 3, period: 'dia' })
    expect(p.rentCents).toBe(0)
    expect(p.depositCents).toBe(0)
    expect(p.totalCents).toBe(0)
  })
})

describe('rental-pricing · labels', () => {
  it('toRatePeriod normalises to a known period (default día)', () => {
    expect(toRatePeriod('semana')).toBe('semana')
    expect(toRatePeriod('mes')).toBe('mes')
    expect(toRatePeriod('dia')).toBe('dia')
    expect(toRatePeriod(undefined)).toBe('dia')
    expect(toRatePeriod('garbage')).toBe('dia')
  })

  it('es-MX unit + period labels', () => {
    expect(rentalUnitsLabel(1, 'dia')).toBe('1 noche')
    expect(rentalUnitsLabel(3, 'dia')).toBe('3 noches')
    expect(rentalUnitsLabel(2, 'semana')).toBe('2 semanas')
    expect(rentalUnitsLabel(1, 'mes')).toBe('1 mes')
    expect(ratePeriodLabel('dia')).toBe('día')
    expect(ratePeriodLabel('semana')).toBe('semana')
    expect(ratePeriodLabel('mes')).toBe('mes')
  })
})

describe('rental-pricing · isValidYmd (strict calendar validity)', () => {
  it('accepts real YYYY-MM-DD dates', () => {
    expect(isValidYmd('2026-06-15')).toBe(true)
    expect(isValidYmd('2028-02-29')).toBe(true) // 2028 is a leap year
  })

  it('rejects impossible day-of-month that Date.parse would roll over', () => {
    expect(isValidYmd('2026-06-31')).toBe(false) // → would roll to Jul 1
    expect(isValidYmd('2026-02-30')).toBe(false) // → would roll to Mar 2
    expect(isValidYmd('2026-02-29')).toBe(false) // 2026 not a leap year
  })

  it('rejects out-of-range months, bad shapes, and non-strings', () => {
    expect(isValidYmd('2026-13-01')).toBe(false)
    expect(isValidYmd('2026-00-10')).toBe(false)
    expect(isValidYmd('2026-6-15')).toBe(false) // not zero-padded
    expect(isValidYmd('06/15/2026')).toBe(false)
    expect(isValidYmd('')).toBe(false)
    expect(isValidYmd(null)).toBe(false)
    expect(isValidYmd(20260615)).toBe(false)
  })
})

describe('rental-pricing · readDepositCents (pesos → cents)', () => {
  it('numeric pesos convert to cents', () => {
    expect(readDepositCents({ deposit: 2000 })).toBe(200000)
    expect(readDepositCents({ deposit: 1500 })).toBe(150000)
  })

  it('string pesos are parsed', () => {
    expect(readDepositCents({ deposit: '1500' })).toBe(150000)
    expect(readDepositCents({ deposit: '  1500  ' })).toBe(150000)
  })

  it('decimal pesos keep the centavos', () => {
    expect(readDepositCents({ deposit: 1500.5 })).toBe(150050)
    expect(readDepositCents({ deposit: '1500.50' })).toBe(150050)
  })

  it('absent / non-numeric / non-positive → 0', () => {
    expect(readDepositCents({})).toBe(0)
    expect(readDepositCents(null)).toBe(0)
    expect(readDepositCents(undefined)).toBe(0)
    expect(readDepositCents({ deposit: 'abc' })).toBe(0)
    expect(readDepositCents({ deposit: '' })).toBe(0)
    expect(readDepositCents({ deposit: -10 })).toBe(0)
    expect(readDepositCents({ deposit: 0 })).toBe(0)
    expect(readDepositCents({ deposit: Number.NaN })).toBe(0)
    expect(readDepositCents({ deposit: { amount: 2000 } })).toBe(0)
  })
})
