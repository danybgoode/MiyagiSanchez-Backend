/**
 * Pure quantity price-tier validation for seller-defined variant pricing
 * (custom-print-products Sprint 2). Mirrors the discipline of
 * `apps/storefront/lib/personalization.ts`: pure, never throws, returns a
 * structured result.
 *
 * A tier ladder must cover [1, ∞) with no overlap and no gap: sorted by
 * `min_quantity`, each tier's `min_quantity` is exactly the previous tier's
 * `max_quantity + 1`, and only the last tier may be open-ended
 * (`max_quantity: null`).
 */

export interface PriceTier {
  min_quantity: number
  max_quantity: number | null
  amount: number
}

export type ValidateTierLadderResult = { ok: true } | { ok: false; message: string }

const OVERLAP_OR_GAP_MESSAGE =
  'Los rangos de cantidad no pueden traslaparse ni dejar huecos. Revisa los límites entre niveles.'

export function validateTierLadder(tiers: PriceTier[]): ValidateTierLadderResult {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { ok: false, message: 'Se requiere al menos un nivel de precio.' }
  }

  const sorted = [...tiers].sort((a, b) => (a?.min_quantity ?? 0) - (b?.min_quantity ?? 0))

  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i]
    if (!tier || !Number.isInteger(tier.min_quantity) || tier.min_quantity < 1) {
      return { ok: false, message: OVERLAP_OR_GAP_MESSAGE }
    }
    if (!(typeof tier.amount === 'number' && Number.isFinite(tier.amount) && tier.amount > 0)) {
      return { ok: false, message: 'Cada nivel necesita un precio mayor a 0.' }
    }
    if (tier.max_quantity !== null && (!Number.isInteger(tier.max_quantity) || tier.max_quantity < tier.min_quantity)) {
      return { ok: false, message: OVERLAP_OR_GAP_MESSAGE }
    }

    const isLast = i === sorted.length - 1
    if (isLast) {
      if (tier.max_quantity !== null) {
        // Only the last (highest) tier may be open-ended — a bounded final
        // tier would leave everything above it unpriced (a gap to ∞).
        return { ok: false, message: OVERLAP_OR_GAP_MESSAGE }
      }
    } else {
      if (tier.max_quantity === null) {
        return { ok: false, message: OVERLAP_OR_GAP_MESSAGE }
      }
      const next = sorted[i + 1]
      if (!next || next.min_quantity !== tier.max_quantity + 1) {
        return { ok: false, message: OVERLAP_OR_GAP_MESSAGE }
      }
    }
  }

  if (sorted[0].min_quantity !== 1) {
    return { ok: false, message: OVERLAP_OR_GAP_MESSAGE }
  }

  return { ok: true }
}

/**
 * Distinguishes a REAL quantity-tier ladder (multiple mxn prices covering
 * different [min_quantity, max_quantity] bands) from a harmless same-price
 * duplicate. Medusa Admin's price editor shows one column per currency PLUS
 * one column per region — filling in both the bare "MXN" column and a
 * region-scoped "Mexico" column creates TWO mxn price rows with the SAME
 * unbounded band (min_quantity:1, max_quantity:null), not a ladder, just
 * the same single price entered twice (found live 2026-07-13,
 * pricing-money-path-remediation Finding E). `seller-product-update.ts`'s
 * flat `price_cents` write must refuse a real ladder (silently picking one
 * row would corrupt the others' stale amounts — cross-agent review catch,
 * 2026-07-05) but is safe to collapse a same-band duplicate by updating
 * every row to the new amount.
 */
export interface QuantityBand {
  min_quantity: number | null
  max_quantity: number | null
}

export function isRealTierLadder(mxnPrices: QuantityBand[]): boolean {
  if (mxnPrices.length <= 1) return false
  return mxnPrices.some((p, i) =>
    mxnPrices.some((other, j) => i !== j && (p.min_quantity !== other.min_quantity || p.max_quantity !== other.max_quantity)),
  )
}
