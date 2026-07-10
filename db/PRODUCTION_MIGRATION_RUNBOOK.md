# Production Migration Runbook

_Last updated 10 Jul 2026. Read this before running any migration against the Neon **production** branch (`br-floral-unit-ae0t5qvk`)._

> ## ✅ EXECUTED — 10 Jul 2026 (Option A, Nick-directed)
> Migrations **0001–0005** + the customer-type seed were applied to Production on
> 10 Jul 2026. Backup branch: **`backup-pre-ops-migration-2026-07-10`**
> (`br-noisy-mouse-aede2pyu`). Verified: all core-table row counts identical
> before/after (569 customers / 588 workorders / 1,047 items / 539 deliveries /
> 90 collections / 5,790 logs); customer types 377 Individual / 191 Business /
> 1 untagged (created after the reviewed snapshot); `user_roles` backfilled 18/18;
> `product_lots` empty with the sequence at 1. The section below is kept for
> context and for any FUTURE migration (next number: **0006**, Podium's).

## The situation (verified 10 Jul 2026)

There are **two parallel workstreams** adding schema through **one** shared, linearly-numbered migration sequence in `db/migrations/`:

- **Podium → CRM** (F-series): migrations `0001_podium`, `0002_lead_lost_reason`.
- **Ops upgrades** (G-series): `0003_customer_type` (G1), `0004_*` (G2), `0005_*` (G3) — reserved as they're built.

**Production is still on the bare pre-Podium base schema.** As of 10 Jul 2026 the production branch has:
- **No `schema_migrations` table** (the `npm run migrate` runner has never run there).
- **None** of the Podium objects: no `leads`, `user_roles`, `podium_oauth`, `integration_sync_log`, no `customers.podium_contact_id` / `myob_uid`, no `users.podium_user_id`.
- **None** of the G-series objects: no `customers.customer_type`.

The merged Podium code (F0–F13, on `main`, deployed to Production) tolerates this because it is **mock-first** (`PODIUM_MOCK=true`) and every DB read of a new table is **`42P01`-safe** (falls back when the table is absent). So Production runs today without the Podium schema — by design.

**Dev branch** (`br-late-boat-aeutfn5t`) has base + `0001` + `0002` + `0003` schema applied (its `schema_migrations` ledger records `0001` and `0003`; `0002` was applied via raw SQL and not recorded — a cosmetic gap, the objects exist).

## The consequence for the Ops (G-series) release

Because Production's migration ledger is **empty** and the runner applies **all pending migrations in filename order**, running `npm run migrate` on Production would apply **`0001` → `0002` → `0003` → `0004` → `0005` all at once** — i.e. it would activate the **entire Podium schema at the same time** as the Ops schema. You cannot, via the standard runner, ship the Ops DB changes to Production without also creating the Podium tables.

**This is safe but must be a conscious choice**, because:
1. Every migration is **additive + idempotent** (`IF NOT EXISTS`, guarded `CREATE TYPE`). Applying them in one pass creates tables/columns and nothing destructive.
2. The G-series migrations are **independent of Podium tables** — `customer_type` (on `customers`), `delivery_type`/flags (on `workorder`,`delivery`), `product_lots` (FKs `product`,`collections`,`workorder_items`). **None reference `leads`/`podium_*`.** This independence is a rule for all future G migrations.
3. Turning the Podium tables **on** while `PODIUM_MOCK=true` remains set is safe — the tables simply exist unused until Podium creds are wired and mock is disabled.

## Two release strategies

### Option A — One coordinated cutover (recommended)
Run the whole stack once, in a maintenance window, when doing the Production DB migration:

```
# 1. Back up / branch production first (Neon point-in-time branch).
# 2. Point DATABASE_URL at the PRODUCTION branch.
export DATABASE_URL="<prod connection string>"
# 3. Schema (creates schema_migrations, applies 0001..000N in order):
npm run migrate
# 4. Curated data seeds (run explicitly, in order, AFTER schema):
psql "$DATABASE_URL" -f db/seeds/0003_customer_type_backfill.sql
#    (+ any later G-series backfills, e.g. the tagged $0-delivery file, once returned)
# 5. Verify (row counts, customer_type distribution), then merge the PR stack.
```
Cleanest ledger; couples Podium + Ops DB go-live (schema only — Podium features stay mock-gated).

### Option B — Ops-only, ahead of the Podium DB go-live
Valid **only because every migration is additive/idempotent/independent.** Apply just the G-series schema + seeds by hand, and let `schema_migrations` record them out of numeric order; the Podium `0001`/`0002` remain "pending" and apply cleanly later:

```
export DATABASE_URL="<prod connection string>"
# Create the ledger + apply only G-series schema files, recording each version:
psql "$DATABASE_URL" -f db/migrations/0003_customer_type.sql
psql "$DATABASE_URL" -f db/migrations/0004_*.sql
psql "$DATABASE_URL" -f db/migrations/0005_*.sql
psql "$DATABASE_URL" -c "CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  INSERT INTO schema_migrations(version) VALUES ('0003_customer_type'),('0004_...'),('0005_...') ON CONFLICT DO NOTHING;"
# Data seeds:
psql "$DATABASE_URL" -f db/seeds/0003_customer_type_backfill.sql
# Later, when Podium goes live, `npm run migrate` applies the still-pending 0001/0002.
```
Use only if Ops must reach Production before Podium. Slightly messier ledger (0003 applied before 0001), harmless here because the files are order-independent.

## Rules that keep this safe (for all future migrations, both workstreams)
1. **One monotonic number line.** Never reuse a number. Current: `0001`,`0002` = Podium; `0003`,`0004`,`0005` = Ops G1–G3. **The next Podium migration starts at `0006`.**
2. **Schema in `db/migrations/`, curated data in `db/seeds/`.** The runner only executes `db/migrations/*.sql` (excluding `_down`). Seeds are run explicitly so a human owns the data step.
3. **Every migration additive + idempotent** (`IF NOT EXISTS`, guarded enums) with a paired `_down.sql`.
4. **G-series migrations never FK to Podium tables** (`leads`, `podium_*`, `user_roles`, `integration_sync_log`) — keeps Option B possible.
5. **Migrate-then-merge, per release.** Vercel deploys code on merge to `main`; run the migration on Production **before** merging the PR whose code depends on it, so code never hits a missing column.
6. **Always branch/backup Production in Neon before migrating.**

## Applied-state matrix (update as releases happen)

| Migration | Workstream | Dev | Production |
|---|---|---|---|
| 0001_podium | Podium | ✅ applied | ✅ 10 Jul 2026 |
| 0002_lead_lost_reason | Podium | ✅ applied (unrecorded) | ✅ 10 Jul 2026 |
| 0003_customer_type (+seed) | Ops G1 | ✅ applied + recorded | ✅ 10 Jul 2026 (seed: 568 rows) |
| 0004_delivery_type | Ops G2 | ✅ applied + recorded | ✅ 10 Jul 2026 |
| 0005_product_lots | Ops G3 | ✅ applied + recorded | ✅ 10 Jul 2026 |
