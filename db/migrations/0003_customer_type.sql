-- 0003_customer_type.sql — Customer Individual/Business tagging (G1, 10 Jul 2026)
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod.
-- Paired rollback: 0003_customer_type_down.sql.
--
-- Adds a two-value type to every customer. The column is left NULLABLE with NO
-- default on purpose: an ADD COLUMN ... DEFAULT would immediately stamp every
-- existing row and clobber the human-approved classification. Instead the data
-- backfill is a SEPARATE, reviewed seed file generated from Nick's spreadsheet:
--   db/seeds/0003_customer_type_backfill.sql   (run once per environment).
-- New rows get their type from the app (customers handler defaults to 'Individual').

DO $$ BEGIN
  CREATE TYPE customer_type_enum AS ENUM ('Individual', 'Business');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type customer_type_enum;

CREATE INDEX IF NOT EXISTS idx_customers_type ON customers (customer_type);
