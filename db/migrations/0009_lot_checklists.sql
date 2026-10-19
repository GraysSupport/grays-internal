-- 0009_lot_checklists.sql — G16 (Nick, 19 Oct 2026)
--
-- The technician "Screen & Electronics Checklist" (the paper tag on cardio machines with
-- consoles), one per lot — the physical machine. Ticks + fault notes live in `checks` (jsonb,
-- keys defined in lib/techChecklist.js CHECK_ITEMS); base + console serials are kept apart
-- here and written back to workorder_items.item_sn / product_lots.serial_number by the handler.
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod (prod is
-- Nick's call at merge time; lib/techChecklist.js tolerates the table being absent).
-- Paired rollback: 0009_lot_checklists_down.sql.
--
-- `version` is the optimistic-concurrency counter (same contract as 0007): a save on a stale
-- version is refused so two technicians can't silently overwrite each other.
-- No FK on workorder_items_id (workorder.js deletes items when a workorder is deleted) or on
-- the user columns (deleting a user must never fail or wipe a checklist) — the handler
-- LEFT JOINs for names. Lots are never deleted (they are voided), so lot_id is a real FK.

CREATE TABLE IF NOT EXISTS lot_checklists (
  lot_id             INTEGER     PRIMARY KEY REFERENCES product_lots(lot_id),
  workorder_items_id INTEGER,
  checks             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  test_tag_no        TEXT,
  base_serial        TEXT,
  console_serial     TEXT,
  comments           TEXT,
  ok_to_ship         BOOLEAN     NOT NULL DEFAULT false,
  approved_by        VARCHAR(2),
  approved_at        TIMESTAMPTZ,
  created_by         VARCHAR(2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         VARCHAR(2),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version            INTEGER     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_lot_checklists_woitem ON lot_checklists (workorder_items_id);
