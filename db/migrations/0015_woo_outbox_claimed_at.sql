-- 0015_woo_outbox_claimed_at.sql — G25d (G25 inc-2 review backlog, 17 Nov 2026).
--
-- When a website-stock row is claimed for sending (status 'sending'), stamp WHEN. The daily
-- job's stuck-row sweep then measures "stuck for an hour" from the claim, not from when the row
-- was created — so a days-old row that a Retry is sending right now no longer gets a false
-- "the update didn't finish" log. Rows claimed before this migration keep claimed_at NULL and
-- fall back to created_at (the old rule).
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev branch — prod is the owner's call at merge
-- time. The code is 42703-safe: without this column it claims and sweeps exactly as before.
-- Paired rollback: 0015_woo_outbox_claimed_at_down.sql.

ALTER TABLE woo_stock_outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL;
