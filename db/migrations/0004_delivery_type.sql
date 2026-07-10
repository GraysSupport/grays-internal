-- 0004_delivery_type.sql — Delivery type, free-delivery / cash-direct flags,
-- installation cost (G2, 10 Jul 2026).
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod.
-- Paired rollback: 0004_delivery_type_down.sql. Independent of Podium tables.
--
-- delivery_type: the service. 'Customer Collect' = customer picks up, no removalist,
--   $0 fee is correct (distinct from free_delivery — a Standard delivery given away).
-- free_delivery: pricing flag, delivery included in the sale to win the deal.
-- cash_to_removalist: payment flag, customer pays the removalist directly in cash.
-- installation_cost: what the technician callout costs US (installation is always
--   billed to the customer inside delivery_charged — D2 — so there is no separate
--   installation_charged column).
--
-- delivery_type is NULLABLE with NO default (existing rows stay untagged per D3;
-- the app defaults new rows to 'Standard'). Flags default FALSE = untagged.
-- Both workorder (captured at create/update) and delivery (copied when the delivery
-- is auto-created + editable in To-Be-Booked) carry the fields.

DO $$ BEGIN
  CREATE TYPE delivery_type_enum AS ENUM ('Standard', 'Standard + Installation', 'Customer Collect');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE workorder ADD COLUMN IF NOT EXISTS delivery_type        delivery_type_enum;
ALTER TABLE workorder ADD COLUMN IF NOT EXISTS free_delivery         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workorder ADD COLUMN IF NOT EXISTS cash_to_removalist    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workorder ADD COLUMN IF NOT EXISTS installation_cost     NUMERIC;

ALTER TABLE delivery  ADD COLUMN IF NOT EXISTS delivery_type         delivery_type_enum;
ALTER TABLE delivery  ADD COLUMN IF NOT EXISTS free_delivery         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE delivery  ADD COLUMN IF NOT EXISTS cash_to_removalist    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE delivery  ADD COLUMN IF NOT EXISTS installation_cost     NUMERIC;
