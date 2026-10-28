-- 0010_dispatch_evidence.sql — G18 (owner, 28 Oct 2026)
--
-- Dispatch evidence: photos + videos of each workorder item, stored in the SharePoint shared
-- drive (never in this database). These tables only remember WHERE things are:
--   dispatch_evidence_folders — the SharePoint folder for each workorder (workorder_items_id
--                               NULL) and for each item inside it. Stored by id, so a later
--                               invoice change never splits or orphans a folder.
--   dispatch_evidence_files   — one row per uploaded file: who, when, size, link. Deletes are
--                               soft here (deleted_at/by); the file itself goes to the SharePoint
--                               recycle bin.
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod (prod is the
-- owner's call at merge time; lib/dispatchEvidence.js tolerates the tables being absent).
-- Paired rollback: 0010_dispatch_evidence_down.sql.
--
-- No FKs to workorder / workorder_items (workorder.js deletes items when a workorder is deleted,
-- and that must never fail because evidence exists) or to users (same reason as 0009).

CREATE TABLE IF NOT EXISTS dispatch_evidence_folders (
  id                 SERIAL      PRIMARY KEY,
  workorder_id       INTEGER     NOT NULL,
  workorder_items_id INTEGER,
  drive_item_id      TEXT        NOT NULL,
  name               TEXT        NOT NULL,
  web_url            TEXT,
  created_by         VARCHAR(2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One workorder folder (keyed 0) and one folder per item.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_evidence_folders
  ON dispatch_evidence_folders (workorder_id, (COALESCE(workorder_items_id, 0)));

CREATE TABLE IF NOT EXISTS dispatch_evidence_files (
  id                 SERIAL      PRIMARY KEY,
  workorder_id       INTEGER     NOT NULL,
  workorder_items_id INTEGER     NOT NULL,
  drive_item_id      TEXT        NOT NULL UNIQUE,
  file_name          TEXT        NOT NULL,
  mime_type          TEXT,
  size_bytes         BIGINT,
  web_url            TEXT,
  uploaded_by        VARCHAR(2),
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by         VARCHAR(2),
  deleted_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dispatch_evidence_files_wo
  ON dispatch_evidence_files (workorder_id) WHERE deleted_at IS NULL;
