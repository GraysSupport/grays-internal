-- 0016_woo_outbox_kind.sql — G25e1 (owner's back-in-stock rules, 19 Nov 2026).
--
-- A cancelled workorder item puts its quantity back on the website. The outbox now holds two
-- kinds of row:
--   kind = 'decrease'      a sale (every row written before this migration — the default)
--   kind = 'increase'      a cancelled item's add-back (lib/wooRestock.js)
--   kind = 'create_draft'  reserved for G25e2 (a new SKU becomes a WooCommerce draft)
-- reverses_id points at the row being given back: an add-back → the sale it reverses; a reopen's
-- new decrease → the add-back it takes again. "Already given back?" = a non-cancelled row with
-- reverses_id = this row, so nothing is ever given back (or taken again) twice.
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev branch — prod is the owner's call at merge
-- time. The code is 42703-safe: without these columns nothing is added back automatically (the
-- workorder log tells GS to update the website by hand).
-- Paired rollback: 0016_woo_outbox_kind_down.sql.

ALTER TABLE woo_stock_outbox
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'decrease'
    CHECK (kind IN ('decrease', 'increase', 'create_draft'));

ALTER TABLE woo_stock_outbox ADD COLUMN IF NOT EXISTS reverses_id INTEGER NULL;

CREATE INDEX IF NOT EXISTS idx_woo_stock_outbox_reverses
  ON woo_stock_outbox (reverses_id) WHERE reverses_id IS NOT NULL;
