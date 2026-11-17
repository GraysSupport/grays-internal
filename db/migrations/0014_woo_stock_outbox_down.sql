-- 0014_woo_stock_outbox_down.sql — rollback of G25. The portal forgets which website stock
-- updates were sent; the website itself is untouched.

DROP INDEX IF EXISTS idx_woo_stock_outbox_open;
DROP INDEX IF EXISTS idx_woo_stock_outbox_wo;
DROP TABLE IF EXISTS woo_stock_outbox;
-- Postgres cannot remove an enum value: 'WEBSITE_STOCK_SYNC' stays in workorder_log_event
-- (harmless — nothing writes it once the code is gone).
