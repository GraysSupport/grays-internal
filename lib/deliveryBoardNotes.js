// lib/deliveryBoardNotes.js — G7 (Nick, 28 Sep 2026): one shared notes panel at the top of
// the To-Be-Booked deliveries tab, for "when drivers are coming in next"
// (e.g. "Nelson — Thu 2 Oct AM; Cobbs — next Tues"). Not tied to any single delivery.
//
//   GET /api/delivery?resource=board-notes   no token — same as every other read on this tab
//   PUT /api/delivery?resource=board-notes   { body, base_version }  — editors only (token)
//
// Routed from lib/handlers/delivery.js (no new serverless function).
//
// The READ is deliberately token-less, like GET /api/delivery itself: the login JWT lasts 1h
// but a portal session outlives it, so a gated read would make the panel vanish for most of a
// shift ("everyone who can see the tab can read it"). The WRITE requires the token: the note
// is stamped with who saved it, so the actor must be real.
//
// Last write wins, but not silently: every save bumps `version`, and a save made on a stale
// version is refused with 409 + the current note, so the page can warn "Vincent saved since
// you opened this". "Overwrite with mine" is simply a save on the version the user was SHOWN —
// so a third person's save in the meantime is caught too (there is no blind force).
//
// The table arrives with migration 0007, which is applied to the Neon DEV branch only until
// Nick migrates prod at merge time — so a missing table (42P01) is an expected state here,
// not an error: reads say `available: false` (the panel hides) and saves get a plain 503.

import { requireRoles } from './rbac.js';

// `admin` is included because prod has no `logistics` users — the people who run deliveries
// log in as admin (see PR #107). Mirrors BOARD_NOTES_EDIT_ROLES in
// src/components/DeliveryBoardNotes.js; the server is the real authority.
export const BOARD_NOTES_EDIT_ROLES = ['logistics', 'admin', 'superadmin'];
export const BOARD_NOTE_MAX_LENGTH = 2000;
const BOARDS = ['to-be-booked'];

const NOTE_SELECT = `
  SELECT n.board, n.body, n.updated_by, n.updated_at, n.version, u.name AS updated_by_name
    FROM delivery_board_notes n
    LEFT JOIN users u ON u.id = n.updated_by
   WHERE n.board = $1
`;

// Insert the first note, or update it ONLY if the caller saw the current version.
// No row back = somebody else saved first.
const NOTE_UPSERT = `
  INSERT INTO delivery_board_notes (board, body, updated_by, updated_at, version)
  VALUES ($1, $2, $3, now(), 1)
  ON CONFLICT (board) DO UPDATE
     SET body = EXCLUDED.body,
         updated_by = EXCLUDED.updated_by,
         updated_at = now(),
         version = delivery_board_notes.version + 1
   WHERE delivery_board_notes.version = $4::int
  RETURNING version
`;

const emptyNote = (board, available) => ({
  board, body: '', updated_by: null, updated_by_name: null, updated_at: null, version: 0, available,
});
const shape = (row) => ({
  board: row.board,
  body: row.body || '',
  updated_by: row.updated_by || null,
  updated_by_name: row.updated_by_name || null,
  updated_at: row.updated_at || null,
  version: Number(row.version) || 0,
  available: true,
});

async function readNote(client, board) {
  const r = await client.query(NOTE_SELECT, [board]);
  return r.rows.length ? shape(r.rows[0]) : emptyNote(board, true);
}

export async function handleBoardNotes(req, res, client) {
  const { method } = req;
  if (method !== 'GET' && method !== 'PUT') {
    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed for board-notes' });
  }

  const gate = method === 'PUT' ? requireRoles(req, BOARD_NOTES_EDIT_ROLES) : { ok: true };
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const board = String(req.query?.board || BOARDS[0]);
  if (!BOARDS.includes(board)) return res.status(400).json({ error: 'Unknown notes board' });

  if (method === 'GET') {
    try {
      return res.status(200).json(await readNote(client, board));
    } catch (err) {
      if (err?.code !== '42P01') throw err; // only "table not migrated yet" is expected
      return res.status(200).json(emptyNote(board, false));
    }
  }

  const raw = req.body?.body;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'Note text is required' });
  // NUL can't be stored in a Postgres text column (22021) — drop it rather than 500.
  const text = raw.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  if (text.length > BOARD_NOTE_MAX_LENGTH) {
    return res.status(400).json({ error: `Notes are limited to ${BOARD_NOTE_MAX_LENGTH} characters` });
  }
  // The version the caller opened (0 = "there was no note"). Strict: a wrong type or an
  // out-of-range number is a client bug, not something to coerce into a save.
  const baseVersion = req.body?.base_version ?? 0;
  if (!Number.isInteger(baseVersion) || baseVersion < 0 || baseVersion > 2147483647) {
    return res.status(400).json({ error: 'base_version must be a whole number' });
  }

  try {
    const saved = await client.query(NOTE_UPSERT, [board, text, gate.auth.id, baseVersion]);
    const current = await readNote(client, board);
    if (!saved.rows.length) {
      return res.status(409).json({
        error: `${current.updated_by_name || current.updated_by || 'Someone'} saved these notes after you opened them`,
        current,
      });
    }
    return res.status(200).json(current);
  } catch (err) {
    if (err?.code !== '42P01') throw err;
    return res.status(503).json({ error: 'Delivery notes are not set up on this database yet' });
  }
}
