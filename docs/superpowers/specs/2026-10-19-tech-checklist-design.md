# G16 — Technician screen & electronics checklist (design)

Requested by Nick, 19 Oct 2026 (interactive). Approved design, 19 Oct 2026.

## Problem

Technicians fill in a paper "Screen & Electronics Checklist" tag for cardio machines with
consoles (front: checklist + S/N; back: order #, "Screen ok to ship?", date, approved). The
portal has no record of it, and serial numbers live in one free-text field per workorder
item (`workorder_items.item_sn`), where base and console serials are typed together
(`"AKCGG1119D060 & CONSOLEAZBRE06195052"`). Only 228 of 1,466 items have any serial.

## Decisions (Nick, 19 Oct 2026)

| Question | Answer |
|---|---|
| Where do base + console serials go? | **Both**: separate fields on the checklist AND written back to the workorder item (`item_sn`) and the lot (`product_lots.serial_number`) as `"<base> & CONSOLE <console>"`. Pre-filled from the existing `item_sn`. |
| Who can use it? | **Technician, workshop, superadmin, and the shared WK account** (WK is an `admin` login on prod, so it is allowed by user id, same as `nav.js` already routes WK to `/workshop`). Admin sees the result **read-only** in the Lot Tracker. |
| Does sign-off change item status? | **No.** Record only: who/when + one `NOTE_ADDED` workorder log line. |
| Lots assigned to another technician? | **Open, with a warning banner** ("Assigned to Ed, not you"). |

## What the technician does

Page `/tech-checklist` (nav item "Tech Checklist"):

1. **Scan** a lot sticker — phone camera (`CameraBarcodeScanner`), USB/Bluetooth scanner
   (types + Enter) or typed. `?lot=` kept in the URL.
2. **Order card (read-only):** product + SKU, lot number + status, workorder #, invoice ID,
   target completion (`workorder.estimated_completion`), item status, delivering to suburb +
   state, assigned technician. **No customer name/phone** — technicians don't need it.
   Unassigned lot → "Not assigned to an order yet".
3. **Checklist**, matching the tag. Each line: **Yes / N/A** + optional fault/comment:
   Boots OK · Touch & Cal · Screen Cont. · Heart Rate · Ergo/Tog Cont. · Wifi Connect ·
   BT Connect · Audio (+ sub-ticks 3.5 / BT / SPK) · Rem Ads / De-Reg · Rem Old Chg Cables ·
   Chk USB Corrosion · F/W Update · Reset to Metric · Test & Tag No. (text) ·
   Comments (multi-line).
4. **Serials:** Base S/N + Console S/N.
5. **"Screen OK to ship"** sign-off → stamps approver + Melbourne date/time.
6. **Save** (Brand Red). Shows "last saved by X, when". Stale save → warning with the other
   person's name, and "Overwrite with mine" saves on the version shown (no blind force).

## Data

Migration `0009_lot_checklists` (+ `_down`), **Neon dev branch only**; prod is Nick's call at
merge time. Additive, idempotent.

```
lot_checklists
  lot_id             INTEGER PK  → product_lots(lot_id)
  workorder_items_id INTEGER NULL → workorder_items  (item at last save)
  checks             JSONB NOT NULL DEFAULT '{}'   { <key>: { v: 'yes'|'na'|null, note }, audio: {…, jack, bt, spk} }
  test_tag_no        TEXT
  base_serial        TEXT
  console_serial     TEXT
  comments           TEXT
  ok_to_ship         BOOLEAN NOT NULL DEFAULT false
  approved_by        VARCHAR(2) → users(id)
  approved_at        TIMESTAMPTZ
  created_by/at, updated_by/at, version INT NOT NULL DEFAULT 1
```

One checklist per lot (the physical machine). Checklist keys are defined once in
`lib/techChecklist.js` and mirrored in `src/utils/techChecklist.js`; a smoke pins them equal.

## API (no new serverless function)

Routed first in `lib/handlers/lots.js` on `resource=tech-checklist` (public `?lot_number=`
lookup untouched). Module `lib/techChecklist.js`.

- `GET /api/lots?resource=tech-checklist&lot_number=L00042` →
  `{ available, lot, order|null, checklist|null, prefill:{base_serial, console_serial} }`.
  SELECTs only.
- `PUT /api/lots?resource=tech-checklist` body
  `{ lot_number, checks, test_tag_no, base_serial, console_serial, comments, ok_to_ship, base_version }`.
  One transaction: lock the lot → version-guarded upsert (stale → 409 + current) → write
  serials back (lot always; `item_sn` only when the lot is on a workorder item; nothing is
  erased when both serials are blank) → on a **new** sign-off, one `NOTE_ADDED` log row.
- Gate (both): `requireRoles(['technician','workshop','superadmin'])` OR token user id `WK`.
  401 no/expired token, 403 other roles.
- Validation: unknown keys dropped; `v` must be `yes|na|null`; notes ≤ 200 chars, comments ≤
  2000, serials ≤ 60, test-tag ≤ 30; NUL stripped. **Sign-off requires every line answered**
  (Yes or N/A) → else 400 listing what's missing. Un-ticking sign-off clears approver.
- `42P01` (table not migrated): GET → `available:false` + lot/order (page shows "Checklist not
  available yet"); PUT → 503. No other error is swallowed.

Lot Tracker (`lib/lotJourney.js`, admin + superadmin): journey gains `checklist` (one extra
SELECT, 42P01 → null) and the page shows a read-only "Screen & electronics checklist" section.

## Testing (failing first)

- `scripts/ops-tech-checklist-smoke.mjs` (fake pg client): role gate incl. WK-by-id and admin
  403; GET shape + no customer fields + SELECT-only; serial split/combine; save + version
  conflict; sign-off validation, approver stamp, single log row, un-sign; write-back targets;
  42P01 GET/PUT; key lists equal client/server.
- Jest `src/pages/__tests__/techChecklist.test.js`: scan → order card, banner for another
  technician, sign-off disabled until all answered, save payload, 409 warning.
- Nav smoke: item shown for technician / WK / superadmin, hidden for admin/staff/sales.
- Lot Tracker smoke updated for the extra SELECT.

## Rules added by code review (19 Oct 2026)

- **Multi-machine items.** A workorder item can carry several lots (13 prod items, up to 9),
  but `item_sn` is one text field for the item. So `item_sn` is read for prefill and written
  back **only when the lot is the item's only lot**; otherwise the serial goes to the lot only
  and the page says so. Prefill = item serial for a single-lot item, else the lot's own serial.
- **Serials only change when the technician changes them.** The page sends `serials_shown`;
  the server writes serials back only when the submitted pair differs from it (so ticking boxes
  never rewrites, or reverts, a serial corrected on the workorder page). Stored upper-case.
  A first serial starting with "CONSOLE…" stays the base; only a later "& CONSOLE…" part (or our
  own "CONSOLE X" console-only form) is the console.
- **Drafts.** Unsaved edits are kept per lot in the browser (`grays.techChecklist.draft.<lot>`)
  and restored with a notice — the WK kiosk is never logged out but its 1h token expires, so a
  Save can bounce to the login page. Cleared on save / discard.
- A late save answer for a lot no longer on screen is ignored; Enter in a text box never saves
  (only the Save button does); withdrawing a sign-off also logs a `NOTE_ADDED` line.
- Kept as designed: a later edit by someone else keeps the original approver (the log records
  both); the "assigned to someone else" banner shows for technician logins only; a checklist
  stays with the lot (the machine) if it is reassigned.

## Out of scope

Printing a tag, photos, making serials mandatory, changing item status, a checklist history
(only the latest state + last editor is kept; sign-off is logged).
