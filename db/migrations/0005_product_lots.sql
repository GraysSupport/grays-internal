-- 0005_product_lots.sql — Incoming product lot numbers (G3, 10 Jul 2026).
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod.
-- Paired rollback: 0005_product_lots_down.sql. Independent of Podium tables.
--
-- Each physical item that arrives from a collection gets a unique lot number
-- (format L00001, from product_lot_seq — SKU is stored + printed alongside).
-- Lots are generated when a collection is marked COMPLETED (items checked +
-- arrived — D6), NOT at apply-inventory; the lot's unit_cost is stamped later
-- when apply-inventory runs. collections.lots_generated_at is the idempotency
-- guard (mirrors inventory_applied_at).

DO $$ BEGIN
  CREATE TYPE lot_status_enum AS ENUM ('In Stock', 'Assigned', 'Sold', 'Void');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE SEQUENCE IF NOT EXISTS product_lot_seq START 1;

CREATE TABLE IF NOT EXISTS product_lots (
  lot_id             SERIAL PRIMARY KEY,
  lot_number         VARCHAR(12) NOT NULL UNIQUE,
  product_sku        VARCHAR(15) NOT NULL REFERENCES product(sku),
  collection_id      INTEGER REFERENCES collections(id),
  serial_number      TEXT,
  status             lot_status_enum NOT NULL DEFAULT 'In Stock',
  workorder_items_id INTEGER REFERENCES workorder_items(workorder_items_id),
  unit_cost          NUMERIC,
  created_by         VARCHAR(2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_product_lots_sku_status  ON product_lots (product_sku, status);
CREATE INDEX IF NOT EXISTS idx_product_lots_collection  ON product_lots (collection_id);
CREATE INDEX IF NOT EXISTS idx_product_lots_woitem      ON product_lots (workorder_items_id);

ALTER TABLE collections ADD COLUMN IF NOT EXISTS lots_generated_at TIMESTAMPTZ;
