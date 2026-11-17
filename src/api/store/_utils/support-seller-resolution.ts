import { resolveSellerProductIdsFromRemoteQuery } from './seller-catalog-query'

type SellerServiceLike = {
  listSellers: (filters?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<any[]>
}

export async function findSellerById(sellerService: SellerServiceLike, sellerId?: string | null) {
  if (!sellerId) return null
  const [seller] = await sellerService.listSellers({ id: sellerId }, { take: 1 })
  return seller ?? null
}

/**
 * Each product's linked seller id, or `null` when no seller is linked to it — ONE query, product
 * side of the seller↔product link (the read checkout-admission already uses). Deliberately NOT
 * caught: checkout decides who is paid from this, so a failed read fails the checkout closed.
 */
export async function productOwnerIds(
  remoteQuery: { graph: (q: Record<string, unknown>) => Promise<{ data?: unknown[] }> },
  productIds: string[],
): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(productIds.filter(Boolean)))
  const owners = new Map<string, string | null>(ids.map((id) => [id, null]))
  if (!ids.length) return owners
  const { data } = await remoteQuery.graph({ entity: 'product', fields: ['id', 'seller.id'], filters: { id: ids } })
  for (const row of (data ?? []) as Array<{ id?: string; seller?: { id?: string } | null }>) {
    if (row?.id && owners.has(row.id)) owners.set(row.id, row.seller?.id ?? null)
  }
  return owners
}

/** The distinct sellers the cart's products are linked to (unlinked products contribute none). */
export function linkedOwners(owners: Map<string, string | null>): string[] {
  return Array.from(new Set(Array.from(owners.values()).filter((id): id is string => !!id)))
}

export async function findSellerLinkedToProduct(
  sellerService: SellerServiceLike,
  remoteQuery: any,
  productId?: string | null,
) {
  if (!productId) return null

  const allSellers = await sellerService.listSellers({}, { take: 500 })
  for (const seller of allSellers) {
    try {
      const ids = await resolveSellerProductIdsFromRemoteQuery(remoteQuery, seller.id)
      if (ids.has(productId)) return seller
    } catch {
      // no products linked
    }
  }

  return null
}

export function supportSellerIdFromMetadata(metadata: Record<string, unknown>) {
  const sellerId = metadata.support_seller_id
  return typeof sellerId === 'string' && sellerId ? sellerId : null
}

export async function resolveSellerForCheckout({
  sellerService,
  remoteQuery,
  productId,
  bodySellerId,
  productMetadata,
  isSupportCheckout,
  cartProductIds,
  productOwners,
}: {
  sellerService: SellerServiceLike
  remoteQuery: any
  productId?: string | null
  /** Every product in the cart. Defaults to [productId]. */
  cartProductIds?: string[]
  /** `productOwnerIds(cartProductIds)` when the caller already has it (start-checkout does). */
  productOwners?: Map<string, string | null>
  bodySellerId?: string | null
  productMetadata: Record<string, unknown>
  isSupportCheckout: boolean
}) {
  let seller = isSupportCheckout
    ? await findSellerById(sellerService, supportSellerIdFromMetadata(productMetadata))
    : null

  if (seller) return seller

  // The caller's `seller_id` is a HINT that saves a lookup — never an authority over who is paid.
  // The seller resolved here RECEIVES the money (Stripe destination, Mercado Pago account, the
  // CLABE shown for a transfer). It used to be taken as sent, so a caller who named their own shop
  // for someone else's product was paid for it while the real owner saw the order (2026-11-17,
  // Backend #238). Now: a named seller is kept only when every LINKED product in the cart is its
  // own; otherwise the cart's one linked owner is used. A cart linked to two shops resolves to
  // nobody here and start-checkout refuses it (CART_MIXED_SELLERS). Products linked to NO seller
  // add no constraint — today's behaviour, kept because how many such rows exist live is unmeasured.
  const ids = (cartProductIds?.length ? cartProductIds : productId ? [productId] : []).filter(Boolean)
  const owners = linkedOwners(productOwners ?? (await productOwnerIds(remoteQuery, ids)))
  if (bodySellerId) {
    const named = await findSellerById(sellerService, bodySellerId)
    if (named && owners.every((id) => id === named.id)) return named
  }
  if (owners.length === 1) seller = await findSellerById(sellerService, owners[0])
  return seller
}
