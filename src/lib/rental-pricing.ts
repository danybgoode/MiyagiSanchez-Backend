/**
 * src/lib/rental-pricing.ts
 *
 * Rental line-item pricing (epic 02 · checkout-and-payments) — Sprint 1, Story 1.1.
 *
 * Backend port of the spec-proven frontend seam `apps/storefront/lib/rental-pricing.ts`.
 * Pure, main()-less, cents-in — the SINGLE source of truth for the rental math, so the
 * charged total (start-checkout, S1.2) is computed from the same functions the PDP renders,
 * never re-derived inline. Kept byte-for-byte in step with the frontend seam; the only
 * addition is `readDepositCents`, the pesos→cents normalization the backend needs because
 * the seller stores `metadata.attrs.deposit` in PESOS while everything downstream is cents.
 *
 * Unit-tested by `src/lib/__tests__/rental-pricing.unit.spec.ts` (Jest, backend CI gate).
 */

export type RatePeriod = 'dia' | 'semana' | 'mes'

/** Nights covered by one billed unit of each rate period. */
const NIGHTS_PER_UNIT: Record<RatePeriod, number> = { dia: 1, semana: 7, mes: 30 }

export interface RentalPriceInput {
  /** Rate per period, in cents (the listing price). */
  rateCents: number
  /** Refundable deposit in cents (0 when the seller set none). */
  depositCents: number
  /** Nights in the selected range (see `nightsBetween`). */
  nights: number
  /** What the rate is per — defaults to día. */
  period: RatePeriod
}

export interface RentalPrice {
  period: RatePeriod
  nights: number
  /** Billed units (e.g. 3 noches → 3 días; 10 noches semanal → 2 semanas). */
  units: number
  /** units × rateCents. */
  rentCents: number
  depositCents: number
  /** rentCents + depositCents — the bar total. */
  totalCents: number
}

/** Normalise an arbitrary stored value to a known rate period (default día). */
export function toRatePeriod(raw: unknown): RatePeriod {
  return raw === 'semana' || raw === 'mes' ? raw : 'dia'
}

/**
 * Whole nights between two YYYY-MM-DD dates. 0 when either is missing/invalid or
 * the range is non-positive (check-out ≤ check-in). UTC math so it never shifts
 * by a day across timezones / DST.
 */
export function nightsBetween(checkIn: string | null | undefined, checkOut: string | null | undefined): number {
  if (!checkIn || !checkOut) return 0
  const a = Date.parse(`${checkIn}T00:00:00Z`)
  const b = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  const nights = Math.round((b - a) / 86_400_000)
  return nights > 0 ? nights : 0
}

/**
 * Strict `YYYY-MM-DD` calendar validity. `Date.parse` silently NORMALISES impossible
 * day-of-month values (`2026-06-31` → Jul 1, `2026-02-30` → Mar 2), so on the money
 * path `nightsBetween` alone would charge a phantom night and stamp a nonsense date.
 * This round-trips the parsed date to reject anything that rolled over. (Out-of-range
 * MONTHS already parse to NaN; this closes the day-of-month gap.)
 */
export function isValidYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Billed units for a night count at a given period (ceil — a partial period bills whole). */
export function rentalUnits(nights: number, period: RatePeriod): number {
  if (nights <= 0) return 0
  return Math.ceil(nights / NIGHTS_PER_UNIT[period])
}

/**
 * The exact rental total. `rentCents = units × rateCents`, `totalCents = rent +
 * deposit`. A non-positive range yields units 0 → rent 0 (deposit still shown so
 * the buyer sees it before picking dates).
 */
export function computeRentalTotal(input: RentalPriceInput): RentalPrice {
  const rate = Math.max(0, Math.round(input.rateCents || 0))
  const deposit = Math.max(0, Math.round(input.depositCents || 0))
  const nights = input.nights > 0 ? Math.floor(input.nights) : 0
  const units = rentalUnits(nights, input.period)
  const rentCents = units * rate
  return {
    period: input.period,
    nights,
    units,
    rentCents,
    depositCents: deposit,
    totalCents: rentCents + deposit,
  }
}

/**
 * Read the refundable deposit off a product's `metadata.attrs` and normalise to CENTS.
 *
 * ⚠️ The seller stores `attrs.deposit` in PESOS (e.g. `2000` = $2,000 = 200000 cents),
 * unlike the rate, which Medusa already stores as integer cents (the variant price).
 * This is the ONE seam that bridges the two units — everything else in this module is
 * cents-in. Absent / non-numeric / non-positive → 0 (a seller with no deposit set).
 */
export function readDepositCents(attrs: Record<string, unknown> | null | undefined): number {
  const raw = attrs?.deposit
  const pesos =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN
  if (!Number.isFinite(pesos) || pesos <= 0) return 0
  return Math.round(pesos * 100)
}

/** es-MX label for the billed units, e.g. "3 noches", "2 semanas", "1 mes". */
export function rentalUnitsLabel(units: number, period: RatePeriod): string {
  if (period === 'semana') return `${units} ${units === 1 ? 'semana' : 'semanas'}`
  if (period === 'mes') return `${units} ${units === 1 ? 'mes' : 'meses'}`
  return `${units} ${units === 1 ? 'noche' : 'noches'}`
}

/** es-MX singular noun for the rate period — "/día", "/semana", "/mes". */
export function ratePeriodLabel(period: RatePeriod): string {
  return period === 'semana' ? 'semana' : period === 'mes' ? 'mes' : 'día'
}

/** Exact es-MX currency string (no fractional pesos, matching the rest of the PDP). */
export function formatRentalCents(cents: number, currency = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}
