// scripts/ops-before-photos-smoke.mjs — offline smoke for G27 (owner, 10 Nov 2026): photos of a
// machine BEFORE refurbishment, per lot, saved next to its dispatch evidence in SharePoint.
//
//   GET    /api/evidence?resource=before-list&lot_id=         the lot's photos (moves its folder if out of date)
//   POST   /api/evidence?resource=before-upload-session       folder ensure/move + a one-off upload URL
//   POST   /api/evidence?resource=before-complete             record a finished upload
//   DELETE /api/evidence?resource=before-file&id=             superadmin only
//
// Exercises lib/msgraph.js `moveItem` with a fake fetch and lib/beforePhotos.js (via
// handleEvidence) with a fake pg client and a fake Graph — no network, no database, no secrets.
//
//   node scripts/ops-before-photos-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

const jwt = (await import('jsonwebtoken')).default;
const { createGraph, GraphError } = await import('../lib/msgraph.js');
const { handleEvidence } = await import('../lib/dispatchEvidence.js');
const bp = await import('../lib/beforePhotos.js');
const { IN_STOCK_FOLDER, lotFolderName } = bp;
const clientUtils = await import('../src/utils/beforePhotos.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------------------------
console.log('names');
check('In-stock area folder name (owner decision 2)', IN_STOCK_FOLDER === 'In-stock lots');
check('in-stock lot folder = Lot <lot> <SKU>', lotFolderName({ lot_number: 'L00042', product_sku: 'TM-95T' }, false) === 'Lot L00042 TM-95T');
check('assigned lot folder = Before refurbishment - Lot <lot> (owner decision 1)',
  lotFolderName({ lot_number: 'L00042', product_sku: 'TM-95T' }, true) === 'Before refurbishment - Lot L00042');
check('lot folder names are SharePoint-safe', lotFolderName({ lot_number: 'L/1', product_sku: 'A:B' }, false) === 'Lot L-1 A-B');
check('client mirror: placed = Assigned with a workorder item',
  clientUtils.isPlaced({ status: 'Assigned', workorder_items_id: 5, workorder_id: 7 })
  && !clientUtils.isPlaced({ status: 'In Stock', workorder_items_id: null })
  && !clientUtils.isPlaced({ status: 'Assigned', workorder_items_id: null }));
check('server and client agree on "placed"',
  [{ status: 'Assigned', workorder_items_id: 5, workorder_id: 7 }, { status: 'In Stock' }, { status: 'Assigned', workorder_items_id: 5, workorder_id: null }]
    .every((l) => bp.isPlaced(l) === clientUtils.isPlaced(l)));

// ---------------------------------------------------------------------------------------------
console.log('msgraph moveItem');
const ENV = {
  MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', MS_CLIENT_SECRET: 'shh',
  MS_EVIDENCE_SITE_URL: 'https://graysfitness.sharepoint.com/sites/shared.group/', MS_EVIDENCE_FOLDER: 'Dispatch Evidence - TEST',
};
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [method, re, reply] of routes) {
      if ((init.method || 'GET') === method && re.test(url)) {
        const { status = 200, json = null } = reply;
        return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => (json == null ? '' : JSON.stringify(json)) };
      }
    }
    return { ok: false, status: 599, json: async () => ({}), text: async () => '{"error":{"message":"no route"}}' };
  };
  fn.calls = calls;
  return fn;
}
const GRAPH_ROUTES = [
  ['POST', /oauth2\/v2\.0\/token$/, { json: { access_token: 'tok-1', expires_in: 3599 } }],
  ['GET', /\/sites\/graysfitness\.sharepoint\.com:\/sites\/shared\.group$/, { json: { id: 'site-1' } }],
  ['GET', /\/sites\/site-1\/drive$/, { json: { id: 'drive-1' } }],
  ['GET', /\/drives\/drive-1\/root:\/Dispatch%20Evidence%20-%20TEST$/, { json: { id: 'root-folder' } }],
];
{
  const f = fakeFetch([...GRAPH_ROUTES,
    ['PATCH', /\/drives\/drive-1\/items\/lot-folder\?@microsoft\.graph\.conflictBehavior=rename$/, { json: { id: 'lot-folder', name: 'Before refurbishment - Lot L00042', webUrl: 'https://sp/moved' } }]]);
  const moved = await createGraph({ env: ENV, fetch: f }).moveItem('lot-folder', 'item-folder', 'Before refurbishment - Lot L00042');
  const patch = f.calls.find((c) => c.init.method === 'PATCH');
  const body = JSON.parse(patch.init.body);
  check('moveItem PATCHes the parent + name, renaming on a clash (never replace)', body.parentReference.id === 'item-folder' && body.name === 'Before refurbishment - Lot L00042', patch.url);
  check('moveItem returns id + new link', moved.id === 'lot-folder' && moved.webUrl === 'https://sp/moved');
}

// ---------------------------------------------------------------------------------------------
console.log('handler');
const token = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET)}`;
const AUTH = {
  superadmin: token('NE', ['superadmin']), admin: token('AN', ['admin']), technician: token('ED', ['technician']),
  workshop: token('WS', ['workshop']), logistics: token('LG', ['logistics']), wk: token('WK', ['admin']), staff: token('ST', ['staff']),
};
const USERS = { NE: 'Nick', AN: 'Ana', ED: 'Eden', WK: 'Workshop', ST: 'Stacey', LG: 'Liam' };

const WO = { workorder_id: 731, invoice_id: '19623' };
const ITEMS = [
  { workorder_items_id: 2001, workorder_id: 731, product_id: 'TM-95T', product_name: 'Life Fitness 95T Treadmill', is_custom: false, custom_description: null },
  { workorder_items_id: 2003, workorder_id: 731, product_id: 'TM-95T', product_name: 'Life Fitness 95T Treadmill', is_custom: false, custom_description: null },
];
const LOTS = () => ({
  55: { lot_id: 55, lot_number: 'L00055', product_sku: 'TM-95T', status: 'In Stock', workorder_items_id: null },
  56: { lot_id: 56, lot_number: 'L00056', product_sku: 'TM-95T', status: 'Assigned', workorder_items_id: 2001 },
});

function makeClient({ missing = false, lots = LOTS() } = {}) {
  const state = { lots, folders: [], photos: [], logs: [], dispatchFolders: [], nextId: 1 };
  const calls = [];
  return {
    state, calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };
      if (/lot_photo/.test(sql) && missing) throw Object.assign(new Error('relation "lot_photos" does not exist'), { code: '42P01' });
      if (/^SELECT/i.test(sql) && /FROM product_lots pl/.test(sql) && /pl\.lot_id = \$1/.test(sql)) {
        const l = state.lots[Number(params[0])];
        if (!l) return { rows: [] };
        const wi = ITEMS.find((i) => i.workorder_items_id === l.workorder_items_id);
        return { rows: [{ ...l, workorder_id: wi ? wi.workorder_id : null }] };
      }
      if (/^SELECT/i.test(sql) && /FROM workorder w/.test(sql) && /LEFT JOIN workorder_items wi/.test(sql)) {
        if (Number(params[0]) !== WO.workorder_id) return { rows: [] };
        return { rows: ITEMS.map((i) => ({ ...WO, ...i })) };
      }
      // G18's folders (the item folder the lot folder sits inside).
      if (/^SELECT/i.test(sql) && /FROM dispatch_evidence_folders/.test(sql)) {
        const [wo, item] = params.map(Number);
        return { rows: state.dispatchFolders.filter((f) => f.workorder_id === wo && (f.workorder_items_id || 0) === item) };
      }
      if (/^INSERT INTO dispatch_evidence_folders/i.test(sql)) {
        const [workorder_id, workorder_items_id, drive_item_id, name, web_url] = params;
        state.dispatchFolders.push({ workorder_id: Number(workorder_id), workorder_items_id: workorder_items_id == null ? null : Number(workorder_items_id), drive_item_id, name, web_url });
        return { rows: [] };
      }
      if (/^DELETE FROM dispatch_evidence_folders WHERE workorder_id = \$1$/i.test(sql)) {
        state.dispatchFolders = state.dispatchFolders.filter((f) => f.workorder_id !== Number(params[0]));
        state.dispatchForgot = (state.dispatchForgot || 0) + 1;
        return { rows: [] };
      }
      if (/^SELECT/i.test(sql) && /FROM lot_photo_folders/.test(sql)) {
        return { rows: state.folders.filter((f) => f.lot_id === Number(params[0])) };
      }
      if (/^INSERT INTO lot_photo_folders/i.test(sql)) {
        const [lot_id, drive_item_id, name, web_url, workorder_items_id, created_by] = params;
        if (!state.folders.some((f) => f.lot_id === Number(lot_id))) {
          state.folders.push({ lot_id: Number(lot_id), drive_item_id, name, web_url, workorder_items_id: workorder_items_id == null ? null : Number(workorder_items_id), created_by });
        }
        return { rows: [] };
      }
      if (/^UPDATE lot_photo_folders/i.test(sql)) {
        const [lot_id, name, web_url, workorder_items_id] = params;
        const f = state.folders.find((x) => x.lot_id === Number(lot_id));
        if (f) Object.assign(f, { name, web_url, workorder_items_id: workorder_items_id == null ? null : Number(workorder_items_id), moved: true });
        return { rows: [] };
      }
      if (/^DELETE FROM lot_photo_folders/i.test(sql)) {
        state.folders = state.folders.filter((f) => f.lot_id !== Number(params[0]));
        return { rows: [] };
      }
      if (/^INSERT INTO lot_photos/i.test(sql)) {
        const [lot_id, workorder_items_id, drive_item_id, file_name, mime_type, size_bytes, web_url, uploaded_by] = params;
        if (state.photos.some((p) => p.drive_item_id === drive_item_id)) return { rows: [] };
        const row = { id: state.nextId++, lot_id: Number(lot_id), workorder_items_id, drive_item_id, file_name, mime_type, size_bytes, web_url, uploaded_by, uploaded_at: new Date('2026-11-10T01:00:00Z'), deleted_at: null };
        state.photos.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/^SELECT id FROM lot_photos WHERE drive_item_id = \$1$/.test(sql)) {
        return { rows: state.photos.filter((p) => p.drive_item_id === params[0]).map((p) => ({ id: p.id })) };
      }
      if (/^SELECT/i.test(sql) && /FROM lot_photos p/.test(sql) && /p\.lot_id = \$1/.test(sql)) {
        return { rows: state.photos.filter((p) => p.lot_id === Number(params[0]) && !p.deleted_at).map((p) => ({ ...p, uploaded_by_name: USERS[p.uploaded_by] || null })) };
      }
      if (/^SELECT/i.test(sql) && /FROM lot_photos/.test(sql) && /WHERE id = \$1/.test(sql)) {
        return { rows: state.photos.filter((p) => p.id === Number(params[0]) && !p.deleted_at) };
      }
      if (/^UPDATE lot_photos SET deleted_at/i.test(sql)) {
        const p = state.photos.find((x) => x.id === Number(params[0]) && !x.deleted_at);
        if (!p) return { rows: [] };
        p.deleted_at = new Date(); p.deleted_by = params[1];
        return { rows: [{ id: p.id }] };
      }
      if (/^INSERT INTO workorder_logs/i.test(sql)) { state.logs.push(params); return { rows: [] }; }
      throw new Error(`fake client: unexpected SQL: ${sql.slice(0, 140)}`);
    },
  };
}

function makeGraph({ failSessionOnce = false, failMove = null } = {}) {
  let n = 0;
  const calls = [];
  const store = {};
  const folders = {}; // id → { name, parent }
  let sessionFails = failSessionOnce;
  return {
    calls, store, folders,
    async rootFolder() { calls.push(['rootFolder']); return { id: 'root-folder', driveId: 'drive-1' }; },
    async ensureFolder(parentId, name) {
      calls.push(['ensureFolder', parentId, name]);
      if (parentId !== 'root-folder' && !folders[parentId]) throw new GraphError('parent gone', { status: 404, code: 'itemNotFound' });
      const have = Object.entries(folders).find(([, f]) => f.parent === parentId && f.name === name);
      if (have) return { id: have[0], name, webUrl: `https://sp/${have[0]}` };
      n += 1; const id = `folder-${n}`;
      folders[id] = { name, parent: parentId };
      return { id, name, webUrl: `https://sp/${id}` };
    },
    async moveItem(id, parentId, name) {
      calls.push(['moveItem', id, parentId, name]);
      if (failMove) throw failMove;
      if (!folders[id]) throw new GraphError('gone', { status: 404, code: 'itemNotFound' });
      if (parentId !== 'root-folder' && !folders[parentId]) throw new GraphError('parent gone', { status: 404, code: 'itemNotFound' });
      Object.assign(folders[id], { parent: parentId, name });
      return { id, name, webUrl: `https://sp/${id}-moved` };
    },
    async createUploadSession(folderId, fileName) {
      calls.push(['createUploadSession', folderId, fileName]);
      if (sessionFails) { sessionFails = false; throw new GraphError('gone', { status: 404, code: 'itemNotFound' }); }
      return { uploadUrl: `https://upload/${folderId}`, expiresAt: '2026-11-10T02:00:00Z' };
    },
    async getItem(id) {
      calls.push(['getItem', id]);
      if (folders[id]) return { id, name: folders[id].name, folder: {}, parentReference: { id: folders[id].parent } };
      if (!store[id]) throw new GraphError('gone', { status: 404, code: 'itemNotFound' });
      return store[id];
    },
    async getChild(folderId, name) {
      calls.push(['getChild', folderId, name]);
      const hit = Object.values(store).find((i) => i.parentReference?.id === folderId && i.name === name);
      if (!hit) throw new GraphError('gone', { status: 404, code: 'itemNotFound' });
      return hit;
    },
    async deleteItem(id) { calls.push(['deleteItem', id]); const had = !!store[id]; delete store[id]; return had; },
    async childrenWithThumbnails(folderId) {
      calls.push(['childrenWithThumbnails', folderId]);
      return Object.values(store).filter((i) => i.parentReference?.id === folderId).map((i) => ({ id: i.id, thumbnail: `https://thumb/${i.id}` }));
    },
  };
}

function makeRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call({ method = 'GET', resource, query = {}, body, auth, client, graph, configured = true }) {
  const req = { method, query: { resource, ...query }, body, headers: auth ? { authorization: auth } : {} };
  const res = makeRes();
  await handleEvidence(req, res, client, { graph, configured });
  return res;
}
const session = (lot, extra = {}) => ({ lot_id: lot, file_name: 'front.jpg', size: 4_000_000, ...extra });
const upload = (args) => call({ method: 'POST', resource: 'before-upload-session', ...args });
// Put a file in SharePoint the way the browser would after an upload session.
const putFile = (graph, id, parent, extra = {}) => {
  graph.store[id] = { id, name: `2026-11-10 12-00-00 ${id}.jpg`, size: 4_000_000, file: { mimeType: 'image/jpeg' }, webUrl: `https://sp/${id}`, parentReference: { id: parent }, ...extra };
};

// --- access ---
{
  const client = makeClient(); const graph = makeGraph();
  check('no token → 401', (await upload({ body: session(55), client, graph })).statusCode === 401);
  check('staff cannot upload → 403', (await upload({ body: session(55), auth: AUTH.staff, client, graph })).statusCode === 403);
  const l = await call({ resource: 'before-list', query: { lot_id: '55' }, auth: AUTH.staff, client, graph });
  check('any logged-in user can view (owner decision 4)', l.statusCode === 200 && l.body.can_upload === false && l.body.can_delete === false, JSON.stringify(l.body));
  check('no Graph folder work for a refused caller', !graph.calls.some((c) => c[0] === 'ensureFolder'));
  const wrong = await call({ method: 'GET', resource: 'before-upload-session', auth: AUTH.admin, client, graph });
  check('wrong method → 405', wrong.statusCode === 405);
}
for (const who of ['technician', 'workshop', 'logistics', 'admin', 'superadmin', 'wk']) {
  const r = await upload({ body: session(55), auth: AUTH[who], client: makeClient(), graph: makeGraph() });
  check(`${who} can start a before-photo upload (owner decision 4)`, r.statusCode === 200 && r.body.upload_url, `${r.statusCode} ${JSON.stringify(r.body)}`);
}
{
  const client = makeClient(); const graph = makeGraph();
  const bad = async (body, what, code = 400) => {
    const r = await upload({ body: { ...session(55), ...body }, auth: AUTH.admin, client, graph });
    check(`refused: ${what} → ${code}`, r.statusCode === code, `${r.statusCode} ${JSON.stringify(r.body)}`);
  };
  await bad({ file_name: 'quote.pdf' }, 'not a photo or video');
  await bad({ size: 300 * 1024 * 1024 + 1 }, 'over 300 MB');
  await bad({ size: 0 }, 'empty file');
  await bad({ lot_id: 'abc' }, 'bad lot id');
  await bad({ lot_id: 999 }, 'unknown lot', 404);
  const nc = await upload({ body: session(55), auth: AUTH.admin, client, graph, configured: false });
  check('Microsoft not connected → 503', nc.statusCode === 503);
}

// --- folder placement ---
{
  const client = makeClient(); const graph = makeGraph();
  const r = await upload({ body: session(55), auth: AUTH.technician, client, graph });
  const f = client.state.folders[0];
  check('In Stock lot → folder in the "In-stock lots" area (owner decisions 1+2)',
    graph.folders['folder-1'].name === 'In-stock lots' && graph.folders['folder-1'].parent === 'root-folder' && f.name === 'Lot L00055 TM-95T' && f.workorder_items_id === null,
    JSON.stringify({ folders: graph.folders, f }));
  check('the upload goes into the lot folder', r.body.upload_url === `https://upload/${f.drive_item_id}`);
  check('upload name is Melbourne-timestamped like dispatch evidence', /^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d front\.jpg$/.test(r.body.file_name), r.body.file_name);
  check('no workorder folders created for an In Stock lot', client.state.dispatchFolders.length === 0);

  const mark = graph.calls.length;
  const again = await upload({ body: session(55), auth: AUTH.technician, client, graph });
  check('a second upload reuses the stored folder (no folder calls)', again.statusCode === 200 && client.state.folders.length === 1 && !graph.calls.slice(mark).some((c) => ['ensureFolder', 'moveItem'].includes(c[0])));

  // Tagged as sold: the lot is assigned to item 2001 → the SAME folder moves next to dispatch evidence.
  client.state.lots[55] = { ...client.state.lots[55], status: 'Assigned', workorder_items_id: 2001 };
  const moved = await upload({ body: session(55), auth: AUTH.technician, client, graph });
  const mv = graph.calls.find((c) => c[0] === 'moveItem');
  const itemFolder = client.state.dispatchFolders.find((d) => d.workorder_items_id === 2001);
  check('once assigned, the lot folder MOVES into the item\'s dispatch-evidence folder', !!mv && mv[1] === f.drive_item_id && mv[2] === itemFolder?.drive_item_id && mv[3] === 'Before refurbishment - Lot L00055', JSON.stringify(mv));
  check('the workorder + item dispatch folders are the G18 ones (<invoice> - WO <id> / <item> - item <id>)',
    client.state.dispatchFolders.some((d) => d.name === '19623 - WO 731') && itemFolder?.name === 'TM-95T Life Fitness 95T Treadmill - item 2001');
  check('the stored folder now records its new place and link', client.state.folders[0].workorder_items_id === 2001 && client.state.folders[0].web_url === `https://sp/${f.drive_item_id}-moved`);
  check('same folder id after the move (photos kept)', client.state.folders.length === 1 && moved.body.upload_url === `https://upload/${f.drive_item_id}`);

  // Reassigned to another item on the workorder → moves again.
  client.state.lots[55] = { ...client.state.lots[55], workorder_items_id: 2003 };
  await call({ resource: 'before-list', query: { lot_id: '55' }, auth: AUTH.staff, client, graph });
  check('reassigned → the next list moves it to the new item folder', client.state.folders[0].workorder_items_id === 2003);

  // Released back to stock → moves back to the In-stock area.
  client.state.lots[55] = { ...client.state.lots[55], status: 'In Stock', workorder_items_id: null };
  await call({ resource: 'before-list', query: { lot_id: '55' }, auth: AUTH.staff, client, graph });
  const back = graph.calls.filter((c) => c[0] === 'moveItem').at(-1);
  check('released → moved back to "In-stock lots" with its stock name', client.state.folders[0].workorder_items_id === null && back[2] === 'folder-1' && back[3] === 'Lot L00055 TM-95T', JSON.stringify(back));

  const quiet = graph.calls.length;
  await call({ resource: 'before-list', query: { lot_id: '55' }, auth: AUTH.staff, client, graph });
  check('in the right place → the list makes no folder calls', !graph.calls.slice(quiet).some((c) => ['moveItem', 'ensureFolder'].includes(c[0])));
}
{
  const client = makeClient(); const graph = makeGraph();
  await call({ resource: 'before-list', query: { lot_id: '56' }, auth: AUTH.admin, client, graph });
  check('viewing a lot with no photos creates no folders', client.state.folders.length === 0 && !graph.calls.some((c) => c[0] === 'ensureFolder'));
  const r = await upload({ body: session(56), auth: AUTH.admin, client, graph });
  check('an already-assigned lot gets its folder straight inside the item folder',
    r.statusCode === 200 && client.state.folders[0].name === 'Before refurbishment - Lot L00056' && client.state.folders[0].workorder_items_id === 2001);
}
{
  // A failed move never breaks the list or the upload — the photos stay where they were.
  const client = makeClient(); const graph = makeGraph();
  await upload({ body: session(55), auth: AUTH.admin, client, graph });
  client.state.lots[55] = { ...client.state.lots[55], status: 'Assigned', workorder_items_id: 2001 };
  const failing = makeGraph({ failMove: new GraphError('locked', { status: 423, code: 'resourceLocked' }) });
  Object.assign(failing.folders, graph.folders);
  const l = await call({ resource: 'before-list', query: { lot_id: '55' }, auth: AUTH.admin, client, graph: failing });
  check('move refused by SharePoint → list still answers 200', l.statusCode === 200);
  check('… and the folder keeps its old place, to try again next time', client.state.folders[0].workorder_items_id === null);
  const u = await upload({ body: session(55), auth: AUTH.admin, client, graph: failing });
  check('… and uploads still work (into the old place)', u.statusCode === 200 && u.body.upload_url === `https://upload/${client.state.folders[0].drive_item_id}`);
}
{
  // Folder deleted by hand in SharePoint → forgotten and recreated once.
  const client = makeClient(); const graph = makeGraph({ failSessionOnce: true });
  await upload({ body: session(55), auth: AUTH.admin, client, graph }).then(() => null);
  check('a deleted lot folder (404 on upload) is recreated and the upload retried', graph.calls.filter((c) => c[0] === 'createUploadSession').length === 2 && client.state.folders.length === 1);
  const c2 = makeClient(); const g2 = makeGraph();
  await upload({ body: session(55), auth: AUTH.admin, client: c2, graph: g2 });
  delete g2.folders[c2.state.folders[0].drive_item_id];
  c2.state.lots[55] = { ...c2.state.lots[55], status: 'Assigned', workorder_items_id: 2001 };
  const r = await upload({ body: session(55), auth: AUTH.admin, client: c2, graph: g2 });
  check('a deleted lot folder (404 on move) is recreated in the right place', r.statusCode === 200 && c2.state.folders[0].workorder_items_id === 2001 && c2.state.folders[0].name === 'Before refurbishment - Lot L00055');
}

{
  // Review #1: the DESTINATION was deleted by hand (the item's G18 folder) — the lot folder and
  // its photos must NOT be forgotten; stale G18 ids are dropped and the move retried once.
  const client = makeClient(); const graph = makeGraph();
  await upload({ body: session(55), auth: AUTH.admin, client, graph });
  const lotFolder = client.state.folders[0].drive_item_id;
  // A stale stored item folder for item 2001 (gone from SharePoint).
  client.state.dispatchFolders.push({ workorder_id: 731, workorder_items_id: null, drive_item_id: 'stale-wo', name: '19623 - WO 731' });
  client.state.dispatchFolders.push({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'stale-item', name: 'TM-95T Life Fitness 95T Treadmill - item 2001' });
  client.state.lots[55] = { ...client.state.lots[55], status: 'Assigned', workorder_items_id: 2001 };
  const l = await call({ resource: 'before-list', query: { lot_id: '55' }, auth: AUTH.staff, client, graph });
  check('destination gone → list still 200', l.statusCode === 200);
  check('… the lot folder is kept (same id) and moved into a freshly made item folder',
    client.state.folders.length === 1 && client.state.folders[0].drive_item_id === lotFolder && client.state.folders[0].workorder_items_id === 2001, JSON.stringify(client.state.folders));
  check('… the stale G18 folder ids were forgotten once', client.state.dispatchForgot === 1 && !client.state.dispatchFolders.some((d) => d.drive_item_id.startsWith('stale')));
}
{
  // Review #8: count_only for the lot-row button — no move, no thumbnails.
  const client = makeClient(); const graph = makeGraph();
  await upload({ body: session(55), auth: AUTH.admin, client, graph });
  client.state.lots[55] = { ...client.state.lots[55], status: 'Assigned', workorder_items_id: 2001 };
  const mark = graph.calls.length;
  const c = await call({ resource: 'before-list', query: { lot_id: '55', count_only: '1' }, auth: AUTH.admin, client, graph });
  check('count_only answers the files without any Graph calls', c.statusCode === 200 && Array.isArray(c.body.files) && graph.calls.length === mark);
}

// --- complete ---
{
  const client = makeClient(); const graph = makeGraph();
  await upload({ body: session(56), auth: AUTH.technician, client, graph });
  const folderId = client.state.folders[0].drive_item_id;
  const complete = (body, auth = AUTH.technician) => call({ method: 'POST', resource: 'before-complete', body, auth, client, graph });

  putFile(graph, 'f1', folderId);
  const r = await complete({ lot_id: 56, drive_item_id: 'f1' });
  check('complete records the photo', r.statusCode === 200 && client.state.photos.length === 1, JSON.stringify(r.body));
  check('the record keeps the lot\'s item at upload time', client.state.photos[0].workorder_items_id === 2001 && client.state.photos[0].uploaded_by === 'ED');
  const log = client.state.logs.at(-1);
  check('an assigned lot\'s photo adds one NOTE_ADDED line on its workorder', client.state.logs.length === 1 && log[0] === 731 && log[1] === 2001 && /^Before photo added — lot L00056 — /.test(log[3]), JSON.stringify(log));
  const again = await complete({ lot_id: 56, drive_item_id: 'f1' });
  check('completing twice is harmless (no second row, no second log)', again.statusCode === 200 && client.state.photos.length === 1 && client.state.logs.length === 1);

  putFile(graph, 'elsewhere', 'some-other-folder');
  check('a file outside this lot\'s folder is refused', (await complete({ lot_id: 56, drive_item_id: 'elsewhere' })).statusCode === 400);
  check('…and is never deleted (not ours)', !!graph.store.elsewhere);
  putFile(graph, 'big', folderId, { size: 300 * 1024 * 1024 + 5 });
  const big = await complete({ lot_id: 56, drive_item_id: 'big' });
  check('an over-limit file is refused and NEVER deleted (could be one placed by hand)', big.statusCode === 400 && !!graph.store.big && !graph.calls.some((c) => c[0] === 'deleteItem'));
  putFile(graph, 'named', folderId, { name: '2026-11-10 12-01-00 side.jpg', size: 1234 });
  const byName = await complete({ lot_id: 56, file_name: '2026-11-10 12-01-00 side.jpg', size: 1234 });
  check('lost final reply → recorded by name + size', byName.statusCode === 200 && client.state.photos.some((p) => p.drive_item_id === 'named'));
  check('by name, a size mismatch is refused', (await complete({ lot_id: 56, file_name: '2026-11-10 12-01-00 side.jpg', size: 99 })).statusCode === 400);
  check('staff cannot record', (await complete({ lot_id: 56, drive_item_id: 'f1' }, AUTH.staff)).statusCode === 403);
  check('no folder yet → 400', (await call({ method: 'POST', resource: 'before-complete', body: { lot_id: 55, drive_item_id: 'f1' }, auth: AUTH.admin, client, graph })).statusCode === 400);

  // In Stock photo: recorded, no workorder log.
  await upload({ body: session(55), auth: AUTH.admin, client, graph });
  const stockFolder = client.state.folders.find((f) => f.lot_id === 55).drive_item_id;
  putFile(graph, 's1', stockFolder);
  const logsBefore = client.state.logs.length;
  const s = await complete({ lot_id: 55, drive_item_id: 's1' }, AUTH.admin);
  check('an In Stock photo is recorded with no item and no workorder log', s.statusCode === 200 && client.state.photos.find((p) => p.drive_item_id === 's1').workorder_items_id === null && client.state.logs.length === logsBefore);

  // --- list ---
  const l = await call({ resource: 'before-list', query: { lot_id: '56' }, auth: AUTH.technician, client, graph });
  check('list returns the lot\'s photos with uploader, time and thumbnail',
    l.statusCode === 200 && l.body.files.length === 2 && l.body.files[0].uploaded_by_name === 'Eden' && l.body.files[0].thumbnail_url === 'https://thumb/f1' && l.body.files[0].uploaded_at === '2026-11-10T01:00:00.000Z',
    JSON.stringify(l.body.files));
  check('list describes the lot and its place', l.body.lot.lot_number === 'L00056' && l.body.lot.workorder_id === 731 && l.body.folder_url && l.body.configured && l.body.available);
  check('list says who can upload/delete', l.body.can_upload === true && l.body.can_delete === false);
  check('list for an unknown lot → 404', (await call({ resource: 'before-list', query: { lot_id: '999' }, auth: AUTH.admin, client, graph })).statusCode === 404);

  // --- delete ---
  const id = client.state.photos[0].id;
  check('only a superadmin can delete (owner decision 4)', (await call({ method: 'DELETE', resource: 'before-file', query: { id: String(id) }, auth: AUTH.admin, client, graph })).statusCode === 403);
  const d = await call({ method: 'DELETE', resource: 'before-file', query: { id: String(id) }, auth: AUTH.superadmin, client, graph });
  check('superadmin delete → recycle bin + soft delete', d.statusCode === 200 && !graph.store.f1 && client.state.photos[0].deleted_at && client.state.photos[0].deleted_by === 'NE');
  check('delete adds a log line on the lot\'s workorder', /^Before photo removed — lot L00056 — /.test(client.state.logs.at(-1)[3]));
  check('deleting again → 404', (await call({ method: 'DELETE', resource: 'before-file', query: { id: String(id) }, auth: AUTH.superadmin, client, graph })).statusCode === 404);
}

// --- not migrated yet (prod until the owner migrates at merge) ---
{
  const client = makeClient({ missing: true }); const graph = makeGraph();
  const l = await call({ resource: 'before-list', query: { lot_id: '55' }, auth: AUTH.admin, client, graph });
  check('tables missing → list answers available:false (panels hide)', l.statusCode === 200 && l.body.available === false && l.body.files.length === 0, JSON.stringify(l.body));
  const u = await upload({ body: session(55), auth: AUTH.admin, client, graph });
  check('tables missing → upload 503', u.statusCode === 503, JSON.stringify(u.body));
}

// --- dispatch evidence is untouched ---
{
  const r = await call({ resource: 'list', query: {}, auth: AUTH.admin, client: makeClient(), graph: makeGraph() });
  check('dispatch evidence routes still answer (list without workorder_id → 400)', r.statusCode === 400);
  const u = await call({ resource: 'before-nope', auth: AUTH.admin, client: makeClient(), graph: makeGraph() });
  check('unknown before-* resource → 400', u.statusCode === 400);
}

console.log(`\nops-before-photos-smoke: ${passed} checks passed`);
