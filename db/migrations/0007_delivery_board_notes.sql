-- 0007_delivery_board_notes.sql — G7 (Nick, 28 Sep 2026)
--
-- One shared, free-text note per delivery board. Today there is a single board,
-- 'to-be-booked': the panel at the top of the To-Be-Booked deliveries tab where logistics
-- records when drivers are coming in next. Not tied to any delivery or workorder.
--
-- ADDITIVE + IDEMPOTENT. Apply ONLY to the Neon dev/preview branch — never prod (prod is
-- Nick's call at merge time; lib/deliveryBoardNotes.js tolerates the table being absent).
-- Paired rollback: 0007_delivery_board_notes_down.sql.
--
-- `version` is the optimistic-concurrency counter: every save bumps it, and a save made on
-- a stale version is refused so two people can't silently overwrite each other.
-- updated_by has no FK on purpose: deleting a user must never fail or wipe the note
-- (the handler LEFT JOINs users for the name and falls back to the id).

CREATE TABLE IF NOT EXISTS delivery_board_notes (
  board       VARCHAR(40) PRIMARY KEY,
  body        TEXT        NOT NULL DEFAULT '',
  updated_by  VARCHAR(2),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version     INTEGER     NOT NULL DEFAULT 1
);
