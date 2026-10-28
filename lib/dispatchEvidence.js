// lib/dispatchEvidence.js — G18 (owner, 28 Oct 2026): photos and videos of each workorder item,
// saved as "dispatch evidence" to the SharePoint shared drive.
//
//   GET    /api/evidence?resource=list&workorder_id=731    items + their recorded files
//   POST   /api/evidence?resource=upload-session           { workorder_id, workorder_items_id, file_name, size }
//   POST   /api/evidence?resource=complete                 { workorder_id, workorder_items_id, drive_item_id }
//   DELETE /api/evidence?resource=file&id=12               superadmin only
//
// Routed from api/[...path].js via lib/handlers/evidence.js (no new serverless function).
//
// Layout (owner decision 2): <MS_EVIDENCE_FOLDER>/<invoice> - WO <id>/<item> - item <id>/<files>.
// invoice_id is NOT unique (dev snapshot: 570 workorders, 553 invoices) and can hold "/" or "&",
// so the WO number keeps each folder unique, names are cleaned, and the folder ids are stored
// (dispatch_evidence_folders) — a later invoice change never splits or orphans a folder.
//
// Who (owner decision 3): upload = logistics, admin, superadmin, technician, workshop and the WK
// kiosk (allowed by id, as in lib/techChecklist.js); delete = superadmin only. Any logged-in user
// may view. Optional, no "no evidence yet" badge (decision 4). 300 MB per file (decision 5).
//
// Flow: upload-session ensures the folders and returns a one-off SharePoint upload URL; the
// browser PUTs the file there in chunks (Phase 0: CORS allows it); complete re-reads the item
// from Graph, checks it sits in THIS item's folder and is within the limits, records it and adds
// one NOTE_ADDED workorder log line. No file content ever passes through or is stored by the portal.
//
// The tables arrive with migration 0010 — Neon DEV only until the owner migrates prod at merge —
// so a missing table (42P01) is expected: list says `available: false`, writes are 503.

import { getAuthUser, hasAnyRole } from './rbac.js';
import { GraphError, getGraph, isGraphConfigured } from './msgraph.js';

// ---- Definitions (mirrored for the screens in src/utils/dispatchEvidence.js). ----
export const EVIDENCE_UPLOAD_ROLES = ['logistics', 'admin', 'superadmin', 'technician', 'workshop'];
export const EVIDENCE_DELETE_ROLES = ['superadmin'];
export const WORKSHOP_ACCOUNT_ID = 'WK';
export const MAX_FILE_BYTES = 300 * 1024 * 1024;
// 10 MiB: a multiple of 320 KiB (Graph's rule) and well under its 60 MiB per-request cap.
export const CHUNK_BYTES = 32 * 320 * 1024;
export const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'mp4', 'mov', 'm4v'];
// Owner, 28 Oct 2026: "OTHER equipment doesn't require any evidence pictures." SKU OTHER is the
// "Custom / Misc Item" product every custom line uses — not listed, no folder, uploads refused.
export const NO_EVIDENCE_SKUS = ['OTHER'];
const MAX_NAME = 100;
const TIME_ZONE = 'Australia/Melbourne';

// ---- Names ----

/** A SharePoint-safe name: refused characters → "-", spaces collapsed, no leading/trailing dots. */
export function cleanName(raw) {
  const tidy = (s) => s.replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  // eslint-disable-next-line no-control-regex
  return tidy(tidy(String(raw ?? '').replace(/["*:<>?/\\|\u0000-\u001f]/g, '-')).slice(0, MAX_NAME));
}

export function workorderFolderName({ invoice_id, workorder_id }) {
  return `${cleanName(invoice_id) || 'No invoice'} - WO ${workorder_id}`;
}

/** What the item is, for folder names, log lines and the screen. */
export function itemLabel(item) {
  if (item.is_custom) return cleanName(item.custom_description) || 'Custom item';
  return cleanName([item.product_id, item.product_name].filter(Boolean).join(' ')) || 'Item';
}

/** Does this workorder item take dispatch evidence? (Not SKU OTHER.) */
export function needsEvidence(item) {
  return !NO_EVIDENCE_SKUS.includes(String(item?.product_id ?? '').trim().toUpperCase());
}

export function itemFolderName(item) {
  return `${itemLabel(item).slice(0, 80).trim()} - item ${item.workorder_items_id}`;
}

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v'];

/**
 * "2026-10-28 14-32-10 <original>" in Melbourne time, so files sort in the order they were taken.
 * Only the base name is cleaned and shortened — the extension always survives (a truncated
 * extension would make `complete` refuse and delete the finished upload).
 */
export function evidenceFileName(original, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const raw = String(original ?? '').trim();
  const m = /\.([a-z0-9]+)$/i.exec(raw);
  const ext = m ? m[1] : '';
  const fallback = VIDEO_EXTENSIONS.includes(ext.toLowerCase()) ? 'video' : 'photo';
  const base = cleanName(m ? raw.slice(0, -m[0].length) : raw).slice(0, 80).trim() || fallback;
  return `${p.year}-${p.month}-${p.day} ${p.hour}-${p.minute}-${p.second} ${base}${ext ? `.${ext}` : ''}`;
}

export function isAllowedFileName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  return !!m && ALLOWED_EXTENSIONS.includes(m[1].toLowerCase());
}

// ---- Server ----

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const canUpload = (auth) => String(auth.id || '').toUpperCase() === WORKSHOP_ACCOUNT_ID || hasAnyRole(auth.roles, EVIDENCE_UPLOAD_ROLES);
const canDelete = (auth) => hasAnyRole(auth.roles, EVIDENCE_DELETE_ROLES);
const actorId = (auth) => String(auth.id || '').toUpperCase().slice(0, 2);
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

function readId(raw, what) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw bad(`${what} must be a whole number`);
  return n;
}

const WORKORDER_ITEMS = `
  SELECT w.workorder_id, w.invoice_id,
         wi.workorder_items_id, wi.product_id, wi.is_custom, wi.custom_description, p.name AS product_name
    FROM workorder w
    LEFT JOIN workorder_items wi ON wi.workorder_id = w.workorder_id
    LEFT JOIN product p          ON p.sku = wi.product_id
   WHERE w.workorder_id = $1
   ORDER BY wi.workorder_items_id
`;
// The workorder folder is stored with workorder_items_id NULL; the unique index keys it as 0.
const FOLDER_ONE = `
  SELECT workorder_items_id, drive_item_id, name, web_url
    FROM dispatch_evidence_folders
   WHERE workorder_id = $1 AND COALESCE(workorder_items_id, 0) = $2
`;
const FOLDERS_FOR_WO = `
  SELECT workorder_items_id, drive_item_id, name, web_url
    FROM dispatch_evidence_folders
   WHERE workorder_id = $1
`;
const FOLDER_INSERT = `
  INSERT INTO dispatch_evidence_folders (workorder_id, workorder_items_id, drive_item_id, name, web_url, created_by)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (workorder_id, (COALESCE(workorder_items_id, 0))) DO NOTHING
`;
const FOLDERS_FORGET = 'DELETE FROM dispatch_evidence_folders WHERE workorder_id = $1';
const FILE_INSERT = `
  INSERT INTO dispatch_evidence_files
    (workorder_id, workorder_items_id, drive_item_id, file_name, mime_type, size_bytes, web_url, uploaded_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (drive_item_id) DO NOTHING
  RETURNING id
`;
const FILES_FOR_WO = `
  SELECT f.id, f.workorder_items_id, f.drive_item_id, f.file_name, f.mime_type, f.size_bytes, f.web_url,
         f.uploaded_by, f.uploaded_at, u.name AS uploaded_by_name
    FROM dispatch_evidence_files f
    LEFT JOIN users u ON u.id = f.uploaded_by
   WHERE f.workorder_id = $1 AND f.deleted_at IS NULL
   ORDER BY f.uploaded_at, f.id
`;
const FILE_ONE = `
  SELECT id, workorder_id, workorder_items_id, drive_item_id, file_name
    FROM dispatch_evidence_files
   WHERE id = $1 AND deleted_at IS NULL
`;
const FILE_BY_DRIVE_ITEM = 'SELECT id FROM dispatch_evidence_files WHERE drive_item_id = $1';
const FILE_SOFT_DELETE = `
  UPDATE dispatch_evidence_files SET deleted_at = now(), deleted_by = $2
   WHERE id = $1 AND deleted_at IS NULL
  RETURNING id
`;
// Owner, 28 Oct 2026: once the order is dispatched, the workorder shows a button to open the
// evidence folder. Dispatched = a delivery on it is "Delivery Completed" — the moment
// lib/handlers/delivery.js writes ORDER_DISPATCHED (the lot tracker reads it the same way).
const DISPATCHED = `
  SELECT EXISTS (
    SELECT 1 FROM delivery d WHERE d.workorder_id = $1 AND d.delivery_status = 'Delivery Completed'
  ) AS dispatched
`;
const LOG_NOTE = `
  INSERT INTO workorder_logs (workorder_id, workorder_items_id, event_type, user_id, item_status, notes_log)
  VALUES ($1, $2, 'NOTE_ADDED', $3, NULL, $4)
`;

/** The workorder + its items, or a 404. */
async function loadWorkorder(client, workorderId) {
  const r = await client.query(WORKORDER_ITEMS, [workorderId]);
  if (!r.rows.length) throw new HttpError(404, `Workorder ${workorderId} not found`);
  const { invoice_id } = r.rows[0];
  const items = r.rows.filter((x) => x.workorder_items_id != null);
  return { workorder_id: workorderId, invoice_id, items };
}

async function storedFolder(client, workorderId, itemId) {
  const r = await client.query(FOLDER_ONE, [workorderId, itemId || 0]);
  return r.rows[0] || null;
}

/** The stored folder, or create it in SharePoint and store it. Concurrent callers converge. */
async function ensureStoredFolder(client, graph, { workorderId, itemId, parentId, name, userId }) {
  const have = await storedFolder(client, workorderId, itemId);
  if (have) return have;
  const made = await graph.ensureFolder(parentId, name);
  await client.query(FOLDER_INSERT, [workorderId, itemId || null, made.id, made.name || name, made.webUrl, userId]);
  return (await storedFolder(client, workorderId, itemId)) || { drive_item_id: made.id, web_url: made.webUrl };
}

async function ensureItemFolder(client, graph, wo, item, userId) {
  const root = await graph.rootFolder();
  const woFolder = await ensureStoredFolder(client, graph, {
    workorderId: wo.workorder_id, itemId: null, parentId: root.id, name: workorderFolderName(wo), userId,
  });
  return ensureStoredFolder(client, graph, {
    workorderId: wo.workorder_id, itemId: item.workorder_items_id, parentId: woFolder.drive_item_id, name: itemFolderName(item), userId,
  });
}

function readSessionBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const workorderId = readId(b.workorder_id, 'workorder_id');
  const itemId = readId(b.workorder_items_id, 'workorder_items_id');
  const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
  if (!fileName || fileName.length > 200) throw bad('Give the file a name (up to 200 characters)');
  if (!isAllowedFileName(fileName)) throw bad(`Only photos and videos can be uploaded (${ALLOWED_EXTENSIONS.join(', ')})`);
  const size = Number(b.size);
  if (!Number.isInteger(size) || size <= 0) throw bad('The file is empty');
  if (size > MAX_FILE_BYTES) throw bad('Files are limited to 300 MB each');
  return { workorderId, itemId, fileName };
}

async function uploadSession(req, res, client, graph, auth) {
  const s = readSessionBody(req.body);
  const wo = await loadWorkorder(client, s.workorderId);
  const item = wo.items.find((i) => i.workorder_items_id === s.itemId);
  if (!item) throw new HttpError(404, `Item ${s.itemId} is not on workorder ${s.workorderId}`);
  if (!needsEvidence(item)) throw bad('OTHER (custom / misc) items do not need dispatch evidence');
  const name = evidenceFileName(s.fileName);
  const userId = actorId(auth);

  let folder = await ensureItemFolder(client, graph, wo, item, userId);
  let session;
  try {
    session = await graph.createUploadSession(folder.drive_item_id, name);
  } catch (err) {
    if (!(err instanceof GraphError) || err.status !== 404) throw err;
    // The stored folder was deleted in SharePoint: forget this workorder's folders, recreate once.
    // (Surviving item folders re-resolve by name; files recorded in a deleted folder keep their
    // rows, so their links go dead — a deleted evidence root is not recovered here: 502.)
    await client.query(FOLDERS_FORGET, [wo.workorder_id]);
    folder = await ensureItemFolder(client, graph, wo, item, userId);
    session = await graph.createUploadSession(folder.drive_item_id, name);
  }
  return res.status(200).json({
    upload_url: session.uploadUrl, expires_at: session.expiresAt, chunk_bytes: CHUNK_BYTES, file_name: name,
  });
}

async function complete(req, res, client, graph, auth) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const workorderId = readId(b.workorder_id, 'workorder_id');
  const itemId = readId(b.workorder_items_id, 'workorder_items_id');
  // By id normally; by the name upload-session gave the file when the browser never saw the
  // final reply (the last chunk landed, its response was lost on a bad connection).
  const driveItemId = typeof b.drive_item_id === 'string' ? b.drive_item_id.trim() : '';
  const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
  if (!driveItemId && !fileName) throw bad('drive_item_id or file_name is required');
  if (driveItemId.length > 200 || fileName.length > 250 || /[/\\]/.test(fileName)) throw bad('That is not a file in this folder');

  const folder = await storedFolder(client, workorderId, itemId);
  if (!folder) throw bad('No evidence folder exists for that item yet');
  let item;
  try {
    item = driveItemId ? await graph.getItem(driveItemId) : await graph.getChild(folder.drive_item_id, fileName);
  } catch (err) {
    if (err instanceof GraphError && (err.status === 404 || err.status === 400)) throw bad('That file was not found in SharePoint');
    throw err;
  }
  if (item?.parentReference?.id !== folder.drive_item_id || !item.file) throw bad("That file is not in this item's evidence folder");
  // Already recorded (a retry, e.g. after a re-login): answer as before and NEVER delete it here —
  // removing a recorded file is superadmin-only, even if it was renamed in SharePoint since.
  const known = (await client.query(FILE_BY_DRIVE_ITEM, [item.id])).rows[0];
  if (known) return res.status(200).json({ recorded: true, id: known.id, file_name: item.name });
  if (!isAllowedFileName(item.name) || !(Number(item.size) > 0 && Number(item.size) <= MAX_FILE_BYTES)) {
    await graph.deleteItem(item.id); // it is ours (in our folder) and over the limits
    throw bad('Only photos and videos up to 300 MB each can be kept — the file was removed');
  }
  const userId = actorId(auth);
  await client.query('BEGIN');
  try {
    const ins = await client.query(FILE_INSERT, [
      workorderId, itemId, item.id, item.name, item.file.mimeType || null, Number(item.size) || null, item.webUrl || null, userId,
    ]);
    if (ins.rows.length) {
      const wo = await loadWorkorder(client, workorderId);
      const it = wo.items.find((i) => i.workorder_items_id === itemId);
      await client.query(LOG_NOTE, [workorderId, itemId, userId, `Dispatch evidence added — ${item.name}${it ? ` (${itemLabel(it)})` : ''}`]);
    }
    await client.query('COMMIT');
    return res.status(200).json({ recorded: true, id: ins.rows[0]?.id ?? null, file_name: item.name });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

async function removeFile(req, res, client, graph, auth) {
  if (!canDelete(auth)) throw new HttpError(403, 'Only a superadmin can delete dispatch evidence');
  const id = readId(req.query?.id, 'id');
  const f = (await client.query(FILE_ONE, [id])).rows[0];
  if (!f) throw new HttpError(404, 'That file is not recorded (or was already deleted)');
  await graph.deleteItem(f.drive_item_id); // goes to the SharePoint recycle bin
  const userId = actorId(auth);
  await client.query('BEGIN');
  try {
    const done = await client.query(FILE_SOFT_DELETE, [id, userId]);
    if (done.rows.length) {
      await client.query(LOG_NOTE, [f.workorder_id, f.workorder_items_id, userId, `Dispatch evidence removed — ${f.file_name}`]);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return res.status(200).json({ deleted: true });
}

async function list(req, res, client, graph, auth, configured) {
  const workorderId = readId(req.query?.workorder_id, 'workorder_id');
  const wo = await loadWorkorder(client, workorderId);
  const dispatched = !!(await client.query(DISPATCHED, [workorderId])).rows[0]?.dispatched;
  let available = true;
  let folders = [];
  let files = [];
  try {
    folders = (await client.query(FOLDERS_FOR_WO, [workorderId])).rows;
    files = (await client.query(FILES_FOR_WO, [workorderId])).rows;
  } catch (err) {
    if (err?.code !== '42P01') throw err;
    available = false;
  }

  // Thumbnails are short-lived Graph URLs: fetched per item folder, and never fatal.
  const thumbs = new Map();
  if (configured && files.length) {
    const withFiles = new Set(files.map((f) => f.workorder_items_id));
    await Promise.all(folders.filter((f) => f.workorder_items_id != null && withFiles.has(f.workorder_items_id)).map(async (f) => {
      try {
        for (const c of await graph.childrenWithThumbnails(f.drive_item_id)) thumbs.set(c.id, c.thumbnail);
      } catch (err) {
        console.error('dispatch evidence thumbnails:', err?.message);
      }
    }));
  }

  const woFolder = folders.find((f) => f.workorder_items_id == null);
  return res.status(200).json({
    configured, available, dispatched,
    can_upload: canUpload(auth), can_delete: canDelete(auth),
    max_file_bytes: MAX_FILE_BYTES, allowed_extensions: ALLOWED_EXTENSIONS,
    folder_url: woFolder?.web_url || null,
    items: wo.items.filter(needsEvidence).map((i) => ({
      workorder_items_id: i.workorder_items_id,
      label: itemLabel(i),
      folder_url: folders.find((f) => f.workorder_items_id === i.workorder_items_id)?.web_url || null,
      files: files.filter((f) => f.workorder_items_id === i.workorder_items_id).map((f) => ({
        id: f.id, file_name: f.file_name, mime_type: f.mime_type || null,
        size_bytes: f.size_bytes == null ? null : Number(f.size_bytes), web_url: f.web_url || null,
        uploaded_by: f.uploaded_by || null, uploaded_by_name: f.uploaded_by_name || null, uploaded_at: iso(f.uploaded_at),
        thumbnail_url: thumbs.get(f.drive_item_id) || null,
      })),
    })),
  });
}

const ROUTES = {
  list: 'GET',
  'upload-session': 'POST',
  complete: 'POST',
  file: 'DELETE',
};

/** `deps.graph` / `deps.configured` let the smoke run offline. */
export async function handleEvidence(req, res, client, deps = {}) {
  const resource = String(req.query?.resource || '');
  const method = ROUTES[resource];
  if (!method) return res.status(400).json({ error: 'Unknown evidence resource' });
  if (req.method !== method) {
    res.setHeader('Allow', [method]);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Authentication required' });

  const configured = deps.configured ?? isGraphConfigured();
  const graph = deps.graph || (configured ? getGraph() : null);
  try {
    if (resource === 'list') return await list(req, res, client, graph, auth, configured);
    if (resource === 'file' && !canDelete(auth)) throw new HttpError(403, 'Only a superadmin can delete dispatch evidence');
    if (resource !== 'file' && !canUpload(auth)) {
      throw new HttpError(403, 'Dispatch evidence can be uploaded by logistics, admin, technicians and the workshop');
    }
    if (!configured) throw new HttpError(503, 'Dispatch evidence is not set up yet (Microsoft connection missing)');
    if (resource === 'upload-session') return await uploadSession(req, res, client, graph, auth);
    if (resource === 'complete') return await complete(req, res, client, graph, auth);
    return await removeFile(req, res, client, graph, auth);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.code === '42P01') return res.status(503).json({ error: 'Dispatch evidence is not set up on this database yet' });
    if (err instanceof GraphError) {
      console.error('dispatch evidence graph error:', err.status, err.code, err.message);
      const msg = err.kind === 'auth'
        ? 'The portal could not log in to Microsoft — the app secret may have expired'
        : `The Microsoft shared drive refused the request: ${err.message}`;
      return res.status(502).json({ error: msg, code: err.code || null });
    }
    throw err;
  }
}
