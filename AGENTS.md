# Agent index — medusa-bonsai-backend (the commerce engine)

> **Read this before touching anything here.** Auto-loaded by Codex and (via `CLAUDE.md`) by Claude.
> Keep it SHORT — a file long enough to skim is a file nobody reads twice.

## What is this?

**Medusa v2** — the commerce engine behind miyagisanchez.com, a multi-seller P2P marketplace for
Mexico. It owns products, carts, checkout, orders, payments, fulfillment, inventory and regions. The
Next.js storefront (`apps/miyagisanchez`, a **separate repo**) is a client of this.

```
src/
├── api/          ← 109 route.ts handlers (store/, admin/, internal/) + _utils/ (the testable half)
├── modules/      ← 13 Medusa modules — each with service.ts, its own models + migrations
├── workflows/    ← Medusa workflows (multi-step, compensatable)
├── links/        ← module-to-module links (how modules reference each other)
├── subscribers/  ← event handlers    jobs/ ← scheduled     lib/ ← shared logic (flags, clients)
```

**Deploy:** production runs on the Oracle VM `panfleto-prod` (epic `miyagi-to-oracle-vm`, cut over 2026-10-16; the
Cloud Build → Cloud Run rail is **deleted**). Merging to `main` builds `ghcr.io/danybgoode/medusa-web:main` on an arm64
runner (`.github/workflows/image-arm64.yml`) and **deploys nothing by itself**: once that build is green, run
`ssh ubuntu@159.54.158.4 /opt/miyagi/infra/oci/update.sh` (root repo `infra/oci/`). It resolves `:main` to a
digest, runs migrations on boot, and a `MEDUSA_PIN` line in `.env` rolls back. `cloudbuild.yaml` is no longer deployed.
There is **no per-branch preview** — this repo can only be verified post-merge against production.
Say that split in every PR: the agent owns API-level prod smoke, Daniel owns the seller/browser parts.

## Start here

- **`Roadmap/WAYS-OF-WORKING.md`** (repo container root, two levels up) — cadence, gitflow, Definition
  of Done, the review stack. Follow it.
- **`Roadmap/LEARNINGS.md`** — distilled wisdom from every past epic. Read it.
- The frontend's **`apps/miyagisanchez/AGENTS.md`** — the five cross-cutting rules in full; the
  commerce/agent contract is shared and this repo is the enforcement half of it.

---

## ⚠️ Rules that cannot be violated here

### 1. Medusa owns commerce — use its primitives, never hand-roll around them.
Products, carts, orders, payments, fulfillment, inventory, regions. If you are writing bespoke
order-state or price maths outside a Medusa module/workflow, stop — the primitive exists. Research the
Medusa v2 docs before inventing; retrofitting later is the expensive path.

### 2. Supabase is ONLY for non-commerce data.
Conversations, offers, favorites, supply/scrape imports, UCP identity/trust, and `platform_flags`.
Commerce state lives in Medusa's own Postgres. Never mirror commerce into Supabase.

### 3. This is the ENFORCEMENT half of every guard.
The storefront can hide a rail in the UI, but **agents, UCP/MCP clients and stale in-flight checkout
pages hit these routes directly**. A check that exists only in the frontend does not exist. Any rule
about who may do what must be enforced here.

### 4. Authorization is per-object, never merely "is signed in".
Every route that reads or writes a resource by id must prove the caller owns it — scope the query by
seller/shop/owner. IDOR is the single most repeated real defect in this codebase's history.

### 5. Flags FAIL-OPEN, deliberately — so a flag is not a security boundary.
`src/lib/flags.ts` falls back to `DEFAULT_FLAGS` when Supabase is unreachable, because a flag store
outage must not take down commerce. Consequence: **never use a flag as the only thing standing between
a caller and a privileged action.** Use it to gate a *feature*; use an authorization check to gate
*access*.

---

## How to write code that belongs here

**Extract the logic, then test the extract.** Route handlers are thin; the real work lives in
`src/api/**/_utils/*.ts` and `src/lib/*.ts` as pure functions. That is why 45 spec files can run
DB-free in seconds. A new route that buries its logic inline is untestable by construction — pull the
decision into a `_utils` function and unit-test that.

**Resolve from the container, do not import singletons.**
`const svc: SellerModuleService = req.scope.resolve(SELLER_MODULE)`. Cross-module reads go through
`req.scope.resolve('remoteQuery')` + `remoteQuery.graph({ entity, fields })`, not direct DB access.

**Comments carry the WHY.** Nearly every non-obvious constant and guard here records a real incident.
Preserve that reasoning when you touch it — it is the only thing stopping the next person deleting the
rule as noise.

**A read is not a claim.** Reading a row, awaiting, then writing is **not** atomic: two concurrent
requests both read "not yet done" and both act. Make the write conditional and check how many rows it
matched. This has bitten this codebase repeatedly.

---

## Traps — things that look right and are not

- **`medusa build` must run BEFORE `tsc --noEmit`.** The build generates `.medusa/types` that the
  type-check depends on. CI does Build → Type-check → Unit in that order for this reason.
- **`src/lib/__tests__/dockerfile-lockfile.unit.spec.ts` FAILS unless `npm run build` ran first** — it
  asserts against `.medusa/server/package.json`. A local red there is usually your environment, not a
  regression. Build, then re-run.
- **There is NO integration test tier.** Two scripts used to imply one: `test:integration:http` matched
  a directory that never existed and exited 0, and `test:integration:modules` was a second label over
  the unit suite. Both were deleted (2026-07-26). Do not resurrect them without real Postgres+Redis in
  CI — an honest absence beats a false gate.
- **`require-atomic-updates` is a WARNING with six known live sites**, listed in `eslint.config.mjs`
  (`backfill-sales-channel`, `fulfillment.ts` ×2, `ml-order-materialize.ts` ×3). They are read-then-write
  caches, very likely benign, and **not yet fixed** — each fix changes caching on live commerce paths.
  Do not "clean them up" casually; that is a deliberate, reviewed change.
- **Migration filenames must have a UNIQUE 14-digit version.** `schema_migrations` is keyed by version,
  so two files sharing one means only one is ever recordable. There is already one such collision
  (`20260711120000`).
- **Never `supabase db push`.** The orchestrator applies migrations and realigns `schema_migrations`.

## The gate — how you know you are done

```bash
npm run build        # medusa build — also generates the types tsc needs
npx tsc --noEmit
npm run lint         # eslint (added 2026-07-26 — this repo had NO static analysis before)
npm run test:unit    # jest, DB-free
```
CI runs exactly this, and `Type-check + build + unit` is a **required status check** on `main`.
Plus the story Definition of Done in `WAYS-OF-WORKING.md` — including **every new spec observed failing
at least once** via a deliberate mutation. A spec never seen red is not known to test anything.

## If you are a delegated subagent

1. **Never push, open a PR, merge, or apply a migration.** Return a diff and a report; the orchestrator
   verifies and lands it.
2. **If the task rests on a false premise, STOP and say so.** Reporting it is a successful outcome — it
   has already saved a build this month. Working around it silently is the failure this codebase has
   been bitten by most.
