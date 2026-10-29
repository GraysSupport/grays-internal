-- 0011_free_weights.sql — G21 (owner, 29 Oct 2026): Brand New Free Weights stock.
--
-- A stock list kept completely apart from `product` / lots / workorders / the Woo sync: one row
-- per product line (e.g. "Trigrip Olympic Rubber Weight"), one row per individual weight with
-- its own stock count, and an append-only log of every stock change (who / why / when).
-- `free_weight_variants.stock` is the running total, changed only together with a move row
-- (lib/freeWeights.js, same transaction, SELECT … FOR UPDATE) and never below zero.
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod (prod is the
-- owner's call at merge time; lib/freeWeights.js tolerates the tables being absent).
-- Paired rollback: 0011_free_weights_down.sql.
-- No FK on the user columns (deleting a user must never fail or wipe history).

-- Categories (owner revision, 30 Oct 2026): staff can add their own ("Medicine balls", …).
-- The seven built-ins are seeded; a product line's category must be one of these rows.
CREATE TABLE IF NOT EXISTS free_weight_categories (
  key         TEXT        PRIMARY KEY,
  label       TEXT        NOT NULL CHECK (char_length(label) BETWEEN 2 AND 40),
  sort        INTEGER     NOT NULL DEFAULT 1000,
  builtin     BOOLEAN     NOT NULL DEFAULT false,
  created_by  VARCHAR(2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_free_weight_categories_label
  ON free_weight_categories (lower(label));

INSERT INTO free_weight_categories (key, label, sort, builtin) VALUES
  ('plate', 'Plates', 10, true),
  ('bumper', 'Bumper plates', 20, true),
  ('dumbbell', 'Dumbbells', 30, true),
  ('kettlebell', 'Kettlebells', 40, true),
  ('bar', 'Bars', 50, true),
  ('collar', 'Collars', 60, true),
  ('other', 'Other', 9999, true)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS free_weight_products (
  id          SERIAL      PRIMARY KEY,
  brand       TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT 'other' REFERENCES free_weight_categories(key),
  notes       TEXT,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_by  VARCHAR(2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  VARCHAR(2),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_free_weight_products_brand_name
  ON free_weight_products (lower(brand), lower(name));

-- Upgrade path for a database that ran the earlier 0011 (fixed CHECK list of categories):
-- swap the CHECK for the foreign key. No-ops on a fresh database.
ALTER TABLE free_weight_products DROP CONSTRAINT IF EXISTS free_weight_products_category_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                 WHERE c.conname = 'free_weight_products_category_fkey' AND n.nspname = current_schema()) THEN
    ALTER TABLE free_weight_products
      ADD CONSTRAINT free_weight_products_category_fkey FOREIGN KEY (category) REFERENCES free_weight_categories(key);
  END IF;
END $$;
UPDATE free_weight_categories SET sort = 9999 WHERE key = 'other' AND sort = 70;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                 WHERE c.conname = 'free_weight_categories_label_check' AND n.nspname = current_schema()) THEN
    ALTER TABLE free_weight_categories ADD CONSTRAINT free_weight_categories_label_check CHECK (char_length(label) BETWEEN 2 AND 40);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS free_weight_variants (
  id            SERIAL        PRIMARY KEY,
  product_id    INTEGER       NOT NULL REFERENCES free_weight_products(id),
  weight_kg     NUMERIC(6,2)  NOT NULL CHECK (weight_kg > 0),
  sku           TEXT,
  stock         INTEGER       NOT NULL DEFAULT 0 CHECK (stock >= 0),
  price         NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  unit_cost     NUMERIC(10,2) CHECK (unit_cost >= 0),
  reorder_level INTEGER       CHECK (reorder_level >= 0),
  active        BOOLEAN       NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, weight_kg)
);

CREATE TABLE IF NOT EXISTS free_weight_stock_moves (
  id          SERIAL      PRIMARY KEY,
  variant_id  INTEGER     NOT NULL REFERENCES free_weight_variants(id),
  delta       INTEGER     NOT NULL CHECK (delta <> 0),
  reason      TEXT        NOT NULL CHECK (reason IN ('received', 'sold', 'adjustment', 'damaged', 'returned')),
  reference   TEXT,
  note        TEXT,
  user_id     VARCHAR(2),
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_free_weight_moves_variant ON free_weight_stock_moves (variant_id, at DESC);
