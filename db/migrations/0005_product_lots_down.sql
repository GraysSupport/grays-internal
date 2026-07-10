-- 0005_product_lots_down.sql — rollback of G3 lot numbers. Reversible.

ALTER TABLE collections DROP COLUMN IF EXISTS lots_generated_at;
DROP TABLE IF EXISTS product_lots;
DROP SEQUENCE IF EXISTS product_lot_seq;
DROP TYPE IF EXISTS lot_status_enum;
