import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const REDIS_URL = process.env.REDIS_URL

// Redis-backed infrastructure modules. Gated on REDIS_URL so local dev without a
// Redis still works (Medusa falls back to its in-memory simulated cache / event
// bus / workflow engine). In production (GCP) REDIS_URL points at Memorystore —
// required for durable, retryable workflows, a shared cache, distributed locking
// (so scheduled jobs don't double-fire across instances), and for eventually
// splitting the worker into its own service.
const redisModules = REDIS_URL
  ? [
      {
        resolve: '@medusajs/medusa/cache-redis',
        options: { redisUrl: REDIS_URL },
      },
      {
        resolve: '@medusajs/medusa/event-bus-redis',
        options: { redisUrl: REDIS_URL },
      },
      {
        resolve: '@medusajs/medusa/workflow-engine-redis',
        options: { redis: { url: REDIS_URL } },
      },
      {
        resolve: '@medusajs/medusa/locking',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/locking-redis',
              id: 'locking-redis',
              is_default: true,
              options: { redisUrl: REDIS_URL },
            },
          ],
        },
      },
    ]
  : []

module.exports = defineConfig({
  admin: {
    // Enabled in production. Was previously disabled for Render's 512MB limit;
    // Cloud Run has headroom. Set DISABLE_MEDUSA_ADMIN=true to turn it back off.
    disable: process.env.DISABLE_MEDUSA_ADMIN === 'true',
    // No hard-coded fallback: the admin is served by this same backend at /app,
    // so when backendUrl is undefined the static bundle defaults to same-origin
    // ("/"). Forcing 'http://localhost:9000' here would bake localhost into the
    // production bundle at build time (the Docker build has no runtime env),
    // breaking every admin API call. Only set MEDUSA_BACKEND_URL when the admin
    // is hosted on a domain separate from the backend.
    backendUrl: process.env.MEDUSA_BACKEND_URL,
  },
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: REDIS_URL,
    // 'shared' (default) runs API + jobs in one process. On GCP set to 'server'
    // on the Cloud Run web service and 'worker' on a separate worker service.
    workerMode: process.env.MEDUSA_WORKER_MODE as
      | 'shared'
      | 'worker'
      | 'server'
      | undefined,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || 'supersecret',
      cookieSecret: process.env.COOKIE_SECRET || 'supersecret',
    },
  },

  modules: [
    // ── Redis-backed infra (cache, event bus, workflow engine, locking) ─────────
    // Empty in local dev (no REDIS_URL) → Medusa uses in-memory defaults.
    ...redisModules,

    // ── Fulfillment providers ──────────────────────────────────────────────────
    {
      resolve: '@medusajs/medusa/fulfillment',
      options: {
        providers: [
          {
            resolve: '@medusajs/fulfillment-manual',
            id: 'manual',
            options: {},
          },
          // Envia.com multi-carrier shipping for Mexico (provider_id: envia_envia)
          {
            resolve: './src/modules/fulfillment-envia',
            id: 'envia',
            options: {},
          },
        ],
      },
    },

    // ── Payment providers ──────────────────────────────────────────────────────
    {
      resolve: '@medusajs/medusa/payment',
      options: {
        providers: [
          // Stripe Connect Express — sellers get paid directly, 0% platform fee
          // Custom provider: handles Stripe Checkout redirect + transfer_data
          {
            resolve: './src/modules/payment-stripe-connect',
            id: 'stripe-connect',
            options: {
              apiKey: process.env.STRIPE_SECRET_KEY,
              webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
            },
          },
          // MercadoPago — preferred payment method in Mexico
          {
            resolve: './src/modules/payment-mercadopago',
            id: 'mercadopago',
            options: {
              accessToken: process.env.MP_ACCESS_TOKEN,
            },
          },
          // Unified manual payment ("Pago directo") — SPEI / DiMo / cash at pickup.
          // Sub-type is data on the payment, not a separate provider.
          {
            resolve: './src/modules/payment-manual',
            id: 'manual',
          },
          // Legacy single-method manual providers — kept registered for any
          // in-flight orders; new checkouts route through pp_manual_manual.
          {
            resolve: './src/modules/payment-spei',
            id: 'spei',
          },
          {
            resolve: './src/modules/payment-cash',
            id: 'cash',
          },
        ],
      },
    },

    // ── Seller module (custom multi-vendor) ────────────────────────────────────
    {
      resolve: './src/modules/seller',
    },

    // ── Subscriptions module (recurring billing — Stripe + MP + SPEI) ─────────
    {
      resolve: './src/modules/subscriptions',
    },

    // ── Mercado Libre module (connect + product↔ML-item linkage + sync) ───────
    {
      resolve: './src/modules/mercadolibre',
    },

    // ── Profit module (append-only financial-events ledger) ────────────────────
    {
      resolve: './src/modules/profit',
    },

    // ── In-person module (counter-sale exactly-once claims; payment links in S4) ──
    {
      resolve: './src/modules/in-person',
    },

    // ── Auth providers ─────────────────────────────────────────────────────────
    {
      resolve: '@medusajs/medusa/auth',
      options: {
        providers: [
          // Default email+password provider — required for admin login
          {
            resolve: '@medusajs/auth-emailpass',
            id: 'emailpass',
            options: {},
          },
          // Clerk JWT bridge — validates Clerk tokens so the frontend can call
          // Medusa Store API without a separate Medusa login.
          {
            resolve: './src/modules/auth-clerk',
            id: 'clerk',
            options: {
              clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
              clerkSecretKey: process.env.CLERK_SECRET_KEY,
            },
          },
        ],
      },
    },
  ],
})
