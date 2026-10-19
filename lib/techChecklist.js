// lib/techChecklist.js — G16 (Nick, 19 Oct 2026): the technician "Screen & Electronics
// Checklist" — the paper tag hung on cardio machines with consoles — recorded against a lot.
//
//   GET /api/lots?resource=tech-checklist&lot_number=L00042   the lot, its order, its checklist
//   PUT /api/lots?resource=tech-checklist                     save checklist / serials / sign-off
//
// Routed from lib/handlers/lots.js (no new serverless function), before the PUBLIC
// ?lot_number= lookup, which is left exactly as it is.
//
// Who: technicians, the workshop role and superadmin — plus the shared WK workshop login,
// which is an `admin` account on prod, so it is allowed by user id (nav.js already routes WK to
// the workshop view the same way). Admin otherwise sees the checklist read-only in the Lot
// Tracker. The order card carries NO customer name or phone: technicians don't need it.
//
// Serials: base + console are kept as separate fields here AND written back, as
// "<base> & CONSOLE <console>", to the workorder item (item_sn) and the lot (serial_number) so
// every existing page shows them. Blank serials never erase what is already recorded.
//
// Sign-off ("Screen OK to ship") is a record only: who + when, plus one NOTE_ADDED workorder log
// line. It never changes the item's workshop status (Nick, 19 Oct 2026).
//
// Last write wins, but not silently (same contract as G7's board notes): every save bumps
// `version`; a save on a stale version gets 409 + the current checklist.
//
// The table arrives with migration 0009 — Neon DEV only until Nick migrates prod at merge — so a
// missing table (42P01) is expected: GET says `available: false` (lot + order still shown) and
// PUT is a plain 503.

import { getAuthUser, hasAnyRole } from './rbac.js';

// ---- Definitions. Mirrored in src/utils/techChecklist.js (pinned equal by the smoke). ----
export const CHECK_ITEMS = [
  { key: 'boots_ok', label: 'Boots OK' },
  { key: 'touch_cal', label: 'Touch & Cal' },
  { key: 'screen_cont', label: 'Screen Cont.' },
  { key: 'heart_rate', label: 'Heart Rate' },
  { key: 'ergo_tog_cont', label: 'Ergo/Tog Cont.' },
  { key: 'wifi_connect', label: 'Wifi Connect' },
  { key: 'bt_connect', label: 'BT Connect' },
  { key: 'audio', label: 'Audio' },
  { key: 'rem_ads_dereg', label: 'Rem Ads / De-Reg' },
  { key: 'rem_old_chg_cables', label: 'Rem Old Chg Cables' },
  { key: 'chk_usb_corrosion', label: 'Chk USB Corrosion' },
  { key: 'fw_update', label: 'F/W Update' },
  { key: 'reset_metric', label: 'Reset to Metric' },
  { key: 'test_tag', label: 'Test & Tag' },
];
export const AUDIO_SUBS = [
  { key: 'jack', label: '3.5' },
  { key: 'bt', label: 'BT' },
  { key: 'spk', label: 'SPK' },
];
export const ANSWERS = ['yes', 'na'];
export const TECH_CHECKLIST_ROLES = ['technician', 'workshop', 'superadmin'];
export const WORKSHOP_ACCOUNT_ID = 'WK';
export const LIMITS = { note: 200, comments: 2000, serial: 60, test_tag_no: 30 };

/** Labels of the lines not yet answered Yes or N/A (sign-off needs this to be empty). */
export function unansweredItems(checks) {
  return CHECK_ITEMS.filter((i) => !ANSWERS.includes(checks?.[i.key]?.v)).map((i) => i.label);
}

/**
 * Split the free-text workorder serial into base + console. Only a part labelled CONSOLE is
 * treated as the console serial — two unlabelled serials stay together in base, no guessing.
 */
export function splitSerial(itemSn) {
  const text = String(itemSn ?? '').trim();
  if (!text) return { base_serial: '', console_serial: '' };
  const parts = text.split(/\s*&\s*/).filter(Boolean);
  const isConsole = (p) => /^CONSOLE\b|^CONSOLE(?=[A-Z0-9])/i.test(p);
  const consolePart = parts.find(isConsole);
  if (!consolePart) return { base_serial: text, console_serial: '' };
  return {
    base_serial: parts.filter((p) => p !== consolePart).join(' & '),
    console_serial: consolePart.replace(/^CONSOLE\s*[:#-]?\s*/i, '').trim(),
  };
}

/** "<base> & CONSOLE <console>"; null when both are blank (= leave the stored serial alone). */
export function combineSerial(base, consoleSn) {
  const b = String(base ?? '').trim();
  const c = String(consoleSn ?? '').trim();
  if (b && c) return `${b} & CONSOLE ${c}`;
  if (b) return b;
  if (c) return `CONSOLE ${c}`;
  return null;
}

// ---- Server ----

const clean = (s) => String(s ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

class BadRequest extends Error {}

function gate(req) {
  const auth = getAuthUser(req);
  if (!auth) return { ok: false, status: 401, error: 'Authentication required' };
  const byId = String(auth.id || '').toUpperCase() === WORKSHOP_ACCOUNT_ID;
  if (!byId && !hasAnyRole(auth.roles, TECH_CHECKLIST_ROLES)) {
    return { ok: false, status: 403, error: 'The checklist is for technicians and the workshop' };
  }
  return { ok: true, auth };
}

function readLotNumber(raw) {
  const lot = String(raw ?? '').trim().toUpperCase();
  if (!lot) throw new BadRequest('Provide a lot number');
  if (lot.length > 12) throw new BadRequest('That is not a lot number');
  return lot;
}

function readText(raw, limit, what) {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new BadRequest(`${what} must be text`);
  const t = clean(raw);
  if (t.length > limit) throw new BadRequest(`${what} is limited to ${limit} characters`);
  return t || null;
}

function readAnswer(v, label) {
  if (v == null || v === '') return null;
  if (!ANSWERS.includes(v)) throw new BadRequest(`Unknown answer for ${label} — use Yes or N/A`);
  return v;
}

/** Validate + normalise the checks object: every line present, unknown keys dropped. */
function normaliseChecks(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequest('The checklist answers are missing');
  }
  const out = {};
  for (const item of CHECK_ITEMS) {
    const line = raw[item.key] && typeof raw[item.key] === 'object' ? raw[item.key] : {};
    const entry = {
      v: readAnswer(line.v, item.label),
      note: readText(line.note ?? '', LIMITS.note, `The ${item.label} comment`) || '',
    };
    if (item.key === 'audio') {
      // Sub-ticks are informational; an unknown value is just "not ticked".
      for (const sub of AUDIO_SUBS) entry[sub.key] = ANSWERS.includes(line[sub.key]) ? line[sub.key] : null;
    }
    out[item.key] = entry;
  }
  return out;
}

const LOT_SELECT = `
  SELECT pl.lot_id, pl.lot_number, pl.status, pl.serial_number, pl.product_sku, pl.workorder_items_id,
         p.name AS product_name, p.brand AS product_brand,
         wi.workorder_id, wi.status AS item_status, wi.technician_id, wi.item_sn, tu.name AS technician_name,
         w.invoice_id, w.status AS workorder_status,
         to_char(w.estimated_completion, 'YYYY-MM-DD') AS estimated_completion,
         w.delivery_suburb, w.delivery_state
    FROM product_lots pl
    LEFT JOIN product p          ON p.sku = pl.product_sku
    LEFT JOIN workorder_items wi ON wi.workorder_items_id = pl.workorder_items_id
    LEFT JOIN users tu           ON tu.id = wi.technician_id
    LEFT JOIN workorder w        ON w.workorder_id = wi.workorder_id
   WHERE pl.lot_number = $1
`;
// Same row, locked for the save (only the lot row — the joined rows are read, not changed).
const LOT_LOCK = `${LOT_SELECT} FOR UPDATE OF pl`;

const CHECKLIST_SELECT = `
  SELECT c.lot_id, c.workorder_items_id, c.checks, c.test_tag_no, c.base_serial, c.console_serial,
         c.comments, c.ok_to_ship, c.approved_by, c.approved_at, c.updated_by, c.updated_at, c.version,
         ab.name AS approved_by_name, ub.name AS updated_by_name
    FROM lot_checklists c
    LEFT JOIN users ab ON ab.id = c.approved_by
    LEFT JOIN users ub ON ub.id = c.updated_by
   WHERE c.lot_id = $1
`;
const CHECKLIST_LOCK = `
  SELECT version, ok_to_ship, approved_by, approved_at FROM lot_checklists WHERE lot_id = $1 FOR UPDATE
`;

// Insert the first checklist, or update it ONLY if the caller saw the current version.
// No row back = somebody else saved first.
const CHECKLIST_UPSERT = `
  INSERT INTO lot_checklists
    (lot_id, workorder_items_id, checks, test_tag_no, base_serial, console_serial, comments,
     ok_to_ship, approved_by, approved_at, created_by, created_at, updated_by, updated_at, version)
  VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7,
          $8::boolean, $9, CASE WHEN $8::boolean THEN COALESCE($10::timestamptz, now()) END,
          $11, now(), $11, now(), 1)
  ON CONFLICT (lot_id) DO UPDATE
     SET workorder_items_id = EXCLUDED.workorder_items_id,
         checks = EXCLUDED.checks,
         test_tag_no = EXCLUDED.test_tag_no,
         base_serial = EXCLUDED.base_serial,
         console_serial = EXCLUDED.console_serial,
         comments = EXCLUDED.comments,
         ok_to_ship = EXCLUDED.ok_to_ship,
         approved_by = EXCLUDED.approved_by,
         approved_at = EXCLUDED.approved_at,
         updated_by = EXCLUDED.updated_by,
         updated_at = now(),
         version = lot_checklists.version + 1
   WHERE lot_checklists.version = $12::int
  RETURNING version
`;

function shapeLot(r) {
  return {
    lot_id: r.lot_id, lot_number: r.lot_number, status: r.status,
    serial_number: r.serial_number || null,
    product_sku: r.product_sku, product_name: r.product_name || null, product_brand: r.product_brand || null,
  };
}
function shapeOrder(r) {
  if (r.workorder_items_id == null || r.workorder_id == null) return null;
  return {
    workorder_id: r.workorder_id, workorder_items_id: r.workorder_items_id,
    invoice_id: r.invoice_id || null, workorder_status: r.workorder_status || null,
    estimated_completion: r.estimated_completion || null, item_status: r.item_status || null,
    delivery_suburb: r.delivery_suburb || null, delivery_state: r.delivery_state || null,
    technician_id: r.technician_id || null, technician_name: r.technician_name || null,
    item_sn: r.item_sn || null,
  };
}
function shapeChecklist(c) {
  return {
    checks: c.checks || {},
    test_tag_no: c.test_tag_no || '', base_serial: c.base_serial || '', console_serial: c.console_serial || '',
    comments: c.comments || '', ok_to_ship: !!c.ok_to_ship,
    approved_by: c.approved_by || null, approved_by_name: c.approved_by_name || null, approved_at: iso(c.approved_at),
    updated_by: c.updated_by || null, updated_by_name: c.updated_by_name || null, updated_at: iso(c.updated_at),
    version: Number(c.version) || 0,
  };
}

/** The full GET payload for one lot, or null when it doesn't exist. SELECTs only. */
async function readView(client, lotNumber) {
  const found = await client.query(LOT_SELECT, [lotNumber]);
  if (!found.rows.length) return null;
  const r = found.rows[0];
  let checklist = null;
  let available = true;
  try {
    const c = await client.query(CHECKLIST_SELECT, [r.lot_id]);
    checklist = c.rows.length ? shapeChecklist(c.rows[0]) : null;
  } catch (err) {
    if (err?.code !== '42P01') throw err; // only "table not migrated yet" is expected
    available = false;
  }
  const prefill = checklist && (checklist.base_serial || checklist.console_serial)
    ? { base_serial: checklist.base_serial, console_serial: checklist.console_serial }
    : splitSerial(r.item_sn || r.serial_number);
  return { available, lot: shapeLot(r), order: shapeOrder(r), checklist, prefill };
}

function readSave(body) {
  const b = body && typeof body === 'object' ? body : {};
  const lotNumber = readLotNumber(b.lot_number);
  const checks = normaliseChecks(b.checks);
  const okToShip = b.ok_to_ship ?? false;
  if (typeof okToShip !== 'boolean') throw new BadRequest('ok_to_ship must be true or false');
  const baseVersion = b.base_version ?? 0;
  if (!Number.isInteger(baseVersion) || baseVersion < 0 || baseVersion > 2147483647) {
    throw new BadRequest('base_version must be a whole number');
  }
  const save = {
    lotNumber, checks, okToShip, baseVersion,
    testTagNo: readText(b.test_tag_no, LIMITS.test_tag_no, 'Test & Tag No.'),
    baseSerial: readText(b.base_serial, LIMITS.serial, 'The base serial number'),
    consoleSerial: readText(b.console_serial, LIMITS.serial, 'The console serial number'),
    comments: readText(b.comments, LIMITS.comments, 'Comments'),
  };
  if (okToShip) {
    const missing = unansweredItems(checks);
    if (missing.length) throw new BadRequest(`Answer every line (Yes or N/A) before signing off. Still to do: ${missing.join(', ')}`);
  }
  return save;
}

async function save(client, s, userId) {
  await client.query('BEGIN');
  try {
    const found = await client.query(LOT_LOCK, [s.lotNumber]);
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: `No lot found for ${s.lotNumber}` } };
    }
    const lot = found.rows[0];
    const existing = (await client.query(CHECKLIST_LOCK, [lot.lot_id])).rows[0] || null;
    const conflict = async () => {
      await client.query('ROLLBACK');
      const current = await readView(client, s.lotNumber);
      const who = current?.checklist?.updated_by_name || current?.checklist?.updated_by || 'Someone';
      return { status: 409, body: { error: `${who} saved this checklist after you opened it`, current } };
    };
    if ((existing ? Number(existing.version) : 0) !== s.baseVersion) return conflict();

    const wasSigned = !!existing?.ok_to_ship;
    const approvedBy = s.okToShip ? (wasSigned ? existing.approved_by : userId) : null;
    const approvedAt = s.okToShip && wasSigned ? existing.approved_at : null;
    const saved = await client.query(CHECKLIST_UPSERT, [
      lot.lot_id, lot.workorder_items_id ?? null, JSON.stringify(s.checks), s.testTagNo,
      s.baseSerial, s.consoleSerial, s.comments, s.okToShip, approvedBy, approvedAt, userId, s.baseVersion,
    ]);
    if (!saved.rows.length) return conflict();

    const serial = combineSerial(s.baseSerial, s.consoleSerial);
    if (serial) {
      await client.query('UPDATE product_lots SET serial_number = $1, updated_at = NOW() WHERE lot_id = $2', [serial, lot.lot_id]);
      if (lot.workorder_items_id != null) {
        await client.query('UPDATE workorder_items SET item_sn = $1 WHERE workorder_items_id = $2', [serial, lot.workorder_items_id]);
      }
    }
    if (s.okToShip && !wasSigned && lot.workorder_id != null) {
      await client.query(
        `INSERT INTO workorder_logs (workorder_id, workorder_items_id, event_type, user_id, item_status, notes_log)
         VALUES ($1, $2, 'NOTE_ADDED', $3, NULL, $4)`,
        [lot.workorder_id, lot.workorder_items_id, userId,
          `Screen & electronics checklist signed off — OK to ship (lot ${lot.lot_number})`]
      );
    }
    await client.query('COMMIT');
    return { status: 200, body: await readView(client, s.lotNumber) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    if (err?.code === '42P01') return { status: 503, body: { error: 'The technician checklist is not set up on this database yet' } };
    throw err;
  }
}

export async function handleTechChecklist(req, res, client) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed for the checklist' });
  }
  const g = gate(req);
  if (!g.ok) return res.status(g.status).json({ error: g.error });

  try {
    if (req.method === 'GET') {
      const lotNumber = readLotNumber(req.query?.lot_number);
      const view = await readView(client, lotNumber);
      if (!view) return res.status(404).json({ error: `No lot found for ${lotNumber}` });
      return res.status(200).json(view);
    }
    const s = readSave(req.body);
    const out = await save(client, s, String(g.auth.id).toUpperCase().slice(0, 2));
    return res.status(out.status).json(out.body);
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    throw err;
  }
}
