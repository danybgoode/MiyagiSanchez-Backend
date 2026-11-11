/**
 * The complete Medusa-owned portion of Miyagi's flag inventory.
 *
 * Every owner is a source file which calls the public `isEnabled()` seam. A
 * source-derived unit spec compares this registry to the TypeScript AST, so a
 * new call site cannot silently bypass classification and a deleted call site
 * cannot leave plausible-looking stale ownership documentation behind.
 */
export type FlagPolarity = 'enablement' | 'killswitch'
export type FlagCriticality = 'low' | 'medium' | 'high'
export type FlagEnforcement = 'backend' | 'both'

type FlagCatalogMetadata = {
  compileDefault: boolean
  polarity: FlagPolarity
  criticality: FlagCriticality
  enforcement: FlagEnforcement
  /** Immutable value in Golden's `miyagi` definition, distinct from runtime fallback. */
  goldenDefault: boolean
  /** Immutable Golden metadata, preserved even if local call-site ownership later differs. */
  goldenEnforcement: FlagEnforcement
  description: string
  owners: readonly string[]
}

const FLAG_CATALOG_DEFINITIONS = {
  'checkout.stripe_enabled': {
    compileDefault: true,
    polarity: 'killswitch',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    // Current immutable Golden text: this app owns the catalog fragment and must
    // reproduce the legacy Miyagi import byte-for-byte on explicit sync.
    description:
      'Pagos con tarjeta vía Stripe. Actívala para permitir pagos con tarjeta; apágala para quitar Stripe de todo el checkout (los demás métodos de pago siguen funcionando).',
    owners: [
      'src/api/store/carts/[id]/start-checkout/route.ts',
      'src/api/store/sellers/[slug]/checkout-options/route.ts',
    ],
  },
  'checkout.rental_pricing_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Cobro automático de rentas (noches × tarifa + depósito). Actívala para que el checkout calcule el cobro completo de una renta; apagada, las rentas se coordinan directamente con el vendedor.',
    owners: ['src/api/store/carts/[id]/start-checkout/route.ts'],
  },
  'shipping.envia_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: false,
    goldenEnforcement: 'both',
    description:
      'Cotización y envío automático con Envía.com. Actívala cuando la cuenta de Envía esté lista para usarse; apagada, los compradores solo ven entrega acordada o recolección en tienda.',
    owners: [
      'src/api/store/envia/rates/route.ts',
      'src/api/store/sellers/me/orders/[id]/ship/route.ts',
    ],
  },
  'shipping.correos_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Tarifa económica de Correos de México en el checkout. Actívala para ofrecer esta opción de envío económico; apagada, esta tarifa nunca aparece (independiente de Envía).',
    owners: [
      'src/api/store/carts/[id]/start-checkout/route.ts',
      'src/api/store/envia/rates/route.ts',
      'src/api/store/sellers/[slug]/checkout-options/route.ts',
    ],
  },
  'shipping.arranged_only_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Entrega acordada por vendedor, anuncio por anuncio. Actívala para que un vendedor pueda marcar un anuncio como "solo entrega acordada" (oculta la paquetería automática y el comprador coordina directo); apagada, todos los anuncios se comportan como hoy (paquetería normal).',
    owners: [
      'src/api/store/carts/[id]/start-checkout/route.ts',
      'src/api/store/sellers/[slug]/checkout-options/route.ts',
    ],
  },
  'ml.sync_enabled': {
    compileDefault: false,
    polarity: 'killswitch',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Sincronización de inventario con Mercado Libre en ambos sentidos. Actívala para mantener el stock igual en los dos lados automáticamente; apágala para detener la sincronización al instante si algo sale mal. Por seguridad, empieza apagada.',
    owners: [
      'src/api/store/_utils/seller-product-update.ts',
      'src/api/webhooks/mercadolibre/route.ts',
      'src/jobs/reconcile-ml-inventory.ts',
      'src/jobs/reconcile-ml-order-status.ts',
      'src/subscribers/ml-inventory-sync.ts',
    ],
  },
  'ml.orders_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    enforcement: 'backend',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Crear un pedido real cuando se vende en Mercado Libre. Actívala para que una venta en ML también cree un pedido en Miyagi; apagada, solo se actualiza el stock, sin crear pedido.',
    owners: [
      'src/api/webhooks/mercadolibre/route.ts',
      'src/jobs/reconcile-ml-inventory.ts',
      'src/jobs/reconcile-ml-order-status.ts',
    ],
  },
  'ml.sync_paywall_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'low',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Cobro por activar la sincronización de inventario con ML. Actívala para que activar la sincronización requiera un plan de pago; apagada, cualquier vendedor conectado puede sincronizar gratis.',
    owners: ['src/lib/ml-orders-entitlement.ts'],
  },
  'ops.profit_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'medium',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Panel de ganancias y márgenes para vendedores. Actívala para mostrar el panel y empezar a registrar cada venta; apagada, no hay panel ni registro.',
    owners: [
      'src/api/internal/profit/apply-price/route.ts',
      'src/api/internal/profit/backfill/route.ts',
      'src/api/internal/profit/ledger/route.ts',
      'src/api/store/sellers/me/products/bulk-stage/route.ts',
      'src/api/store/sellers/me/profit/apply-price/route.ts',
      'src/api/store/sellers/me/profit/fee-estimate/route.ts',
      'src/api/store/sellers/me/profit/route.ts',
      'src/lib/profit-ledger-write.ts',
    ],
  },
  'ml.publish_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Publicar productos en Mercado Libre, paso 3. Actívala para permitir publicar y editar productos en ML desde aquí; apagada, esa opción no aparece.',
    owners: ['src/api/store/_utils/profit-apply-price.ts'],
  },
  'catalog.inventory_channels_enabled': {
    compileDefault: false,
    polarity: 'enablement',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Modos de inventario (sin límite / sobre pedido), publicar o no cada producto en Mercado Libre, y precio distinto para ML. Actívala para desbloquear estas opciones por producto; apagada, todo producto usa inventario normal con existencias contadas.',
    owners: [
      'src/api/store/_utils/seller-product-update.ts',
      'src/api/store/listings/route.ts',
    ],
  },
  'catalog.owned_shop_only_enabled': {
    // The capability is live by default. Golden Beans owns the canonical
    // definition and production activation; this local default remains the
    // fail-open fallback if a Golden snapshot is unavailable. Turning the Golden
    // flag OFF is the deliberate rollback, matching checkout.stripe_enabled.
    compileDefault: true,
    // KILLSWITCH, not enablement: it is already live and OFF is deliberate. This
    // preserves the invariant that every enablement flag defaults false.
    polarity: 'killswitch',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Owned-shop-only buyability and publication controls. The capability is live by default; turning this flag OFF is the deliberate kill switch.',
    owners: [
      'src/api/store/checkout-admission/[id]/route.ts',
      'src/api/store/_utils/seller-product-create.ts',
      'src/api/store/_utils/seller-product-update.ts',
    ],
  },
  'catalog.bulk_enabled': {
    compileDefault: false,
    polarity: 'killswitch',
    criticality: 'high',
    enforcement: 'both',
    goldenDefault: true,
    goldenEnforcement: 'both',
    description:
      'Editar muchos productos a la vez (selección masiva). Actívala para permitir cambios masivos de precio, categoría, etc.; por seguridad empieza apagada, ya que un error afectaría muchos productos de golpe.',
    owners: [
      'src/api/internal/seller-products/bulk-apply/route.ts',
      'src/api/internal/seller-products/bulk-stage/route.ts',
      'src/api/store/sellers/me/products/bulk-apply/route.ts',
      'src/api/store/sellers/me/products/bulk-stage/route.ts',
    ],
  },
} as const satisfies Record<string, FlagCatalogMetadata>

export type FlagKey = keyof typeof FLAG_CATALOG_DEFINITIONS

export type BackendFlagCatalogEntry = FlagCatalogMetadata & {
  key: FlagKey
}

export const BACKEND_FLAG_CATALOG: readonly BackendFlagCatalogEntry[] = Object.entries(
  FLAG_CATALOG_DEFINITIONS,
)
  .map(([key, metadata]) => ({ key: key as FlagKey, ...metadata }))
  .sort((left, right) => left.key.localeCompare(right.key))

export const BACKEND_FLAG_KEYS: readonly FlagKey[] = BACKEND_FLAG_CATALOG.map(
  (entry) => entry.key,
)

export const BACKEND_FLAG_DEFAULTS: Readonly<Record<FlagKey, boolean>> = Object.freeze(
  Object.fromEntries(
    BACKEND_FLAG_CATALOG.map((entry) => [entry.key, entry.compileDefault]),
  ) as Record<FlagKey, boolean>,
)

export type FlagCallsite = {
  key: string
  owner: string
}

export type FlagInventoryValidation =
  | { ok: true }
  | { ok: false; errors: readonly string[] }

/**
 * Validates an independently derived call-site inventory against the registry.
 * Duplicate, unknown, missing and stale owner rows all fail together rather than
 * yielding a partial catalog that looks complete.
 */
export function validateBackendFlagCallsiteInventory(
  callsites: readonly FlagCallsite[],
): FlagInventoryValidation {
  const errors: string[] = []
  const actual = new Set<string>()
  const expected = new Set(
    BACKEND_FLAG_CATALOG.flatMap((entry) =>
      entry.owners.map((owner) => `${entry.key}\u0000${owner}`),
    ),
  )

  for (const callsite of callsites) {
    const identity = `${callsite.key}\u0000${callsite.owner}`
    if (actual.has(identity)) {
      errors.push(`duplicate callsite: ${callsite.key} @ ${callsite.owner}`)
      continue
    }
    actual.add(identity)
    if (!Object.prototype.hasOwnProperty.call(FLAG_CATALOG_DEFINITIONS, callsite.key)) {
      errors.push(`unknown flag callsite: ${callsite.key} @ ${callsite.owner}`)
    } else if (!expected.has(identity)) {
      errors.push(`unregistered owner: ${callsite.key} @ ${callsite.owner}`)
    }
  }

  for (const identity of expected) {
    if (!actual.has(identity)) {
      const [key, owner] = identity.split('\u0000')
      errors.push(`missing callsite: ${key} @ ${owner}`)
    }
  }

  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors: errors.sort((left, right) => left.localeCompare(right)) }
}
