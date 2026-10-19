# G16 Technician Checklist Implementation Plan

> **For agentic workers:** executed inline (superpowers:executing-plans principles) in worktree
> `grays-internal-wt-g16`, branch `feat/ops-g16-tech-checklist`. Test first for every task.

**Goal:** Technicians scan a lot, see its order details, fill in the screen & electronics
checklist, record base + console serials and sign off "Screen OK to ship".

**Architecture:** One new server module `lib/techChecklist.js` (pure helpers + GET/PUT handler)
routed from `lib/handlers/lots.js` on `resource=tech-checklist`; one new table
`lot_checklists` (migration 0009, dev only, 42P01-tolerant); one new page
`src/pages/tech-checklist.js` reusing `CameraBarcodeScanner`; a read-only section in the Lot
Tracker. Spec: `docs/superpowers/specs/2026-10-19-tech-checklist-design.md`.

**Tech Stack:** React 19 CRA + Tailwind, Vercel functions, raw `pg`, node smoke scripts
(`scripts/*-smoke.mjs`, fake pg client), Jest + Testing Library.

## Global Constraints

- No new `api/` file (Hobby 12-function cap). Public `GET /api/lots?lot_number=` unchanged.
- Gate: roles `technician`, `workshop`, `superadmin`, or token user id `WK`; server-authoritative.
- No customer name/phone in the technician payload.
- Migration additive + idempotent + `_down`, Neon `dev` branch only.
- Sign-off never changes item status; logs `NOTE_ADDED` (existing enum label).
- Serial write-back format `"<base> & CONSOLE <console>"`; never erase on blank.
- Brand Red `#B50B1D` for the primary action; Australian English; Melbourne time.

## Tasks

### Task 1: Server module + route (test first)
**Files:** create `lib/techChecklist.js`, `scripts/ops-tech-checklist-smoke.mjs`; modify `lib/handlers/lots.js`.
**Produces:** `CHECK_ITEMS` (`[{key,label}]`), `AUDIO_SUBS` (`['jack','bt','spk']`),
`TECH_CHECKLIST_ROLES`, `WORKSHOP_ACCOUNT_ID = 'WK'`, `splitSerial(itemSn) → {base_serial, console_serial}`,
`combineSerial(base, console) → string|null`, `normaliseChecks(raw) → checks`,
`unansweredItems(checks) → string[]` (labels), `handleTechChecklist(req,res,client)`.
Smoke cases: gate (401/403 admin/staff/sales/logistics, 200 technician/workshop/superadmin,
admin-with-id-WK allowed); GET shape, no `customer_*` keys, SELECT-only; prefill split
(`"A & CONSOLE B"`, `"A"`, `"A & B"`, null); PUT save (BEGIN … COMMIT), stale 409 + current,
sign-off with unanswered → 400 + no write, sign-off stamps approver + one `NOTE_ADDED` row,
re-save while signed → no second log row, un-sign clears approver, write-back lot always and
`item_sn` only when on an item, blank serials → no serial UPDATE; validation (bad `v`, long
fields, NUL); 404 unknown lot; 42P01 GET `available:false` with lot/order, PUT 503 + ROLLBACK;
routed from `lots.js` before the public lookup.
Commit: `feat(ops): G16 tech checklist API`.

### Task 2: Migration 0009 (dev only)
**Files:** `db/migrations/0009_lot_checklists.sql`, `0009_lot_checklists_down.sql`.
Apply up on Neon `dev`, verify columns, apply down, verify gone, re-apply up. Commit with Task 1
or its own `feat(ops): G16 migration 0009 lot_checklists`.

### Task 3: Client utils + nav + page (test first)
**Files:** create `src/utils/techChecklist.js` (mirror of `CHECK_ITEMS`, `AUDIO_SUBS`,
`TECH_CHECKLIST_ROLES`, `WORKSHOP_ACCOUNT_ID`, `canUseTechChecklist(user, roles)`, `splitSerial`,
`unansweredItems`), `src/pages/tech-checklist.js`, `src/pages/__tests__/techChecklist.test.js`;
modify `src/utils/nav.js` (`tech-checklist` key + item), `src/App.js` (route),
`scripts/podium-nav-smoke.mjs`, smoke pins client/server lists equal.
Jest cases: not-allowed screen for admin; fake-camera scan → GET url + order card (invoice,
target completion, suburb/state, technician); banner when technician ≠ me; unassigned lot
message; sign-off checkbox disabled until all answered; Save → PUT body (checks, serials,
ok_to_ship, base_version); 409 → warning naming the other person + "Overwrite with mine" uses
the shown version; `available:false` → "not available yet", no form.
Commit: `feat(ops): G16 tech checklist page + nav`.

### Task 4: Lot Tracker read-only section
**Files:** modify `lib/lotJourney.js` (4th SELECT, 42P01 → null), `src/pages/lot-tracker.js`,
`scripts/ops-lot-tracker-smoke.mjs`, `src/pages/__tests__/lotTracker.test.js`.
Commit: `feat(ops): G16 checklist in the Lot Tracker`.

### Task 5: Verify
`npm run build` (CI=true), `npm run smoke`, `npx react-scripts test --watchAll=false`;
bump `podium-contrast-smoke` file-count pin for the new page. Code review, push, Preview, PR.
