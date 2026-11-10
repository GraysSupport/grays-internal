-- 0013_lot_photos.sql — G27 (owner, 10 Nov 2026): "before refurbishment" photos per lot.
--
-- Photos/videos of a machine before it is pulled apart, stored in the SharePoint shared drive
-- (never in this database). These tables only remember WHERE things are:
--   lot_photo_folders — the ONE SharePoint folder for each lot, and where it currently sits:
--                       workorder_items_id NULL = the "In-stock lots" area, otherwise inside that
--                       item's dispatch-evidence folder. Moved (same drive item id) when the lot
--                       is assigned, released or reassigned.
--   lot_photos        — one row per uploaded file. Deletes are soft here (deleted_at/by); the
--                       file itself goes to the SharePoint recycle bin.
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod (prod is the
-- owner's call at merge time; lib/beforePhotos.js tolerates the tables being absent).
-- Paired rollback: 0013_lot_photos_down.sql. No FKs (same reasoning as 0009/0010: deleting a
-- workorder or user must never fail because a photo exists).

CREATE TABLE IF NOT EXISTS lot_photo_folders (
  lot_id             INTEGER     PRIMARY KEY,
  drive_item_id      TEXT        NOT NULL,
  name               TEXT        NOT NULL,
  web_url            TEXT,
  workorder_items_id INTEGER,
  created_by         VARCHAR(2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  moved_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS lot_photos (
  id                 SERIAL      PRIMARY KEY,
  lot_id             INTEGER     NOT NULL,
  workorder_items_id INTEGER,
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

CREATE INDEX IF NOT EXISTS idx_lot_photos_lot
  ON lot_photos (lot_id) WHERE deleted_at IS NULL;
