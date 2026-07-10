-- 0003_customer_type_down.sql — rollback of G1 customer type tagging.
-- Drops the column, its index, and the enum. Reversible.

DROP INDEX IF EXISTS idx_customers_type;
ALTER TABLE customers DROP COLUMN IF EXISTS customer_type;
DROP TYPE IF EXISTS customer_type_enum;
