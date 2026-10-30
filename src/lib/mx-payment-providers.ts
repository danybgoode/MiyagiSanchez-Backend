/**
 * The payment providers the Mexico region must enable — ONE list, read by
 * `POST /internal/setup-mexico` (first-time setup) and
 * `POST /internal/mx-region-payment-providers` (the narrow live repair).
 *
 * Every provider checkout opens a session on belongs here: Medusa (since 2.20)
 * refuses to complete a cart whose provider its region does not enable. The guard
 * spec `setup-mexico/__tests__/region-providers-cover-checkout.unit.spec.ts` derives
 * start-checkout's providers from source and fails if one is missing.
 */
export const MX_PAYMENT_PROVIDERS = [
  'pp_system_default',
  'pp_stripe-connect_stripe-connect',
  'pp_mercadopago_mercadopago',
  'pp_spei_spei',
  'pp_cash_cash',
  // The unified «Pago directo» provider every manual checkout has opened its session on
  // since 2026-06-01 (start-checkout's manual branch). It was never added here, and
  // Medusa 2.21's `validate-cart-payments` refuses to complete a cart whose provider
  // the region does not enable — found 2026-10-30 (in-person-sales lock): the live
  // region listed every provider above except this one.
  'pp_manual_manual',
]
