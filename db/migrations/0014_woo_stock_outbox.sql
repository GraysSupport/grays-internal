-- 0014_woo_stock_outbox.sql — G25 (owner, 17 Nov 2026): workorder created → website stock.
--
-- One row per non-custom workorder item that should move the website stock. Written in the
-- SAME transaction as the portal stock change, so a website outage never loses a sale; sent
-- after the commit by lib/wooStock.js syncWorkorderWebsiteStock().
--   status: pending | sending | sent | dry_run | failed | needs_human
--   ('sending' = claimed; a row left there means the website changed but bookkeeping failed
--    — it is never re-sent automatically)
--   result: { action, before, after, check, product_id } — what was (or would be) sent
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — prod is the owner's
-- call at merge time (lib/wooStock.js writes nothing while this table is absent).
-- Paired rollback: 0014_woo_stock_outbox_down.sql. No FKs: deleting a workorder must never
-- fail because a website-sync row exists.

CREATE TABLE IF NOT EXISTS woo_stock_outbox (
  id            SERIAL       PRIMARY KEY,
  workorder_id  INTEGER      NOT NULL,
  sku           VARCHAR      NOT NULL,
  qty           NUMERIC      NOT NULL,          -- workorder_items.quantity is NUMERIC
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
  attempts      INTEGER      NOT NULL DEFAULT 0,
  result        JSONB,
  last_error    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_woo_stock_outbox_wo ON woo_stock_outbox (workorder_id);
CREATE INDEX IF NOT EXISTS idx_woo_stock_outbox_open
  ON woo_stock_outbox (created_at) WHERE status IN ('pending', 'failed');

-- Dev first had qty INTEGER (17 Nov 2026, before review): per-kg items can be decimal.
ALTER TABLE woo_stock_outbox ALTER COLUMN qty TYPE NUMERIC;

-- The workorder activity log only accepts known event types.
ALTER TYPE workorder_log_event ADD VALUE IF NOT EXISTS 'WEBSITE_STOCK_SYNC';
