-- 0002_lead_lost_reason_down.sql — reverse of 0002_lead_lost_reason.sql
--
-- Idempotent (IF EXISTS). Run ONLY on the Neon dev/preview branch.
--
-- NOTE: the 'Payment Received' → 'Won' stage merge is ONE-WAY — which 'Won' rows were
-- formerly 'Payment Received' is not recorded, so it is deliberately NOT reversed here.
-- Only the additive column is dropped.

ALTER TABLE leads DROP COLUMN IF EXISTS lost_reason_category;
