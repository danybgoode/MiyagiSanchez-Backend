import { resolveSellerProductIdsFromRemoteQuery } from './seller-catalog-query'

type SellerServiceLike = {
  listSellers: (filters?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<any[]>
}

export async function findSellerById(sellerService: SellerServiceLike, sellerId?: string | null) {
  if (!sellerId) return null
  const [seller] = await sellerService.listSellers({ id: sellerId }, { take: 1 })
  return seller ?? null
}

/** Does this seller own every one of these products (the seller↔product link)? */
export async function sellerOwnsProducts(remoteQuery: any, sellerId: string, productIds: string[]): Promise<boolean> {
  const owned = await resolveSellerProductIdsFromRemoteQuery(remoteQuery, sellerId)
  return productIds.every((id) => owned.has(id))
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
}: {
  sellerService: SellerServiceLike
  remoteQuery: any
  productId?: string | null
  /** Every product in the cart. A caller-named seller must own all of them. Defaults to [productId]. */
  cartProductIds?: string[]
  bodySellerId?: string | null
  productMetadata: Record<string, unknown>
  isSupportCheckout: boolean
}) {
  let seller = isSupportCheckout
    ? await findSellerById(sellerService, supportSellerIdFromMetadata(productMetadata))
    : null

  // The caller's `seller_id` is a HINT that skips the scan below — never an authority over who
  // is paid. The seller resolved here receives the money (Stripe destination, Mercado Pago
  // account, the CLABE shown for a transfer), so a caller who named their own shop for someone
  // else's product used to be paid for it while the real owner saw the order (2026-11-17).
  // A named seller is kept only when it owns every product in the cart; otherwise the product's
  // real owner is used. When NO seller owns the product (an unlinked row), the named seller is
  // kept as before: there is no owner to divert the money from.
  if (!seller && bodySellerId) {
    const named = await findSellerById(sellerService, bodySellerId)
    const ids = (cartProductIds?.length ? cartProductIds : productId ? [productId] : []).filter(Boolean)
    if (named && (ids.length === 0 || (await sellerOwnsProducts(remoteQuery, named.id, ids)))) {
      seller = named
    } else if (named) {
      seller = (await findSellerLinkedToProduct(sellerService, remoteQuery, productId)) ?? named
    }
  }

  if (!seller) {
    seller = await findSellerLinkedToProduct(sellerService, remoteQuery, productId)
  }

  return seller
}
