-- 0001_podium.sql — Podium→CRM Phase 1 data model (execution-plan §4)
--
-- ADDITIVE + IDEMPOTENT ONLY. Safe to run more than once. No existing column is
-- dropped or altered destructively. Paired rollback: 0001_podium_down.sql.
-- Apply ONLY to the Neon dev/preview branch — never the production/default branch.
--
-- Constraints honoured:
--   P1  no chat message bodies are ever stored (see integration_sync_log.payload note)
--   P10 single-user-multi-role RBAC (user_roles) kept alongside legacy users.access
--   P11 new roles: sales + logistics

-- =====================================================================
-- §4.0  Multi-role RBAC (P10/P11) — additive, backward-compatible
-- users.access stays the PRIMARY role; user_roles holds the full set.
-- =====================================================================
CREATE TABLE IF NOT EXISTS user_roles (
  user_id    VARCHAR(2) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(20) NOT NULL,   -- superadmin | staff | technician | workshop | sales | logistics
  granted_by VARCHAR(2) REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);

-- Backfill: every current user's single access value becomes their first role.
INSERT INTO user_roles (user_id, role)
SELECT id, access FROM users
WHERE access IS NOT NULL
ON CONFLICT DO NOTHING;

-- =====================================================================
-- §4.1  Bridges & per-rep mapping
-- =====================================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS podium_contact_id VARCHAR;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS myob_uid          VARCHAR;   -- reserved (future)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS woo_customer_id   INTEGER;   -- reserved (future)
CREATE INDEX IF NOT EXISTS idx_customers_podium      ON customers(podium_contact_id);
CREATE INDEX IF NOT EXISTS idx_customers_email_lower ON customers(LOWER(email));

-- Map each portal salesperson to their Podium member/user (drives native assignment)
ALTER TABLE users ADD COLUMN IF NOT EXISTS podium_user_id VARCHAR;          -- Podium member UID

-- =====================================================================
-- §4.2  Per-user OAuth token store
-- NULL user_id row = the location/webhook registration (scope_level='location').
-- =====================================================================
CREATE TABLE IF NOT EXISTS podium_oauth (
  id             SERIAL PRIMARY KEY,
  user_id        VARCHAR(2) REFERENCES users(id),
  scope_level    VARCHAR(12) NOT NULL DEFAULT 'user',  -- 'user' | 'location'
  org_uid        VARCHAR,
  location_uid   VARCHAR,
  podium_user_id VARCHAR,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  scopes         TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_podium_oauth_user
  ON podium_oauth(user_id) WHERE user_id IS NOT NULL;

-- =====================================================================
-- §4.3  Leads / opportunities (mirrors the canonical funnel, §1c)
-- CREATE TYPE has no IF NOT EXISTS; guard each with a DO block so re-runs are no-ops.
-- =====================================================================
DO $$ BEGIN
  CREATE TYPE lead_stage AS ENUM ('New','Contacted','Quoted','Payment Received','Won','Lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_type AS ENUM ('none','deposit_50','paid_full','exception');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS leads (
  lead_id                SERIAL PRIMARY KEY,
  source                 VARCHAR(20)  NOT NULL DEFAULT 'podium',
  source_channel         VARCHAR(20),                  -- sms|email|facebook|google|instagram|webchat
  customer_id            INTEGER REFERENCES customers(id),
  podium_contact_id      VARCHAR,
  podium_conversation_id VARCHAR,
  stage                  lead_stage   NOT NULL DEFAULT 'New',
  assigned_to            VARCHAR(2)   REFERENCES users(id),   -- == Podium assignee (synced)
  value_est              NUMERIC(12,2),
  product_interest       TEXT,
  -- quote / payment (steps 3-4); auto-filled by MYOB later, manual for now
  quote_invoice_id       VARCHAR,                      -- MYOB invoice number -> becomes workorder.invoice_id
  order_total            NUMERIC(12,2),
  payment                payment_type NOT NULL DEFAULT 'none',
  payment_note           TEXT,                         -- reason when 'exception' (waived/partial deposit, etc.)
  paid_at                TIMESTAMPTZ,
  workorder_created_by   VARCHAR(2) REFERENCES users(id),  -- logistics person who created the workorder
  paid_confirmed_by      VARCHAR(2) REFERENCES users(id),  -- logistics person who confirmed MYOB payment
  lost_reason            TEXT,
  last_contact_at        TIMESTAMPTZ,
  next_followup_at       TIMESTAMPTZ,
  converted_workorder_id INTEGER REFERENCES workorder(workorder_id),
  notes                  TEXT,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_stage    ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_contact  ON leads(podium_contact_id);

-- Append-only stage history (mirrors workorder_logs)
CREATE TABLE IF NOT EXISTS lead_stage_log (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(lead_id) ON DELETE CASCADE,
  from_stage lead_stage,
  to_stage   lead_stage NOT NULL,
  user_id    VARCHAR(2),
  notes_log  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================================
-- §4.4  Integration audit / idempotency (ENVELOPE ONLY — no chat bodies, P1)
-- =====================================================================
CREATE TABLE IF NOT EXISTS integration_sync_log (
  id           SERIAL PRIMARY KEY,
  source       VARCHAR(20) NOT NULL,            -- podium|myob|woocommerce
  direction    VARCHAR(10) NOT NULL,            -- inbound|outbound
  event_type   VARCHAR(60) NOT NULL,
  reference_id VARCHAR,                          -- Podium event id (dedupe key)
  status       VARCHAR(20) NOT NULL DEFAULT 'received',
  payload      JSONB,                            -- MINIMAL envelope: ids, channel, assignee, ts. NEVER message text (P1).
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_ref
  ON integration_sync_log(source, reference_id) WHERE reference_id IS NOT NULL;
