-- 0015_woo_outbox_claimed_at_down.sql — rollback of G25d. The stuck-row sweep goes back to
-- measuring from created_at (the code detects the missing column). No other data is touched.

ALTER TABLE woo_stock_outbox DROP COLUMN IF EXISTS claimed_at;
