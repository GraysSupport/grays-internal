-- 0004_delivery_type_down.sql — rollback of G2 delivery type + flags. Reversible.

ALTER TABLE delivery  DROP COLUMN IF EXISTS installation_cost;
ALTER TABLE delivery  DROP COLUMN IF EXISTS cash_to_removalist;
ALTER TABLE delivery  DROP COLUMN IF EXISTS free_delivery;
ALTER TABLE delivery  DROP COLUMN IF EXISTS delivery_type;

ALTER TABLE workorder DROP COLUMN IF EXISTS installation_cost;
ALTER TABLE workorder DROP COLUMN IF EXISTS cash_to_removalist;
ALTER TABLE workorder DROP COLUMN IF EXISTS free_delivery;
ALTER TABLE workorder DROP COLUMN IF EXISTS delivery_type;

DROP TYPE IF EXISTS delivery_type_enum;
