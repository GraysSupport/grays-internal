-- 0012_status_options_down.sql — rollback of G23 status options.
--
-- Refuses while any workorder is Cancelled (reopen them first), so no workorder is left holding
-- a status the old code does not know. Postgres cannot drop a single enum value, so 'Cancelled'
-- stays in workorder_status_enum, unused; the lot label goes back to 'Sold'.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workorder WHERE status::text = 'Cancelled') THEN
    RAISE EXCEPTION '0012 down: reopen every Cancelled workorder first';
  END IF;
END $$;

ALTER TABLE workorder_items DROP COLUMN IF EXISTS status_before_cancel;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE t.typname = 'lot_status_enum' AND n.nspname = current_schema() AND e.enumlabel = 'Written Off') THEN
    ALTER TYPE lot_status_enum RENAME VALUE 'Written Off' TO 'Sold';
  END IF;
END $$;
