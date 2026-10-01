-- 0008_delivery_run_order.sql — G9 (Nick, 28 Sep 2026)
--
-- The stop order of a booked delivery within its run (one carrier on one day), set by
-- drag-to-reorder on the delivery schedule so drivers get the best route order.
-- NULL = never ordered: those rows keep the schedule's existing default order.
--
-- ADDITIVE + IDEMPOTENT. A nullable column with no default is a metadata-only change (no
-- table rewrite). Apply ONLY to the Neon dev/preview branch — never prod (prod is Nick's
-- call at merge time; lib/deliveryRunOrder.js tolerates the column being absent).
-- Paired rollback: 0008_delivery_run_order_down.sql.

ALTER TABLE delivery ADD COLUMN IF NOT EXISTS run_order INTEGER;
