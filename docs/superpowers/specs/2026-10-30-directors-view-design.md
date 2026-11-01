# G22 — Director's View (design, 30 Oct 2026) · this PR = G22a sales team + the shell

Owner request (29 Oct 2026): a superadmin-only "Director's View" with performance statistics.
Approved plan: `feature-plan-portal-2026-10-29.md` § G22 (agent folder). Phases, one PR each:
**G22a sales team (this PR, also ships the shell)** → G22b products/profit → G22c deliveries &
removalists → G22d overview tiles. Written during an autonomous run; open decisions are taken on
the owner's stated defaults and flagged in the PR + Notion report.

## Decisions (defaults, owner to confirm)
1. Money is shown **GST-inclusive as stored**, footnoted. No ex-GST toggle.
2. **Superadmin only**. Salespeople don't see their own numbers.
3. No commission rules.
4. (G22c) Every removalist with jobs in the period is shown.
Agent decisions (flagged):
- A workorder is "in the period" by `workorder.date_created` (Melbourne date).
- "Outstanding balance" = the sum of `outstanding_balance` on that salesperson's **open**
  (`Work Ordered`) workorders created in the period. It is a snapshot as of today.
- "Completed" time = the first `WORKORDER_COMPLETED` log entry (523 of 527 completed WOs on dev
  have one). WOs without one are left out of the days and on-time figures and counted in the
  coverage line.
- On-time = completed on or before `estimated_completion` (Melbourne date).
- The e-commerce flag is set on 535 of 570 dev workorders, so the flag looks unreliable. Shown
  with that caveat, never used to filter.

## Shell
- Dashboard: a **"Director's View"** button, shown only when the login's roles include
  `superadmin` (display only).
- Route `/director` (`src/pages/director.js`). A non-superadmin sees "Superadmin only" and makes
  no call. A 401 sends the user to log in again.
- Period picker: **Australian financial year (1 Jul – 30 Jun), the current one by default**;
  previous FY, calendar year, last 12 months, this month, custom range. "Compare with the
  previous period" (on by default) shows ▲/▼ against the same-length period immediately before.
- Every section carries a **data-coverage line**. Money footnote: "AUD, GST-inclusive as
  stored". `$1,795` style (no decimals on whole dollars).
- Charts are CSS bars (no chart library in the repo; none added).

## API — `GET /api/director?resource=…` (catch-all, no new function)
- **Server-checked superadmin** on every request (`requireRoles(['superadmin'])`; 401/403).
- **Read-only by construction:** every request runs inside `BEGIN TRANSACTION READ ONLY` …
  `COMMIT`, so Postgres itself refuses any write. The smoke proves every statement is a
  SELECT/WITH and that the read-only transaction wraps them.
- `Cache-Control: private, max-age=300`.
- `resource=sales&from=YYYY-MM-DD&to=YYYY-MM-DD[&compare=1]`: `to` inclusive. A range of 1 day to
  5 years.
  Per salesperson (`workorder.salesperson` → `users.name`): workorders, open, completed,
  **invoices** (distinct `invoice_id` — not unique across WOs), units, **sales value**
  (Σ qty × COALESCE(selling_price, custom_unit_price, product.price), Canceled lines excluded),
  priced/estimated/unpriced line counts, average order value (sales ÷ workorders), **gross
  profit + margin** on lines with a known cost (COALESCE(avg lot unit_cost, product.avg_cost);
  never treated as zero), delivery charged vs carrier cost (`delivery_quoted`, Customer Collect
  excluded), **free deliveries** (charged $0: count + carrier cost absorbed), outstanding
  balance on open WOs, average days created → completed, on-time %, e-commerce count; monthly
  sales value per salesperson; totals; a coverage block; and `previous` (the same figures for the
  previous period) when `compare=1`.
- `resource=sales-workorders&salesperson=XX&from&to`: the drill-down list (WO, invoice, date,
  status, value, balance) with links to `/delivery_operations/workorder/:id`.

## Testing
- `scripts/ops-director-smoke.mjs` (fake pg): 401/403 for every non-superadmin role incl. WK;
  read-only transaction + SELECT-only statements; date validation; the shaping maths (AOV,
  margin, on-time, coverage, previous-period range); the cache header; unknown resource.
- Jest: `src/utils/director.js` (FY maths, period presets, previous period, change ▲/▼, money)
  and the page (guard, button on the dashboard for superadmin only, table, coverage lines,
  compare, drill-down, 401).
- The real SQL is run read-only against the Neon dev branch before PR (figures quoted in the
  report).

## Out of scope (later phases)
G22b–d; ex-GST toggle; commission; salesperson self-view.

## G22d — business overview tiles (31 Oct 2026, scheduled run)
A "Business overview" block at the top of `/director`, above the section tabs, for the chosen
period (same picker + compare). `GET /api/director?resource=overview&from&to[&compare]` — same
superadmin gate, read-only transaction, private 5-minute cache.
- **Period tiles:** sales (vs previous, priced/estimated line coverage); gross profit + margin
  (costed lines only, labour not included); delivery net margin (comparable jobs only, vs
  previous); workshop items completed (first "Completed" status log in the period, item still
  Completed; vs previous) + average days `in_workshop` → completed (only items with a workshop
  start) + items in the workshop now; on-time completion %; customers (individual / business /
  not set, new = first-ever workorder in the period — history starts at the oldest workorder);
  sales by the workorder's delivery state (customers hold no state).
- **"Today" tiles (snapshots):** open-order pipeline (live lines on `Work Ordered` WOs); money
  still owed (positive balances on all non-cancelled WOs, and on open ones; credits counted,
  never netted); stock value at cost (+ Brand New Free Weights at cost, only when its tables
  exist — checked with `to_regclass` first so the read-only transaction never aborts).
- A cancelled workorder (G23, migration 0012, not yet on main) is compared as text
  (`status::text IS DISTINCT FROM 'Cancelled'`), safe before and after that migration.
- Tiles with a section (sales, products, deliveries) are buttons that open it.
- No migration. One new component (`DirectorOverview.js`) → contrast pin 75 → 76.
