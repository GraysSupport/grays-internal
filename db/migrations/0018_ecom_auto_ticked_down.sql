-- 0018_ecom_auto_ticked_down.sql — rollback of the GS one-time popup columns. The E-Commerce
-- flag itself is untouched; the portal only forgets which workorders were ticked automatically
-- and which GS has opened. Safe with the code still deployed (it is 42703-safe).

DROP INDEX IF EXISTS idx_workorder_ecom_auto_unseen;
ALTER TABLE workorder DROP COLUMN IF EXISTS ecommerce_auto_seen_at;
ALTER TABLE workorder DROP COLUMN IF EXISTS ecommerce_auto_ticked_at;
