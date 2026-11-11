/**
 * Inventory helpers — Medusa Inventory module wiring for seller products.
 *
 * Marketplace items are unique P2P goods (default quantity 1). We rely on the
 * Inventory module so Medusa's built-in completeCartWorkflow → reserveInventoryStep
 * reserves stock on order placement and blocks double-selling. This file centralises
 * the three things a managed variant needs beyond `manage_inventory: true`:
 *   1. an inventory *level* (stock) at a stock location, and
 *   2. that location being linked to the product's sales channel (otherwise
 *      reserveInventoryStep throws "sales channel not associated with any stock location"), and
 *   3. resolving which stock location to use (one is seeded).
 *
 * `createProductVariantsWorkflow` already auto-creates the inventory *item* for a
 * managed variant, so we only create the level here.
 */
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  createInventoryItemsWorkflow,
  createInventoryLevelsWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from '@medusajs/medusa/core-flows'
import type { MarketCode } from '../../../lib/markets'
import {
  type MarketMedusaEnv,
  resolveStockLocationForMarket,
} from '../../../lib/market-medusa'

type Scope = { resolve: (key: string) => any }

/** True when the listing's attrs carry the event block (a date or a venue). */
export function hasEventBlock(attrs: Record<string, unknown> | null | undefined): boolean {
  if (!attrs || typeof attrs !== 'object') return false
  const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  return filled(attrs.event_date) || filled(attrs.venue_name)
}

/**
 * The ONE stock predicate — create, update and the backfill all ask it.
 *
 * Physical `product` listings are unique-stock items (covers autos/inmuebles,
 * which are products with category metadata). A `service` or `digital` listing is
 * stockable only as an EVENT: it carries the event block AND the caller provided
 * a quantity ("Lugares disponibles"). Without a quantity an event stays unmanaged,
 * exactly as before, so no existing listing changes behaviour.
 */
export function isStockableListingType(
  listingType: string | null | undefined,
  event?: { attrs?: Record<string, unknown> | null; quantity?: number | null },
): boolean {
  const type = listingType ?? 'product'
  if (type === 'product') return true
  if (type !== 'service' && type !== 'digital') return false
  return hasEventBlock(event?.attrs) && event?.quantity != null
}

/**
 * Seats are an AVAILABLE count, so only a negative or non-numeric value is
 * refused (D2: lowering below tickets sold cannot happen by construction —
 * stocked = available + reserved). Pure, so it is unit-tested without Medusa.
 */
export function validateSeatQuantity(quantity: unknown): { ok: true } | { ok: false; message: string } {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
    return { ok: false, message: 'Los lugares disponibles no pueden ser negativos.' }
  }
  return { ok: true }
}

/**
 * Resolve the stock location owned by `market`. There is deliberately no database
 * fallback: "oldest location" put a US seller's stock in Mexico.
 */
export async function resolveStockLocationId(
  _scope: Scope,
  market: MarketCode,
  env: MarketMedusaEnv = process.env,
): Promise<string | undefined> {
  const resolution = resolveStockLocationForMarket(market, env)
  return resolution.status === 'resolved' ? resolution.id : undefined
}

/** Find the inventory item id auto-created for a managed variant. */
export async function getVariantInventoryItemId(
  scope: Scope,
  variantId: string
): Promise<string | undefined> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'variant',
    fields: ['id', 'inventory_items.inventory_item_id'],
    filters: { id: variantId },
  })
  return (data?.[0]?.inventory_items?.[0] as { inventory_item_id?: string } | undefined)?.inventory_item_id
}

/**
 * The buyable (available) quantity for a product = Σ(stocked − reserved) across
 * its variants' inventory levels, clamped ≥ 0. This is the number the ML stock
 * sync pushes outward (it reflects Medusa reservations, so a placed-but-unpaid
 * order already reduces it). Returns null when the product has no managed
 * inventory to read (caller treats null as "nothing to sync"). Used by the
 * inventory-sync subscriber, the reconcile job, and the seller-edit hook.
 */
export async function getProductAvailableQuantity(
  scope: Scope,
  productId: string
): Promise<number | null> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'product',
    fields: [
      'id',
      'variants.inventory_items.inventory.location_levels.stocked_quantity',
      'variants.inventory_items.inventory.location_levels.reserved_quantity',
    ],
    filters: { id: productId },
  })
  const variants = ((data?.[0] as any)?.variants ?? []) as any[]
  let sawLevel = false
  let available = 0
  for (const v of variants) {
    for (const ii of (v?.inventory_items ?? []) as any[]) {
      for (const lvl of (ii?.inventory?.location_levels ?? []) as any[]) {
        sawLevel = true
        const stocked = Number(lvl?.stocked_quantity ?? 0)
        const reserved = Number(lvl?.reserved_quantity ?? 0)
        available += stocked - reserved
      }
    }
  }
  if (!sawLevel) return null
  return Math.max(0, Math.floor(available))
}

/**
 * Ensure a variant has a linked inventory item, creating one if missing. Unlike
 * variant *creation*, flipping `manage_inventory` false→true on an existing variant
 * does NOT auto-create an inventory item, so backfill must do it here. Returns the
 * inventory item id. Idempotent.
 */
export async function ensureVariantInventoryItem(
  scope: Scope,
  variant: { id: string; sku?: string | null; title?: string | null }
): Promise<string> {
  const existing = await getVariantInventoryItemId(scope, variant.id)
  if (existing) return existing

  const { result } = await createInventoryItemsWorkflow(scope as any).run({
    input: {
      items: [
        {
          sku: variant.sku ?? undefined,
          title: variant.title ?? undefined,
          requires_shipping: true,
        },
      ],
    },
  })
  const inventoryItemId = (result?.[0] as { id: string }).id

  const remoteLink = scope.resolve(ContainerRegistrationKeys.LINK)
  await remoteLink.create({
    [Modules.PRODUCT]: { variant_id: variant.id },
    [Modules.INVENTORY]: { inventory_item_id: inventoryItemId },
    data: { required_quantity: 1 },
  })
  return inventoryItemId
}

/** Ensure the sales channel is linked to the stock location (idempotent). */
export async function ensureSalesChannelLocationLink(
  scope: Scope,
  salesChannelId: string,
  locationId: string
): Promise<void> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'sales_channel',
    fields: ['id', 'stock_locations.id'],
    filters: { id: salesChannelId },
  })
  const linked = ((data?.[0]?.stock_locations ?? []) as Array<{ id: string }>).some(
    (l) => l.id === locationId
  )
  if (linked) return
  await linkSalesChannelsToStockLocationWorkflow(scope as any).run({
    input: { id: locationId, add: [salesChannelId] },
  })
}

/**
 * Create an inventory level (stock) for an inventory item at a location, unless one
 * already exists. Idempotent — safe for backfill and retries.
 */
export async function ensureInventoryLevel(
  scope: Scope,
  inventoryItemId: string,
  locationId: string,
  stockedQuantity: number
): Promise<void> {
  const inventoryService = scope.resolve(Modules.INVENTORY)
  const existing = await inventoryService.listInventoryLevels({
    inventory_item_id: inventoryItemId,
    location_id: locationId,
  })
  if (existing.length > 0) return
  await createInventoryLevelsWorkflow(scope as any).run({
    input: {
      inventory_levels: [
        {
          inventory_item_id: inventoryItemId,
          location_id: locationId,
          stocked_quantity: stockedQuantity,
        },
      ],
    },
  })
}

/**
 * Set a managed variant's *available* quantity at the location (seller-facing
 * "cantidad disponible"). available = stocked − reserved, so to make exactly
 * `availableQuantity` units buyable we set stocked = availableQuantity + reserved.
 * This never clobbers in-flight reservations (pending/placed orders). Ensures the
 * inventory item + level exist first. Returns the resulting stocked/reserved.
 */
export async function setVariantAvailableQuantity(
  scope: Scope,
  variant: { id: string; sku?: string | null; title?: string | null },
  locationId: string,
  availableQuantity: number
): Promise<{ stocked: number; reserved: number }> {
  const desired = Math.max(0, Math.floor(availableQuantity))
  const inventoryItemId = await ensureVariantInventoryItem(scope, variant)
  const inventoryService = scope.resolve(Modules.INVENTORY)

  const [level] = await inventoryService.listInventoryLevels({
    inventory_item_id: inventoryItemId,
    location_id: locationId,
  })
  const reserved = Number(level?.reserved_quantity ?? 0)
  const stocked = desired + reserved

  if (level) {
    await inventoryService.updateInventoryLevels([
      { inventory_item_id: inventoryItemId, location_id: locationId, stocked_quantity: stocked },
    ])
  } else {
    await ensureInventoryLevel(scope, inventoryItemId, locationId, stocked)
  }
  return { stocked, reserved }
}

/**
 * Full provisioning for a freshly-created managed variant: link the sales channel to
 * the location and create the stock level. Best-effort — logs and swallows so a
 * provisioning hiccup never blocks product creation (the product still exists; the
 * backfill endpoint can repair it).
 */
export async function provisionVariantInventory(
  scope: Scope,
  opts: {
    variantId: string
    /**
     * EVERY channel this variant's product joins — not just one.
     *
     * Widened from a single `salesChannelId` by the owned-shop-operating-channel
     * epic (S2.2). Medusa reserves inventory at order completion against THE CART'S
     * sales channel, and after D3 that is the OPERATING channel while the product
     * also sits in the marketplace channel. Linking only one of them leaves the
     * other unable to reserve — "sales channel not associated with any stock
     * location" at the moment money moves, which is the worst possible place to
     * discover it. Passing the whole set is what keeps D5 true for products created
     * after provisioning, not only for the ones the backfill swept.
     */
    salesChannelIds?: readonly string[]
    locationId: string
    quantity: number
  }
): Promise<{ ok: boolean; inventoryItemId?: string; error?: string }> {
  try {
    const inventoryItemId = await getVariantInventoryItemId(scope, opts.variantId)
    if (!inventoryItemId) {
      return { ok: false, error: 'no inventory item found for variant' }
    }
    for (const salesChannelId of new Set(opts.salesChannelIds ?? [])) {
      await ensureSalesChannelLocationLink(scope, salesChannelId, opts.locationId)
    }
    await ensureInventoryLevel(scope, inventoryItemId, opts.locationId, opts.quantity)
    return { ok: true, inventoryItemId }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('[inventory] provisionVariantInventory failed:', error)
    return { ok: false, error }
  }
}
