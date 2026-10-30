/**
 * Capture an order's manual payment — the ONE implementation behind the seller's
 * «Pago recibido» (`confirm-payment`) and the counter's cash sale (in-person-sales D5).
 *
 * Takeover-safe: a payment that is already captured is not captured again, so a
 * retry that resumes after a crash between "order created" and "cash captured"
 * finishes the job instead of failing on a second capture.
 */
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { capturePaymentWorkflow } from '@medusajs/medusa/core-flows'

type Scope = { resolve: (key: string) => any }

export type CaptureOutcome =
  | { ok: true; captured_now: boolean }
  | { ok: false; reason: 'no_payment' }

export async function captureOrderPayment(scope: Scope, orderId: string): Promise<CaptureOutcome> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'order',
    fields: ['id', 'payment_collections.payments.id', 'payment_collections.payments.captured_at'],
    filters: { id: orderId },
  })
  const payment = (data?.[0] as any)?.payment_collections?.[0]?.payments?.[0]
  if (!payment?.id) return { ok: false, reason: 'no_payment' }
  if (payment.captured_at) return { ok: true, captured_now: false }
  await capturePaymentWorkflow(scope as any).run({ input: { payment_id: payment.id } })
  return { ok: true, captured_now: true }
}
