-- 0001_podium_down.sql — reverse of 0001_podium.sql
--
-- Drops ONLY the objects 0001_podium.sql created. Idempotent (IF EXISTS).
-- Dependents are dropped before their dependencies. Dropping a table also drops
-- its own indexes, so per-table indexes are not listed separately below.
-- Run ONLY on the Neon dev/preview branch — never the production/default branch.

-- §4.4  audit / idempotency
DROP TABLE IF EXISTS integration_sync_log;   -- also drops uq_sync_ref

-- §4.3  leads / opportunities (drop children -> parent -> types)
DROP TABLE IF EXISTS lead_stage_log;
DROP TABLE IF EXISTS leads;                   -- also drops idx_leads_*
DROP TYPE  IF EXISTS payment_type;
DROP TYPE  IF EXISTS lead_stage;

-- §4.2  per-user OAuth token store
DROP TABLE IF EXISTS podium_oauth;            -- also drops uq_podium_oauth_user

-- §4.1  bridges & per-rep mapping (columns/indexes added to pre-existing tables)
ALTER TABLE users     DROP COLUMN IF EXISTS podium_user_id;
DROP INDEX IF EXISTS idx_customers_email_lower;
DROP INDEX IF EXISTS idx_customers_podium;
ALTER TABLE customers DROP COLUMN IF EXISTS woo_customer_id;
ALTER TABLE customers DROP COLUMN IF EXISTS myob_uid;
ALTER TABLE customers DROP COLUMN IF EXISTS podium_contact_id;

-- §4.0  multi-role RBAC
DROP TABLE IF EXISTS user_roles;              -- also drops idx_user_roles_role
