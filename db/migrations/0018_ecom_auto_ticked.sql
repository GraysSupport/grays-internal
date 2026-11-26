-- 0018_ecom_auto_ticked.sql — GS one-time popup for automatically ticked workorders
-- (owner, 26 Nov 2026).
--
-- Once the dry run is off, a successful website stock update ticks the workorder's E-Commerce
-- flag by itself (lib/wooStock.js), so the workorder leaves GS's "Ecommerce checks pending"
-- popup. GS still has to enter the sold items' values on each of those workorders once, so:
--   ecommerce_auto_ticked_at  when the portal ticked the flag automatically (never set by hand
--                             ticks or by dry-run sends)
--   ecommerce_auto_seen_at    when GS opened that workorder — after this it never pops up again
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev branch — prod is the owner's call at merge
-- time. The code is 42703-safe: without these columns the flag is ticked exactly as before and
-- the popup simply has nothing to show.
-- Paired rollback: 0018_ecom_auto_ticked_down.sql.

ALTER TABLE workorder ADD COLUMN IF NOT EXISTS ecommerce_auto_ticked_at TIMESTAMPTZ NULL;
ALTER TABLE workorder ADD COLUMN IF NOT EXISTS ecommerce_auto_seen_at TIMESTAMPTZ NULL;

-- The popup only ever reads ticked-but-not-yet-opened workorders.
CREATE INDEX IF NOT EXISTS idx_workorder_ecom_auto_unseen
  ON workorder (ecommerce_auto_ticked_at)
  WHERE ecommerce_auto_ticked_at IS NOT NULL AND ecommerce_auto_seen_at IS NULL;
