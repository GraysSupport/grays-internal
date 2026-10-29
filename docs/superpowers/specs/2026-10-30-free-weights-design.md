# G21 — Brand New Free Weights stock (design, 30 Oct 2026)

Owner request (29 Oct 2026): a separate stock list for **brand new** free weights, kept per
individual weight (e.g. "Trigrip Olympic Rubber Weight" 1.25 / 2.5 / 5 kg …), as a second tab
on the Products page. Approved plan: `feature-plan-portal-2026-10-29.md` § G21 (agent folder).
Written during an autonomous scheduled run: the four open decisions are taken on the owner's
stated defaults and flagged in the PR + Notion report.

## Decisions (defaults, owner to confirm)
1. Sales are **not** linked to workorders/invoices — a manual "Sold" move with the invoice number.
2. Stock is counted **each** (per plate), with a "pairs" hint for plates.
3. Not shown on the public `/scan` page or the website.
4. **kg only** (`weight_kg`).

Agent decisions (flagged):
- **Access, server-enforced with the login token.** View + add/receive/adjust = any logged-in
  user who can open Products today, i.e. **not** a workshop login (technician / workshop
  without an office role, or the WK kiosk — the nav already hides Products from them, and
  `/api/products` writes are not gated at all today, so "same as Products" = every office
  login). Workshop logins get 403. **Unit cost and stock value at cost = superadmin only**
  (mirrors the Products cost column). A 401 sends the user to log in again (as the Lot
  Tracker does).
- Opening stock entered on "Add product line" is written as a `received` move
  ("Opening stock"), so every unit on hand has an audit row.
- Editing a line (name/brand/category/notes, per-weight price, cost, reorder level, SKU,
  adding weights) is included — prices could not be changed otherwise. Stock never changes
  through an edit, only through a move. Weights are retired (`active=false`), never deleted.

## Approaches considered
- **A (chosen):** new `lib/freeWeights.js` + `case 'free-weights'` in the `api/[...path].js`
  catch-all, query-form `?resource=` (house convention, no new serverless function).
- B: extend `handleProducts` in the catch-all — mixes two unrelated stocks in one 600-line file.
- C: new `api/free-weights.js` function — forbidden (function budget; plan says catch-all).

## Data — migration `0011_free_weights` (+ `_down`), Neon **dev** only
- `free_weight_products` (id, brand, name, category CHECK in plate/bumper/dumbbell/kettlebell/
  bar/collar/other, notes, active, created_by/at, updated_by/at; UNIQUE lower(brand), lower(name)).
- `free_weight_variants` (id, product_id FK, weight_kg numeric(6,2) > 0, sku, stock int ≥ 0,
  price numeric(10,2) ≥ 0 GST-inc, unit_cost numeric(10,2) NULL, reorder_level int NULL,
  active, timestamps; UNIQUE (product_id, weight_kg)).
- `free_weight_stock_moves` (id, variant_id FK, delta int ≠ 0, reason CHECK in received/sold/
  adjustment/damaged/returned, reference, note, user_id varchar(2), at).
- Code is `42P01`-safe: list → `available:false` (tab says "not set up on this database
  yet"); writes → 503. Prod is migrated by the owner at merge time.

## API — `/api/free-weights?resource=…` (token required; workshop logins 403)
| Method + resource | Does |
|---|---|
| `GET list` | every product line with its weights; `unit_cost` + `stock_value_cost` only for superadmin; `can_see_cost` flag |
| `POST product` | create a line + weight ladder (+ opening stock as `received` moves), one transaction |
| `PUT product&id=` | edit line fields; upsert weights by `weight_kg` (price, cost*, reorder, sku, active). Never touches stock. *cost ignored unless superadmin |
| `POST move` | `{variant_id, qty, reason, reference, note}`; sign from reason (received/returned +, sold/damaged −, adjustment takes a signed qty); `SELECT … FOR UPDATE`; below zero → 409 with stock on hand |
| `GET moves&variant_id=` | last 200 moves, newest first, with user names |

Validation: weights 0.25–500 kg, max 2 decimals, no duplicates; prices ≥ 0 with ≤ 2 decimals;
qty a whole number 1–10,000; reference/note ≤ 200/500 chars; NUL stripped.

## Screen
`/products` gets two tabs: **Current stock** (unchanged) and **Brand New Free Weights**
(`?tab=free-weights`, survives refresh, linkable). Tab component `FreeWeightsTab`:
search (brand / name / weight, e.g. "20kg"), category filter, "Low stock only"; one card per
line with weight chips (weight · on hand · price), low (≤ reorder level) and out-of-stock
chips labelled in text + icon, not colour only; totals: units on hand (+ value at cost for
superadmin); "+ Add product line" (ladder presets: plates 1.25/2.5/5/10/15/20/25 kg; dumbbells
2.5–50 kg in 2.5 kg steps — editable); per weight "Receive", "Adjust/Sold", "History"; CSV
export of the filtered list (cost column superadmin only). Copy says "Brand New" — never
"used", "second-hand" or "refurbished". Prices `$1,795` / `$12.50` (AUD, GST-inclusive).
Primary buttons Brand Red `#B50B1D`.

## Testing
- `scripts/ops-free-weights-smoke.mjs` (fake pg client): auth (401/403 workshop/WK), cost
  hidden for non-superadmin, create + opening moves in one transaction, move sign rules,
  never below zero, FOR UPDATE used, 42P01 behaviour, validation, edit never writes stock.
- Jest: `src/utils/freeWeights.js` pure helpers (money, kg, ladders, filter, CSV, status) and
  the tab (tabs + URL, list render, low-stock label, cost hidden, add form, receive flow, 401).
- Migration up/down on the Neon dev branch.

## Out of scope
Workorder/invoice integration, website/scan display, lbs, deleting lines, G22 tile.
