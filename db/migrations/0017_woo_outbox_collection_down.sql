-- 0017_woo_outbox_collection_down.sql — rollback of G25e2. The website is untouched.
-- Refuses while collection rows exist (workorder_id NULL), because NOT NULL can't come back
-- with them. To force it, first decide what to keep, e.g.:
--   DELETE FROM woo_stock_outbox WHERE collection_id IS NOT NULL;
-- (the portal then forgets what each collection already sent — pressing the button again would
-- send it twice). Run it with the G25e2 code rolled back.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM woo_stock_outbox WHERE collection_id IS NOT NULL) THEN
    RAISE EXCEPTION '0017 down refused: woo_stock_outbox has collection rows — see the header';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_woo_stock_outbox_collection;
ALTER TABLE woo_stock_outbox DROP CONSTRAINT IF EXISTS woo_stock_outbox_owner_chk;
ALTER TABLE woo_stock_outbox ALTER COLUMN workorder_id SET NOT NULL;
ALTER TABLE woo_stock_outbox DROP COLUMN IF EXISTS collection_id;
