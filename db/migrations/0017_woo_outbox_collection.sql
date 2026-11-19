-- 0017_woo_outbox_collection.sql — G25e2 (owner's back-in-stock rules, 19 Nov 2026, Part 2):
-- the collection page's "Apply Stock to Website" button.
--
-- A website-stock row can now belong to a COLLECTION instead of a workorder. What a collection
-- has already sent is the sum of its rows per SKU (lib/wooCollection.js) — kept here, not on
-- collection_items, because "Save Collection" deletes and re-inserts every line (a per-line
-- counter would be wiped and the stock sent twice).
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev branch — prod is the owner's call at merge
-- time. The code is 42703-safe: without collection_id the button is hidden and the daily job
-- skips collections. Relaxing workorder_id's NOT NULL is reversible only while no collection rows
-- exist — the _down refuses otherwise. Paired rollback: 0017_woo_outbox_collection_down.sql.

ALTER TABLE woo_stock_outbox ADD COLUMN IF NOT EXISTS collection_id INTEGER NULL;

ALTER TABLE woo_stock_outbox ALTER COLUMN workorder_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'woo_stock_outbox_owner_chk') THEN
    ALTER TABLE woo_stock_outbox
      ADD CONSTRAINT woo_stock_outbox_owner_chk CHECK (workorder_id IS NOT NULL OR collection_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_woo_stock_outbox_collection
  ON woo_stock_outbox (collection_id) WHERE collection_id IS NOT NULL;
