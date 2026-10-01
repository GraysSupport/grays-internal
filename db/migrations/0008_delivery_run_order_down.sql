-- 0008_delivery_run_order_down.sql — rollback of G9 run ordering. Reversible
-- (saved stop orders are lost; the schedule falls back to its default order).

ALTER TABLE delivery DROP COLUMN IF EXISTS run_order;
