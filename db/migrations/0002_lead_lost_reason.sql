-- 0002_lead_lost_reason.sql — Lead funnel refinements (F5 feedback, 8 Jul 2026)
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod.
-- Paired rollback: 0002_lead_lost_reason_down.sql.
--
-- 1. Structured Lost-reason CATEGORY so loss reasons are quantifiable ("why are we
--    losing leads"). The free-text `lost_reason` stays as the optional note/detail
--    (used for the "Other" reason); the category is the countable bucket.
-- 2. Merge the 'Payment Received' stage into 'Won' (funnel simplified per Nick — the
--    two were practically the same). The `lead_stage` enum VALUE is left in place
--    (Postgres can't drop an enum label cleanly) but the app no longer produces it;
--    existing rows are moved to 'Won'. This data step is idempotent.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_category VARCHAR(40);

-- Merge Payment Received → Won (idempotent — a re-run matches nothing).
UPDATE leads SET stage = 'Won' WHERE stage = 'Payment Received';
