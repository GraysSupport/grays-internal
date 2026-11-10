// lib/beforePhotos.js — G27 (owner, 10 Nov 2026): photos / videos of a machine BEFORE it is
// refurbished, per lot, saved in SharePoint next to its dispatch evidence. Evidence of the
// before/after condition, and a reference for technicians on how it was assembled.
//
//   GET    /api/evidence?resource=before-list&lot_id=55         the lot + its recorded photos
//   POST   /api/evidence?resource=before-upload-session         { lot_id, file_name, size }
//   POST   /api/evidence?resource=before-complete               { lot_id, drive_item_id | file_name + size }
//   DELETE /api/evidence?resource=before-file&id=12             superadmin only
//
// Routed from handleEvidence (lib/dispatchEvidence.js) — no new serverless function. Same rules
// as G18 (owner decision 4): upload = logistics/admin/superadmin/technician/workshop + the WK
// kiosk; delete = superadmin; view = any logged-in user; photos + videos, 300 MB each.
//
// Where (owner decisions 1 + 2, approved 10 Nov 2026): each lot has ONE folder.
//   In Stock / not on a workorder → <root>/In-stock lots/Lot <lot> <SKU>
//   Assigned to a workorder item  → <root>/<invoice> - WO <id>/<item> - item <id>/Before refurbishment - Lot <lot>
// When the lot's place changes (assigned, released, reassigned) the folder is MOVED (same item
// id, files kept) the next time anyone opens or uploads that lot's photos. The lot assign /
// unassign endpoints are deliberately not touched, so tagging a lot never waits on Microsoft —
// and a refused move never breaks anything: the photos stay where they were until next time.
//
// Old stock WITHOUT lot numbers (owner, 10 Nov 2026: "some old stock doesn't have them"): the
// photos attach to the WORKORDER ITEM instead — `workorder_items_id` in place of `lot_id` on every
// call — in <root>/<invoice> - WO <id>/<item> - item <id>/Before refurbishment (never moves; the
// item is fixed to its workorder). Stored in lot_photos with lot_id NULL; folder in
// item_photo_folders. Custom / OTHER lines are excluded, as for dispatch evidence.
//
// Tables arrive with migration 0013 (Neon DEV only until the owner migrates prod at merge):
// a missing table (42P01) → list `available: false`, writes 503.

import {
  ALLOWED_EXTENSIONS, CHUNK_BYTES, HttpError, MAX_FILE_BYTES, actorId, bad, canDelete, canUpload,
  cleanName, ensureItemFolder, evidenceFileName, iso, isAllowedFileName, itemLabel, loadWorkorder, needsEvidence, readId,
} from './dispatchEvidence.js';
import { getAuthUser } from './rbac.js';
import { GraphError, getGraph, isGraphConfigured } from './msgraph.js';

export const IN_STOCK_FOLDER = 'In-stock lots';
export const ITEM_BEFORE_FOLDER = 'Before refurbishment';

const ROUTES = {
  'before-list': 'GET',
  'before-upload-session': 'POST',
  'before-complete': 'POST',
  'before-file': 'DELETE',
};
export const isBeforeResource = (resource) => String(resource || '').startsWith('before-');

/** Is the lot on a workorder item (tagged as sold)? Mirrored in src/utils/beforePhotos.js. */
export function isPlaced(lot) {
  return lot?.status === 'Assigned' && lot.workorder_items_id != null && lot.workorder_id != null;
}

export function lotFolderName(lot, placed) {
  const n = cleanName(lot.lot_number) || `lot ${lot.lot_id}`;
  return placed ? `Before refurbishment - Lot ${n}` : cleanName(`Lot ${n} ${cleanName(lot.product_sku)}`);
}

const LOT_ONE = `
  SELECT pl.lot_id, pl.lot_number, pl.product_sku, pl.status::text AS status, pl.workorder_items_id, wi.workorder_id
    FROM product_lots pl
    LEFT JOIN workorder_items wi ON wi.workorder_items_id = pl.workorder_items_id
   WHERE pl.lot_id = $1
`;
const FOLDER_ONE = `
  SELECT lot_id, drive_item_id, name, web_url, workorder_items_id
    FROM lot_photo_folders
   WHERE lot_id = $1
`;
const FOLDER_INSERT = `
  INSERT INTO lot_photo_folders (lot_id, drive_item_id, name, web_url, workorder_items_id, created_by)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (lot_id) DO NOTHING
`;
const FOLDER_MOVED = `
  UPDATE lot_photo_folders SET name = $2, web_url = $3, workorder_items_id = $4, moved_at = now()
   WHERE lot_id = $1
`;
const FOLDER_FORGET = 'DELETE FROM lot_photo_folders WHERE lot_id = $1';
// G18's stored workorder/item folders, when SharePoint says one is gone (same as G18 does).
const DISPATCH_FOLDERS_FORGET = 'DELETE FROM dispatch_evidence_folders WHERE workorder_id = $1';
// Items without a lot (G27, owner 10 Nov 2026).
const ITEM_WORKORDER = 'SELECT workorder_id FROM workorder_items WHERE workorder_items_id = $1';
const ITEM_FOLDER_ONE = `
  SELECT workorder_items_id, drive_item_id, name, web_url
    FROM item_photo_folders
   WHERE workorder_items_id = $1
`;
const ITEM_FOLDER_INSERT = `
  INSERT INTO item_photo_folders (workorder_items_id, workorder_id, drive_item_id, name, web_url, created_by)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (workorder_items_id) DO NOTHING
`;
const ITEM_FOLDER_FORGET = 'DELETE FROM item_photo_folders WHERE workorder_items_id = $1';
const PHOTOS_FOR_ITEM = `
  SELECT p.id, p.workorder_items_id, p.drive_item_id, p.file_name, p.mime_type, p.size_bytes, p.web_url,
         p.uploaded_by, p.uploaded_at, u.name AS uploaded_by_name
    FROM lot_photos p
    LEFT JOIN users u ON u.id = p.uploaded_by
   WHERE p.lot_id IS NULL AND p.workorder_items_id = $1 AND p.deleted_at IS NULL
   ORDER BY p.uploaded_at, p.id
`;
const PHOTO_INSERT = `
  INSERT INTO lot_photos
    (lot_id, workorder_items_id, drive_item_id, file_name, mime_type, size_bytes, web_url, uploaded_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (drive_item_id) DO NOTHING
  RETURNING id
`;
const PHOTOS_FOR_LOT = `
  SELECT p.id, p.workorder_items_id, p.drive_item_id, p.file_name, p.mime_type, p.size_bytes, p.web_url,
         p.uploaded_by, p.uploaded_at, u.name AS uploaded_by_name
    FROM lot_photos p
    LEFT JOIN users u ON u.id = p.uploaded_by
   WHERE p.lot_id = $1 AND p.deleted_at IS NULL
   ORDER BY p.uploaded_at, p.id
`;
const PHOTO_ONE = `
  SELECT id, lot_id, workorder_items_id, drive_item_id, file_name
    FROM lot_photos
   WHERE id = $1 AND deleted_at IS NULL
`;
const PHOTO_BY_DRIVE_ITEM = 'SELECT id FROM lot_photos WHERE drive_item_id = $1';
const PHOTO_SOFT_DELETE = `
  UPDATE lot_photos SET deleted_at = now(), deleted_by = $2
   WHERE id = $1 AND deleted_at IS NULL
  RETURNING id
`;
const LOG_NOTE = `
  INSERT INTO workorder_logs (workorder_id, workorder_items_id, event_type, user_id, item_status, notes_log)
  VALUES ($1, $2, 'NOTE_ADDED', $3, NULL, $4)
`;

async function loadLot(client, lotId) {
  const lot = (await client.query(LOT_ONE, [lotId])).rows[0];
  if (!lot) throw new HttpError(404, `Lot ${lotId} not found`);
  return lot;
}

async function storedFolder(client, lotId) {
  return (await client.query(FOLDER_ONE, [lotId])).rows[0] || null;
}

/** Where the lot's folder belongs now: { parentId, name, itemId }. */
async function targetFor(client, graph, lot, userId) {
  if (isPlaced(lot)) {
    const wo = await loadWorkorder(client, lot.workorder_id);
    const item = wo.items.find((i) => i.workorder_items_id === lot.workorder_items_id);
    if (item) {
      const itemFolder = await ensureItemFolder(client, graph, wo, item, userId);
      return { parentId: itemFolder.drive_item_id, name: lotFolderName(lot, true), itemId: item.workorder_items_id };
    }
  }
  const root = await graph.rootFolder();
  let areaId = areaIds.get(graph)?.[root.id];
  if (!areaId) {
    areaId = (await graph.ensureFolder(root.id, IN_STOCK_FOLDER)).id;
    areaIds.set(graph, { [root.id]: areaId });
  }
  return { parentId: areaId, name: lotFolderName(lot, false), itemId: null };
}
// The "In-stock lots" folder id per Graph client + evidence root, kept for the warm instance
// (saves 2–3 Graph calls per move/create).
const areaIds = new WeakMap();

const isNotFound = (err) => err instanceof GraphError && err.status === 404;

/**
 * Run `fn(target)`; if SharePoint says the destination is gone (404 — a workorder/item folder
 * or the In-stock area deleted or renamed by hand), forget the stale stored ids and try once
 * more against freshly resolved folders. G18's item folders re-resolve by name, as in G18.
 */
async function withTarget(client, graph, lot, userId, fn) {
  let t = await targetFor(client, graph, lot, userId);
  try {
    return { t, out: await fn(t) };
  } catch (err) {
    if (!isNotFound(err)) throw err;
    if (t.itemId != null) await client.query(DISPATCH_FOLDERS_FORGET, [lot.workorder_id]);
    else areaIds.delete(graph);
    t = await targetFor(client, graph, lot, userId);
    return { t, out: await fn(t) };
  }
}

/** Is this SharePoint item really gone? (Only a 404 on the item itself says so.) */
async function itemGone(graph, id) {
  try {
    await graph.getItem(id);
    return false;
  } catch (err) {
    return isNotFound(err);
  }
}

const wantedItem = (lot) => (isPlaced(lot) ? lot.workorder_items_id : null);
const inPlace = (folder, lot) => (folder.workorder_items_id ?? null) === wantedItem(lot);

/**
 * Move a stored folder that is out of place. Best effort: a refused move is logged and the
 * folder stays where it is (photos still reachable). Returns the folder row, or null ONLY when
 * the lot folder itself was deleted in SharePoint — never because its destination was missing.
 */
async function relocate(client, graph, lot, folder, userId) {
  if (inPlace(folder, lot)) return folder;
  try {
    if (await itemGone(graph, folder.drive_item_id)) {
      await client.query(FOLDER_FORGET, [lot.lot_id]);
      return null;
    }
    const { t, out: moved } = await withTarget(client, graph, lot, userId, (x) => graph.moveItem(folder.drive_item_id, x.parentId, x.name));
    await client.query(FOLDER_MOVED, [lot.lot_id, moved.name || t.name, moved.webUrl, t.itemId]);
    return (await storedFolder(client, lot.lot_id)) || folder;
  } catch (err) {
    if (err?.code === '42P01') throw err;
    console.error('before photos: folder move failed (kept in place):', err?.status, err?.message);
    return folder;
  }
}

/** The lot's folder in the right place — created if missing. Concurrent callers converge. */
async function ensureLotFolder(client, graph, lot, userId) {
  const have = await storedFolder(client, lot.lot_id);
  if (have) {
    const placed = await relocate(client, graph, lot, have, userId);
    if (placed) return placed;
  }
  const { t, out: made } = await withTarget(client, graph, lot, userId, (x) => graph.ensureFolder(x.parentId, x.name));
  await client.query(FOLDER_INSERT, [lot.lot_id, made.id, made.name || t.name, made.webUrl, t.itemId, userId]);
  const stored = await storedFolder(client, lot.lot_id);
  // Another upload stored a folder first (perhaps before the lot was tagged): use THAT one, in
  // the right place. The folder made here is left empty (harmless; never deleted automatically).
  if (stored && stored.drive_item_id !== made.id) return (await relocate(client, graph, lot, stored, userId)) || stored;
  return stored || { drive_item_id: made.id, web_url: made.webUrl, workorder_items_id: t.itemId };
}

// ---- Subjects: a lot, or a workorder item that has no lot ----

/** Which subject a request names: { kind: 'lot' | 'item', id }. */
function readRef(src) {
  const o = src && typeof src === 'object' ? src : {};
  if (o.lot_id != null && o.lot_id !== '') return { kind: 'lot', id: readId(o.lot_id, 'lot_id') };
  if (o.workorder_items_id != null && o.workorder_items_id !== '') return { kind: 'item', id: readId(o.workorder_items_id, 'workorder_items_id') };
  throw bad('lot_id or workorder_items_id is required');
}

/**
 * The lot or item + what the rest of the flow needs: `what` (for log lines), `log` (the workorder
 * line to write, or null for a lot not on a workorder), `photoItem` (recorded on the photo row).
 */
async function loadSubject(client, ref) {
  if (ref.kind === 'lot') {
    const lot = await loadLot(client, ref.id);
    const placed = isPlaced(lot);
    return {
      kind: 'lot', id: lot.lot_id, lot, what: `lot ${lot.lot_number}`,
      log: placed ? { workorder_id: lot.workorder_id, workorder_items_id: lot.workorder_items_id } : null,
      photoItem: placed ? lot.workorder_items_id : null,
    };
  }
  const row = (await client.query(ITEM_WORKORDER, [ref.id])).rows[0];
  if (!row) throw new HttpError(404, `Workorder item ${ref.id} not found`);
  const wo = await loadWorkorder(client, row.workorder_id);
  const item = wo.items.find((i) => i.workorder_items_id === ref.id);
  if (!item) throw new HttpError(404, `Workorder item ${ref.id} not found`);
  if (!needsEvidence(item)) throw bad('OTHER (custom / misc) items do not take before photos');
  return {
    kind: 'item', id: ref.id, wo, item, what: itemLabel(item),
    log: { workorder_id: wo.workorder_id, workorder_items_id: ref.id }, photoItem: ref.id,
  };
}

async function storedFolderOf(client, s) {
  if (s.kind === 'lot') return storedFolder(client, s.id);
  return (await client.query(ITEM_FOLDER_ONE, [s.id])).rows[0] || null;
}
const forgetFolderOf = (client, s) => client.query(s.kind === 'lot' ? FOLDER_FORGET : ITEM_FOLDER_FORGET, [s.id]);
const photosOf = (client, s) => client.query(s.kind === 'lot' ? PHOTOS_FOR_LOT : PHOTOS_FOR_ITEM, [s.id]);

/** An item's "Before refurbishment" folder inside its dispatch-evidence folder (never moves). */
async function ensureItemBeforeFolder(client, graph, s, userId) {
  const have = await storedFolderOf(client, s);
  if (have) return have;
  const make = async () => {
    const itemFolder = await ensureItemFolder(client, graph, s.wo, s.item, userId);
    return graph.ensureFolder(itemFolder.drive_item_id, ITEM_BEFORE_FOLDER);
  };
  let made;
  try {
    made = await make();
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await client.query(DISPATCH_FOLDERS_FORGET, [s.wo.workorder_id]); // a G18 folder was deleted by hand
    made = await make();
  }
  await client.query(ITEM_FOLDER_INSERT, [s.id, s.wo.workorder_id, made.id, made.name || ITEM_BEFORE_FOLDER, made.webUrl, userId]);
  return (await storedFolderOf(client, s)) || { drive_item_id: made.id, web_url: made.webUrl };
}

const ensureFolderOf = (client, graph, s, userId) => (s.kind === 'lot'
  ? ensureLotFolder(client, graph, s.lot, userId)
  : ensureItemBeforeFolder(client, graph, s, userId));

async function uploadSession(req, res, client, graph, auth) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const ref = readRef(b);
  const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
  if (!fileName || fileName.length > 200) throw bad('Give the file a name (up to 200 characters)');
  if (!isAllowedFileName(fileName)) throw bad(`Only photos and videos can be uploaded (${ALLOWED_EXTENSIONS.join(', ')})`);
  const size = Number(b.size);
  if (!Number.isInteger(size) || size <= 0) throw bad('The file is empty');
  if (size > MAX_FILE_BYTES) throw bad('Files are limited to 300 MB each');

  const subject = await loadSubject(client, ref);
  const name = evidenceFileName(fileName);
  const userId = actorId(auth);
  let folder = await ensureFolderOf(client, graph, subject, userId);
  let session;
  try {
    session = await graph.createUploadSession(folder.drive_item_id, name);
  } catch (err) {
    if (!(err instanceof GraphError) || err.status !== 404) throw err;
    // The before-photo folder was deleted in SharePoint: forget it and make a fresh one, once.
    await forgetFolderOf(client, subject);
    folder = await ensureFolderOf(client, graph, subject, userId);
    session = await graph.createUploadSession(folder.drive_item_id, name);
  }
  return res.status(200).json({
    upload_url: session.uploadUrl, expires_at: session.expiresAt, chunk_bytes: CHUNK_BYTES, file_name: name,
  });
}

async function complete(req, res, client, graph, auth) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const ref = readRef(b);
  // By id normally; by the name upload-session gave it when the final reply was lost (as G18).
  const driveItemId = typeof b.drive_item_id === 'string' ? b.drive_item_id.trim() : '';
  const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
  if (!driveItemId && !fileName) throw bad('drive_item_id or file_name is required');
  if (driveItemId.length > 200 || fileName.length > 250 || /[/\\]/.test(fileName)) throw bad('That is not a file in this folder');
  const byName = !driveItemId;
  const size = Number(b.size);
  if (byName && !(Number.isInteger(size) && size > 0)) throw bad('size is required when recording by file name');

  const subject = await loadSubject(client, ref);
  const folder = await storedFolderOf(client, subject);
  if (!folder) throw bad(`No before-photo folder exists for that ${subject.kind} yet`);
  let item;
  try {
    item = driveItemId ? await graph.getItem(driveItemId) : await graph.getChild(folder.drive_item_id, fileName);
  } catch (err) {
    if (err instanceof GraphError && (err.status === 404 || err.status === 400)) throw bad('That file was not found in SharePoint');
    throw err;
  }
  if (item?.parentReference?.id !== folder.drive_item_id || !item.file) throw bad(`That file is not in this ${subject.kind}'s before-photo folder`);
  if (byName && Number(item.size) !== size) throw bad('That file was not found in SharePoint');
  const known = (await client.query(PHOTO_BY_DRIVE_ITEM, [item.id])).rows[0];
  if (known) return res.status(200).json({ recorded: true, id: known.id, file_name: item.name });
  // Refused, never deleted: a file someone put in the lot folder by hand could be named here, and
  // removing files is superadmin-only (review, 10 Nov 2026).
  if (!isAllowedFileName(item.name) || !(Number(item.size) > 0 && Number(item.size) <= MAX_FILE_BYTES)) {
    throw bad('Only photos and videos up to 300 MB each can be recorded');
  }
  const userId = actorId(auth);
  await client.query('BEGIN');
  try {
    const ins = await client.query(PHOTO_INSERT, [
      subject.kind === 'lot' ? subject.id : null, subject.photoItem, item.id, item.name, item.file.mimeType || null,
      Number(item.size) || null, item.webUrl || null, userId,
    ]);
    if (ins.rows.length && subject.log) {
      await client.query(LOG_NOTE, [subject.log.workorder_id, subject.log.workorder_items_id, userId, `Before photo added — ${subject.what} — ${item.name}`]);
    }
    await client.query('COMMIT');
    return res.status(200).json({ recorded: true, id: ins.rows[0]?.id ?? null, file_name: item.name });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

async function removeFile(req, res, client, graph, auth) {
  const id = readId(req.query?.id, 'id');
  const f = (await client.query(PHOTO_ONE, [id])).rows[0];
  if (!f) throw new HttpError(404, 'That photo is not recorded (or was already deleted)');
  // The log line goes on the subject's workorder when it still has one (a deleted item → no line).
  let subject = null;
  try {
    subject = await loadSubject(client, f.lot_id != null ? { kind: 'lot', id: f.lot_id } : { kind: 'item', id: f.workorder_items_id });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }
  await graph.deleteItem(f.drive_item_id); // to the SharePoint recycle bin
  const userId = actorId(auth);
  await client.query('BEGIN');
  try {
    const done = await client.query(PHOTO_SOFT_DELETE, [id, userId]);
    if (done.rows.length && subject?.log) {
      await client.query(LOG_NOTE, [subject.log.workorder_id, subject.log.workorder_items_id, userId, `Before photo removed — ${subject.what} — ${f.file_name}`]);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return res.status(200).json({ deleted: true });
}

async function list(req, res, client, graph, auth, configured) {
  const ref = readRef(req.query);
  // count_only=1: the workorder lot-row button only needs the number — no move, no thumbnails.
  const countOnly = String(req.query?.count_only || '') === '1';
  const subject = await loadSubject(client, ref);
  let available = true;
  let folder = null;
  let files = [];
  try {
    folder = await storedFolderOf(client, subject);
    // Viewing never creates folders; it only moves an existing LOT folder that is out of place.
    if (subject.kind === 'lot' && folder && configured && !countOnly) folder = await relocate(client, graph, subject.lot, folder, actorId(auth));
    files = (await photosOf(client, subject)).rows;
  } catch (err) {
    if (err?.code !== '42P01') throw err;
    available = false;
  }
  const thumbs = new Map();
  if (configured && folder && files.length && !countOnly) {
    try {
      for (const c of await graph.childrenWithThumbnails(folder.drive_item_id)) thumbs.set(c.id, c.thumbnail);
    } catch (err) {
      console.error('before photos thumbnails:', err?.message);
    }
  }
  return res.status(200).json({
    configured, available,
    can_upload: canUpload(auth), can_delete: canDelete(auth),
    max_file_bytes: MAX_FILE_BYTES, allowed_extensions: ALLOWED_EXTENSIONS,
    lot: subject.kind !== 'lot' ? null : {
      lot_id: subject.lot.lot_id, lot_number: subject.lot.lot_number, product_sku: subject.lot.product_sku, status: subject.lot.status,
      workorder_items_id: subject.lot.workorder_items_id ?? null, workorder_id: subject.lot.workorder_id ?? null,
    },
    item: subject.kind !== 'item' ? null : {
      workorder_items_id: subject.id, workorder_id: subject.wo.workorder_id, label: subject.what,
    },
    folder_url: folder?.web_url || null,
    files: files.map((f) => ({
      id: f.id, file_name: f.file_name, mime_type: f.mime_type || null,
      size_bytes: f.size_bytes == null ? null : Number(f.size_bytes), web_url: f.web_url || null,
      uploaded_by: f.uploaded_by || null, uploaded_by_name: f.uploaded_by_name || null, uploaded_at: iso(f.uploaded_at),
      thumbnail_url: thumbs.get(f.drive_item_id) || null,
    })),
  });
}

/** `deps.graph` / `deps.configured` let the smoke run offline. */
export async function handleBeforePhotos(req, res, client, deps = {}) {
  const resource = String(req.query?.resource || '');
  const method = ROUTES[resource];
  if (!method) return res.status(400).json({ error: 'Unknown before-photo resource' });
  if (req.method !== method) {
    res.setHeader('Allow', [method]);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Authentication required' });

  const configured = deps.configured ?? isGraphConfigured();
  const graph = deps.graph || (configured ? getGraph() : null);
  try {
    if (resource === 'before-list') return await list(req, res, client, graph, auth, configured);
    if (resource === 'before-file' && !canDelete(auth)) throw new HttpError(403, 'Only a superadmin can delete before photos');
    if (resource !== 'before-file' && !canUpload(auth)) {
      throw new HttpError(403, 'Before photos can be uploaded by logistics, admin, technicians and the workshop');
    }
    if (!configured) throw new HttpError(503, 'Before photos are not set up yet (Microsoft connection missing)');
    if (resource === 'before-upload-session') return await uploadSession(req, res, client, graph, auth);
    if (resource === 'before-complete') return await complete(req, res, client, graph, auth);
    return await removeFile(req, res, client, graph, auth);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.code === '42P01') return res.status(503).json({ error: 'Before photos are not set up on this database yet' });
    if (err instanceof GraphError) {
      console.error('before photos graph error:', err.status, err.code, err.message);
      const msg = err.kind === 'auth'
        ? 'The portal could not log in to Microsoft — the app secret may have expired'
        : `The Microsoft shared drive refused the request: ${err.message}`;
      return res.status(502).json({ error: msg, code: err.code || null });
    }
    throw err;
  }
}
