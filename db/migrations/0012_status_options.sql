-- 0012_status_options.sql — G23 (owner, 30 Oct 2026)
--
-- 1. Workorders can be Cancelled: workorder_status_enum gains 'Cancelled' (Work Ordered /
--    Completed / Cancelled). Cancelling cancels every live item, returns its stock and frees its
--    lots (lib/workorderCancel.js); workorder_items.status_before_cancel remembers each item's
--    status so reopening can put it back. Items removed before the cancel keep it NULL and stay
--    removed.
-- 2. Lot status 'Sold' is renamed 'Written Off' (In Stock / Assigned / Written Off / Void).
--    Nothing writes 'Sold' today and no rows hold it, so this is a label change only.
--
-- IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod (prod is the owner's call at
-- merge time). The code compares statuses as text, so it runs before and after this migration.
-- Paired rollback: 0012_status_options_down.sql.

ALTER TYPE workorder_status_enum ADD VALUE IF NOT EXISTS 'Cancelled';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE t.typname = 'lot_status_enum' AND n.nspname = current_schema() AND e.enumlabel = 'Sold')
     AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE t.typname = 'lot_status_enum' AND n.nspname = current_schema() AND e.enumlabel = 'Written Off') THEN
    ALTER TYPE lot_status_enum RENAME VALUE 'Sold' TO 'Written Off';
  END IF;
END $$;

ALTER TABLE workorder_items ADD COLUMN IF NOT EXISTS status_before_cancel item_status_enum;
