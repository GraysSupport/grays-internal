# G27 — Before-refurbishment photos per lot (design)

Owner request, 10 Nov 2026 (interactive): "upload a picture of the equipment before the
refurbishment process … when I start tagging the item as sold … based on the lot number or
workorder item id similar to how dispatch evidence works. This will help in both creating
evidence before/after as well as helping the technicians work out the parts and how it was
assembled before they take them apart." Design approved by the owner the same day. Built
before G25 (G25 is on hold; it moves to migration 0014).

## Owner decisions (10 Nov 2026)
1. **Folder:** next to dispatch evidence — a `Before refurbishment - Lot <lot>` folder inside the
   item's dispatch-evidence folder.
2. **When:** any time, even while the lot is In Stock.
3. **Screens:** workorder lot row (upload + view), Lot Tracker (upload + view), Tech Checklist
   (view only).
4. **Who:** same as dispatch evidence — upload = logistics, admin, superadmin, technician,
   workshop + the WK kiosk (by id); delete = superadmin only; view = any logged-in user.

Decisions 1 + 2 conflict for an In Stock lot (no workorder folder yet). Resolution (approved):
- In Stock / not on a workorder → `<MS_EVIDENCE_FOLDER>/In-stock lots/Lot <lot> <SKU>`
- Assigned → `<MS_EVIDENCE_FOLDER>/<invoice> - WO <id>/<item> - item <id>/Before refurbishment - Lot <lot>`
- When the lot's place changes (assigned / released / reassigned) the lot's ONE folder is moved
  (Graph move, same drive, files kept) the next time anyone opens or uploads that lot's before
  photos. The lot assign/unassign endpoints are NOT touched — tagging never waits on Microsoft.
- Photos are keyed to the lot in the DB, so they follow the machine. One folder per lot (an
  item with qty 3 has 3 lot folders).

## Data — migration `0013_lot_photos` (Neon DEV only; additive, `_down` paired)
- `lot_photo_folders` — `lot_id` PK, `drive_item_id`, `name`, `web_url`,
  `workorder_items_id` (where the folder currently sits; NULL = In-stock lots area),
  `created_by`, `created_at`, `moved_at`.
- `lot_photos` — `id`, `lot_id`, `workorder_items_id` (the lot's item at upload time, nullable),
  `drive_item_id` UNIQUE, `file_name`, `mime_type`, `size_bytes`, `web_url`, `uploaded_by`,
  `uploaded_at`, `deleted_by`, `deleted_at` (soft delete; file → SharePoint recycle bin).
- No FKs (same reasoning as 0009/0010). Code is 42P01-safe until prod is migrated:
  list → `available:false` (panels hide), writes → 503.

## API — `/api/evidence` (same router, no new serverless function)
- `GET  ?resource=before-list&lot_id=` — lot + recorded photos (+ thumbnails); moves the
  folder first when its place is out of date (best effort; failure never breaks the list).
- `POST ?resource=before-upload-session` `{ lot_id, file_name, size }` — ensure/move folder,
  one-off upload URL (browser uploads straight to SharePoint, 10 MB chunks, as G18).
- `POST ?resource=before-complete` `{ lot_id, drive_item_id | file_name+size }` — re-read from
  Graph, must sit in THIS lot's folder, record it; when the lot is on a workorder item, add one
  `NOTE_ADDED` line: `Before photo added — lot <n> — <file>`.
- `DELETE ?resource=before-file&id=` — superadmin only; recycle bin + soft delete + log line.
- Same file rules as G18: jpg/jpeg/png/heic/heif/webp/mp4/mov/m4v, 300 MB per file,
  Melbourne-timestamped names.

## Screens
- **Shared panel:** the G18 panel is generalised (an adapter per kind) so before photos reuse
  the proven chunked/resumable upload, the per-user "saved before your login expired" queue,
  thumbnails and delete. Dispatch evidence behaviour is unchanged.
- **Workorder page, lot row:** `Before photos (n)` button beside each assigned lot → pop-up.
- **Lot Tracker:** "Before refurbishment" section (view + upload) on any lot result,
  including In Stock lots.
- **Tech Checklist:** read-only gallery of the scanned lot's before photos.

## Out of scope
Side-by-side before/after comparison screen; upload from the Collections page; backfilling.

## Testing
- `scripts/ops-before-photos-smoke.mjs` (offline, fake pg + fake Graph): roles, folder
  placement for In Stock vs Assigned, move on reassignment / release, 404 recreate, complete
  checks (wrong folder, limits, retry idempotent), log lines, delete, 42P01, msgraph `moveItem`.
- Jest: panel adapter (before kind) + the three screens; existing dispatch evidence tests stay
  green.
- Preview on Neon dev + the TEST SharePoint folder; the real Graph move is checked there.

## Implementation order
1. Migration 0013 + `_down` → apply to Neon dev, verify down on a throwaway branch.
2. `lib/msgraph.js` `moveItem`; `lib/beforePhotos.js` + routing in `handleEvidence` (smoke RED → GREEN).
3. Generalise the panel; `BeforePhotos` components (Jest RED → GREEN).
4. Mount on workorder lot row, Lot Tracker, Tech Checklist.
5. Build, all tests, review, push, Preview, PR (not merged), Notion report, MEMORY.md.
