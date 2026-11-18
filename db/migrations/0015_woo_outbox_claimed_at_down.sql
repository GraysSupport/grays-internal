-- 0015_woo_outbox_claimed_at_down.sql — rollback of G25d. The stuck-row sweep goes back to
-- measuring from created_at (the code detects the missing column). No other data is touched.
-- Run it with the G25d code rolled back (or outside the daily job's window): a sync that had
-- already seen the column would hit 42703 on its next claim — harmless (the row stays 'pending'
-- for the next retry), but noisy.

ALTER TABLE woo_stock_outbox DROP COLUMN IF EXISTS claimed_at;
