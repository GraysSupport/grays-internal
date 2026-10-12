-- 0008_delivery_run_order.sql — G9 (Nick, 28 Sep 2026)
--
-- The stop order of a booked delivery within its run (one carrier on one day), set by
-- drag-to-reorder on the delivery schedule so drivers get the best route order.
-- NULL = never ordered: those rows keep the schedule's existing default order.
--
-- ADDITIVE + IDEMPOTENT. Nullable columns with no default are a metadata-only change (no
-- table rewrite). Apply ONLY to the Neon dev/preview branch — never prod (prod is Nick's
-- call at merge time; lib/deliveryRunOrder.js tolerates the column being absent).
-- Paired rollback: 0008_delivery_run_order_down.sql.

-- run_order_key = the run (carrier|day) the number was set for. A stop number is only read
-- back while the delivery is still in that run, so re-booking a delivery to another carrier
-- or day silently retires its old number — no change to the booking code needed.

ALTER TABLE delivery ADD COLUMN IF NOT EXISTS run_order INTEGER;
ALTER TABLE delivery ADD COLUMN IF NOT EXISTS run_order_key VARCHAR(24);
