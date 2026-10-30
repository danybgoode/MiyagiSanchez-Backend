/**
 * Counter carts complete only on the provider their sale kind allows
 * (in-person-sales D9, codex security lens on PR 218).
 *
 * Medusa's public routes let anyone holding a cart id swap its payment session
 * (POST /store/payment-collections/:id/payment-sessions) and complete it
 * (POST /store/carts/:id/complete). For a card sale that meant: switch to the cash
 * provider — which authorizes unconditionally — and get an order with no money moved.
 * The status route already refuses to call that "paid"; this hook stops the order from
 * existing at all. A cart with no counter claim is untouched.
 */
import { completeCartWorkflow } from '@medusajs/medusa/core-flows'
import { MedusaError } from '@medusajs/framework/utils'
import { IN_PERSON_MODULE } from '../../modules/in-person'
import { counterCartMatchesClaim, disallowedCounterProviders } from '../../lib/in-person-sale'

const PROCESSABLE = new Set(['pending', 'requires_more', 'authorized', 'captured', 'pending_authorization'])

completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  const cartId = (cart as any)?.id
  if (!cartId) return
  const inPerson: any = container.resolve(IN_PERSON_MODULE)
  const [claim] = await inPerson.listInPersonSales({ cart_id: cartId }, { take: 1 })
  if (!claim) return
  // A closed sale cannot become an order — except a CARD sale, whose provider authorizes
  // only a payment the processor confirmed: money already taken must still become its
  // order (never hidden). Transfer/cash authorize unconditionally, so after a cancel
  // they would mint a pending order the merchant closed (codex security lens, PR 218).
  if ((claim.status === 'cancelled' || claim.status === 'failed') && claim.kind !== 'card') {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This counter sale was closed.')
  }
  const sessions = (((cart as any)?.payment_collection?.payment_sessions ?? []) as Array<{ provider_id?: string; status?: string }>)
    .filter((s) => PROCESSABLE.has(String(s?.status)))
    .map((s) => String(s?.provider_id))
  // The cart must still be the sale the merchant rang up (lines + recorded total).
  if (!counterCartMatchesClaim(
    { total: (cart as any)?.total, items: ((cart as any)?.items ?? []) as any[] },
    { kind: String(claim.kind), payload_hash: String(claim.payload_hash), total_cents: (claim.metadata as any)?.total_cents },
  )) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'This counter sale changed after it was rung up.')
  }
  const refused = disallowedCounterProviders(String(claim.kind), sessions)
  if (refused.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `This counter sale cannot be completed with ${refused.join(', ')}.`,
    )
  }
})
