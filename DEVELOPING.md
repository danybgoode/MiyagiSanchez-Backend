# Developing

The [Medusa v2](https://docs.medusajs.com) commerce engine for
[Miyagi Sánchez](https://miyagisanchez.com) — a multi-seller marketplace where anyone in Mexico
can open a shop and sell with no commission, across the marketplace, their own domain, an
embeddable widget, or to AI shopping agents. This repo owns **every commerce primitive**:
products, orders, cart/checkout, payments, fulfillment, returns, regions, and the custom modules
that extend Medusa for this marketplace.

This repo is part of the Miyagi Sánchez platform; the product roadmap and cross-repo practice live in the
root docs repo, [`MiyagiSanchez-Product`](https://github.com/danybgoode/MiyagiSanchez-Product).

## What this repo owns

Custom modules under `src/modules/`, on top of the standard Medusa commerce modules:

- `seller` — shops/sellers/vendors (not `@medusajs/marketplace` — no such plugin is used)
- `subscriptions` — recurring seller offerings
- `profit` — the per-sale margin ledger ("Ganancias")
- `mercadolibre` — Mercado Libre catalog/order sync
- `fulfillment-envia` — Envía.com shipping (Estafeta live)
- `auth-clerk` — validates the frontend's Clerk JWTs so Medusa can identify customers
- Payment providers: `payment-stripe-connect`, `payment-mercadopago`, `payment-spei`,
  `payment-manual`, `payment-manual-mx`, `payment-cash`

## Practice

Follows the same gitflow, risk-tiered PR review, and deterministic-gate discipline as the rest of
the platform — see [`Roadmap/WAYS-OF-WORKING.md`](https://github.com/danybgoode/MiyagiSanchez-Product/blob/main/Roadmap/WAYS-OF-WORKING.md)
in the root repo. This repo's own deterministic gate is `medusa build` (which also generates the
`.medusa/types` that `tsc` needs) → `tsc --noEmit` → `npm run test:unit`, required on every PR.

## Deploy

Merging to `main` builds `ghcr.io/danybgoode/miyagisanchez-backend:main` (arm64, GitHub Actions). It deploys nothing by
itself: production runs on the Oracle VM, and `/opt/miyagi/infra/oci/update.sh` (in MiyagiSanchez-Product)
pulls the new image, restarts, and posts the 🚀 Telegram pair of the merge's 📦.

## Quickstart

```bash
npm install
npx medusa db:migrate
npm run dev   # medusa develop, :9000
```

Open the admin dashboard at `localhost:9000/app`. Needs a Postgres `DATABASE_URL`, Stripe /
MercadoPago credentials, and `CLERK_SECRET_KEY` (validates the frontend's JWTs) — see the full env
list in the frontend repo's `AGENTS.md`.

Other scripts: `npm run build` (`medusa build`), `npm run test:unit`, `npm run
test:integration:http` / `test:integration:modules` (need Postgres).
