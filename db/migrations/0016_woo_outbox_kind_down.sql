-- 0016_woo_outbox_kind_down.sql — rollback of G25e1. The portal forgets which rows were
-- add-backs; the website itself is untouched. Run it with the G25e1 code rolled back: add-back
-- rows would otherwise be read as sales (with the code still deployed the column check returns
-- false and nothing is added back — but existing add-back rows would look like sales on the
-- workorder page). If add-backs exist, delete them first:
--   DELETE FROM woo_stock_outbox WHERE kind <> 'decrease';

DROP INDEX IF EXISTS uq_woo_stock_outbox_reverses_once;
DROP INDEX IF EXISTS idx_woo_stock_outbox_reverses;
ALTER TABLE woo_stock_outbox DROP COLUMN IF EXISTS reverses_id;
ALTER TABLE woo_stock_outbox DROP COLUMN IF EXISTS kind;
