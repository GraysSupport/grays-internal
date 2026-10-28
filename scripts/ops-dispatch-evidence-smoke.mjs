// scripts/ops-dispatch-evidence-smoke.mjs — offline smoke for G18 (owner, 28 Oct 2026): photos
// and videos of each workorder item saved as "dispatch evidence" to the SharePoint shared drive.
//
//   GET    /api/evidence?resource=list&workorder_id=          what has been uploaded, per item
//   POST   /api/evidence?resource=upload-session              folder ensure + a one-off upload URL
//   POST   /api/evidence?resource=complete                    record a finished upload
//   DELETE /api/evidence?resource=file&id=                    superadmin only
//
// Exercises lib/msgraph.js with a fake fetch and lib/dispatchEvidence.js with a fake pg client
// and a fake Graph — no network, no database, no secrets.
//
//   node scripts/ops-dispatch-evidence-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jwt = (await import('jsonwebtoken')).default;
const graphMod = await import('../lib/msgraph.js');
const ev = await import('../lib/dispatchEvidence.js');
const {
  handleEvidence, EVIDENCE_UPLOAD_ROLES, EVIDENCE_DELETE_ROLES, MAX_FILE_BYTES, CHUNK_BYTES,
  cleanName, workorderFolderName, itemFolderName, evidenceFileName, isAllowedFileName,
} = ev;
const { graphConfig, isGraphConfigured, createGraph, GraphError } = graphMod;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
async function rejects(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

// ---------------------------------------------------------------------------------------------
console.log('names');
check('cleanName replaces characters SharePoint refuses', cleanName('18030/18093') === '18030-18093', cleanName('18030/18093'));
check('cleanName keeps & and collapses spaces', cleanName('18971  &  18970') === '18971 & 18970', cleanName('18971  &  18970'));
check('cleanName strips " * : < > ? \\ | and trailing dots', cleanName(' a"b*c:d<e>f?g\\h|i. ') === 'a-b-c-d-e-f-g-h-i', cleanName(' a"b*c:d<e>f?g\\h|i. '));
check('cleanName caps the length', cleanName('x'.repeat(300)).length <= 100);
check('workorder folder = <invoice> - WO <id>', workorderFolderName({ invoice_id: '19623', workorder_id: 731 }) === '19623 - WO 731');
check('workorder folder cleans a joint invoice', workorderFolderName({ invoice_id: '18030/18093', workorder_id: 12 }) === '18030-18093 - WO 12');
check('workorder folder without an invoice', workorderFolderName({ invoice_id: null, workorder_id: 9 }) === 'No invoice - WO 9');
check('item folder = <SKU> <product> - item <id>',
  itemFolderName({ workorder_items_id: 2001, product_id: 'TM-95T', product_name: 'Life Fitness 95T Treadmill' }) === 'TM-95T Life Fitness 95T Treadmill - item 2001',
  itemFolderName({ workorder_items_id: 2001, product_id: 'TM-95T', product_name: 'Life Fitness 95T Treadmill' }));
check('item folder for a custom item uses its description',
  itemFolderName({ workorder_items_id: 5, is_custom: true, custom_description: 'Rubber flooring: 20 m²', product_id: null }) === 'Rubber flooring- 20 m² - item 5');
// 28 Oct 2026 03:32Z = 14:32 in Melbourne (AEDT, UTC+11).
check('file name is Melbourne-timestamped + cleaned',
  evidenceFileName('IMG 1234?.HEIC', new Date('2026-10-28T03:32:10Z')) === '2026-10-28 14-32-10 IMG 1234-.HEIC',
  evidenceFileName('IMG 1234?.HEIC', new Date('2026-10-28T03:32:10Z')));
{
  // Review #1: a long name must keep its extension, or complete deletes the finished upload.
  const long = evidenceFileName(`${'x'.repeat(150)}.mp4`, new Date('2026-10-28T03:32:10Z'));
  check('a 150-character name keeps its extension', long.endsWith('.mp4') && isAllowedFileName(long) && long.length <= 130, long);
  check('a bare ".jpg" becomes "photo.jpg"', evidenceFileName('.jpg', new Date('2026-10-28T03:32:10Z')) === '2026-10-28 14-32-10 photo.jpg');
  check('a bare ".MOV" becomes "video.MOV"', evidenceFileName('.MOV', new Date('2026-10-28T03:32:10Z')) === '2026-10-28 14-32-10 video.MOV');
}
check('photos and videos allowed', ['a.jpg', 'b.JPEG', 'c.png', 'd.heic', 'e.heif', 'f.webp', 'g.mp4', 'h.MOV', 'i.m4v'].every(isAllowedFileName));
check('anything else refused', !['a.pdf', 'b.exe', 'c', 'd.jpg.exe', 'e.svg'].some(isAllowedFileName));
check('300 MB per file (owner decision 5)', MAX_FILE_BYTES === 300 * 1024 * 1024);
check('chunk is a multiple of 320 KiB and under 60 MiB', CHUNK_BYTES % (320 * 1024) === 0 && CHUNK_BYTES < 60 * 1024 * 1024);
check('upload roles = logistics/admin/superadmin/technician/workshop (owner decision 3)',
  JSON.stringify([...EVIDENCE_UPLOAD_ROLES].sort()) === JSON.stringify(['admin', 'logistics', 'superadmin', 'technician', 'workshop']));
check('delete = superadmin only (owner decision 3)', JSON.stringify(EVIDENCE_DELETE_ROLES) === '["superadmin"]');

// ---------------------------------------------------------------------------------------------
console.log('msgraph');
const ENV = {
  MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', MS_CLIENT_SECRET: 'shh',
  MS_EVIDENCE_SITE_URL: 'https://graysfitness.sharepoint.com/sites/shared.group/',
  MS_EVIDENCE_FOLDER: '\tDispatch Evidence - TEST ',
};
check('config trims stray tabs/spaces (Phase 0 learning)', graphConfig(ENV).folder === 'Dispatch Evidence - TEST');
check('configured with all five values', isGraphConfigured(ENV));
check('not configured when one is blank', !isGraphConfigured({ ...ENV, MS_CLIENT_SECRET: '  ' }));

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [method, re, reply] of routes) {
      if ((init.method || 'GET') === method && re.test(url)) {
        const { status = 200, json = null } = typeof reply === 'function' ? reply(url, init, calls) : reply;
        return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => (json == null ? '' : JSON.stringify(json)) };
      }
    }
    return { ok: false, status: 599, json: async () => ({}), text: async () => '{"error":{"message":"no route"}}' };
  };
  fn.calls = calls;
  return fn;
}
const TOKEN_ROUTE = ['POST', /login\.microsoftonline\.com\/tenant-1\/oauth2\/v2\.0\/token$/, { json: { access_token: 'tok-1', expires_in: 3599 } }];
const ROOT_ROUTES = [
  ['GET', /\/sites\/graysfitness\.sharepoint\.com:\/sites\/shared\.group$/, { json: { id: 'site-1' } }],
  ['GET', /\/sites\/site-1\/drive$/, { json: { id: 'drive-1' } }],
  ['GET', /\/drives\/drive-1\/root:\/Dispatch%20Evidence%20-%20TEST$/, { json: { id: 'root-folder', webUrl: 'https://sp/root' } }],
];
{
  const f = fakeFetch([TOKEN_ROUTE, ...ROOT_ROUTES]);
  const g = createGraph({ env: ENV, fetch: f });
  const root = await g.rootFolder();
  await g.rootFolder();
  check('root folder resolves site → drive → folder', root.id === 'root-folder' && root.driveId === 'drive-1');
  check('token fetched once and reused', f.calls.filter((c) => /oauth2/.test(c.url)).length === 1);
  check('root resolution cached', f.calls.filter((c) => /\/sites\//.test(c.url)).length === 2, `${f.calls.length} calls`);
  check('client credentials grant with the .default scope', /grant_type=client_credentials/.test(String(f.calls[0].init.body)) && /graph\.microsoft\.com%2F\.default/.test(String(f.calls[0].init.body)));
  check('Graph calls carry the bearer token', f.calls[1].init.headers.Authorization === 'Bearer tok-1');
}
{
  const f = fakeFetch([TOKEN_ROUTE, ...ROOT_ROUTES,
    ['POST', /\/drives\/drive-1\/items\/root-folder\/children$/, { status: 201, json: { id: 'wo-folder', name: '19623 - WO 731', webUrl: 'https://sp/wo' } }]]);
  const g = createGraph({ env: ENV, fetch: f });
  const made = await g.ensureFolder('root-folder', '19623 - WO 731');
  const post = f.calls.find((c) => c.init.method === 'POST' && /children$/.test(c.url));
  const body = JSON.parse(post.init.body);
  check('ensureFolder creates with conflictBehavior=fail', body['@microsoft.graph.conflictBehavior'] === 'fail' && body.folder && body.name === '19623 - WO 731');
  check('ensureFolder returns id + link', made.id === 'wo-folder' && made.webUrl === 'https://sp/wo');
}
{
  const f = fakeFetch([TOKEN_ROUTE, ...ROOT_ROUTES,
    ['POST', /\/items\/root-folder\/children$/, { status: 409, json: { error: { code: 'nameAlreadyExists', message: 'exists' } } }],
    ['GET', /\/items\/root-folder:\/19623%20-%20WO%20731$/, { json: { id: 'existing', name: '19623 - WO 731', webUrl: 'https://sp/existing' } }]]);
  const g = createGraph({ env: ENV, fetch: f });
  const made = await g.ensureFolder('root-folder', '19623 - WO 731');
  check('ensureFolder reuses a folder that already exists (409 → look up)', made.id === 'existing');
}
{
  const f = fakeFetch([TOKEN_ROUTE, ...ROOT_ROUTES,
    ['POST', /\/items\/item-folder:\/2026-10-28%2014-32-10%20front\.jpg:\/createUploadSession$/, { json: { uploadUrl: 'https://upload/abc', expirationDateTime: '2026-10-28T04:00:00Z' } }]]);
  const g = createGraph({ env: ENV, fetch: f });
  const s = await g.createUploadSession('item-folder', '2026-10-28 14-32-10 front.jpg');
  const body = JSON.parse(f.calls.at(-1).init.body);
  check('upload session: name encoded in the path, conflictBehavior=rename (never overwrite)', s.uploadUrl === 'https://upload/abc' && body.item['@microsoft.graph.conflictBehavior'] === 'rename');
}
{
  const f = fakeFetch([['POST', /oauth2/, { status: 401, json: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' } }]]);
  const g = createGraph({ env: ENV, fetch: f });
  const e = await rejects(() => g.rootFolder());
  check('a bad secret surfaces as GraphError(auth)', e instanceof GraphError && e.kind === 'auth', e && e.message);
  check('the error never carries the secret', !String(e.message).includes('shh'));
}
{
  const f = fakeFetch([TOKEN_ROUTE, ...ROOT_ROUTES, ['GET', /\/items\/gone(\?|$)/, { status: 404, json: { error: { code: 'itemNotFound', message: 'gone' } } }]]);
  const g = createGraph({ env: ENV, fetch: f });
  const e = await rejects(() => g.getItem('gone'));
  check('a missing item surfaces as GraphError status 404', e instanceof GraphError && e.status === 404);
  const d = await createGraph({ env: ENV, fetch: fakeFetch([TOKEN_ROUTE, ...ROOT_ROUTES, ['DELETE', /\/items\/x$/, { status: 404 }]]) }).deleteItem('x');
  check('deleting an already-deleted item is fine', d === false);
}

// ---------------------------------------------------------------------------------------------
console.log('handler');

const USERS = { NE: 'Nick', AN: 'Ana', ED: 'Eden', WK: 'Workshop', ST: 'Stacey', LG: 'Liam' };
const token = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET)}`;
const AUTH = {
  superadmin: token('NE', ['superadmin']),
  admin: token('AN', ['admin']),
  technician: token('ED', ['technician']),
  logistics: token('LG', ['logistics']),
  wk: token('WK', ['admin']),
  staff: token('ST', ['staff']),
};

const WO = { workorder_id: 731, invoice_id: '19623' };
const ITEMS = [
  { workorder_items_id: 2001, workorder_id: 731, product_id: 'TM-95T', product_name: 'Life Fitness 95T Treadmill', is_custom: false, custom_description: null },
  { workorder_items_id: 2002, workorder_id: 731, product_id: null, product_name: null, is_custom: true, custom_description: 'Install kit' },
];

function makeClient({ missing = false } = {}) {
  const state = { folders: [], files: [], logs: [], nextId: 1 };
  const calls = [];
  const undefinedTable = () => Object.assign(new Error('relation "dispatch_evidence_folders" does not exist'), { code: '42P01' });
  return {
    state, calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };
      if (/dispatch_evidence_/.test(sql) && missing) throw undefinedTable();

      // The workorder + its items (LEFT JOIN so a workorder without items still answers).
      if (/^SELECT/i.test(sql) && /FROM workorder w/.test(sql) && /LEFT JOIN workorder_items wi/.test(sql)) {
        if (Number(params[0]) !== WO.workorder_id) return { rows: [] };
        return { rows: ITEMS.map((i) => ({ ...WO, ...i })) };
      }
      if (/^SELECT/i.test(sql) && /FROM dispatch_evidence_folders/.test(sql)) {
        const [wo, item] = params.map(Number);
        return { rows: state.folders.filter((f) => f.workorder_id === wo && (sql.includes('COALESCE') ? (f.workorder_items_id || 0) === item : true)) };
      }
      if (/^INSERT INTO dispatch_evidence_folders/i.test(sql)) {
        const [workorder_id, workorder_items_id, drive_item_id, name, web_url, created_by] = params;
        const dup = state.folders.find((f) => f.workorder_id === Number(workorder_id) && (f.workorder_items_id || 0) === (Number(workorder_items_id) || 0));
        if (!dup) state.folders.push({ workorder_id: Number(workorder_id), workorder_items_id: workorder_items_id == null ? null : Number(workorder_items_id), drive_item_id, name, web_url, created_by });
        return { rows: [] };
      }
      if (/^DELETE FROM dispatch_evidence_folders/i.test(sql)) {
        state.folders = state.folders.filter((f) => f.workorder_id !== Number(params[0]));
        return { rows: [] };
      }
      if (/^INSERT INTO dispatch_evidence_files/i.test(sql)) {
        const [workorder_id, workorder_items_id, drive_item_id, file_name, mime_type, size_bytes, web_url, uploaded_by] = params;
        if (state.files.some((f) => f.drive_item_id === drive_item_id)) return { rows: [] };
        const row = { id: state.nextId++, workorder_id: Number(workorder_id), workorder_items_id: Number(workorder_items_id), drive_item_id, file_name, mime_type, size_bytes, web_url, uploaded_by, uploaded_at: new Date('2026-10-28T03:40:00Z'), deleted_at: null, deleted_by: null };
        state.files.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/^SELECT/i.test(sql) && /FROM dispatch_evidence_files f/.test(sql) && /f\.workorder_id = \$1/.test(sql)) {
        return { rows: state.files.filter((f) => f.workorder_id === Number(params[0]) && !f.deleted_at).map((f) => ({ ...f, uploaded_by_name: USERS[f.uploaded_by] || null })) };
      }
      if (/^SELECT id FROM dispatch_evidence_files WHERE drive_item_id = \$1$/.test(sql)) {
        return { rows: state.files.filter((f) => f.drive_item_id === params[0]).map((f) => ({ id: f.id })) };
      }
      if (/^SELECT/i.test(sql) && /FROM dispatch_evidence_files/.test(sql) && /WHERE id = \$1/.test(sql)) {
        return { rows: state.files.filter((f) => f.id === Number(params[0]) && !f.deleted_at) };
      }
      if (/^UPDATE dispatch_evidence_files SET deleted_at/i.test(sql)) {
        const f = state.files.find((x) => x.id === Number(params[0]) && !x.deleted_at);
        if (!f) return { rows: [] };
        f.deleted_at = new Date(); f.deleted_by = params[1];
        return { rows: [{ id: f.id }] };
      }
      if (/^INSERT INTO workorder_logs/i.test(sql)) {
        state.logs.push({ sql, params });
        return { rows: [] };
      }
      throw new Error(`fake client: unexpected SQL: ${sql.slice(0, 120)}`);
    },
  };
}

function makeGraph({ items = {}, failSessionOnce = false } = {}) {
  let n = 0;
  const calls = [];
  const store = { ...items }; // drive item id → item
  let sessionFails = failSessionOnce;
  return {
    calls, store,
    async rootFolder() { calls.push(['rootFolder']); return { id: 'root-folder', driveId: 'drive-1', webUrl: 'https://sp/root' }; },
    async ensureFolder(parentId, name) {
      calls.push(['ensureFolder', parentId, name]);
      n += 1;
      return { id: `folder-${n}`, name, webUrl: `https://sp/${encodeURIComponent(name)}` };
    },
    async createUploadSession(folderId, fileName) {
      calls.push(['createUploadSession', folderId, fileName]);
      if (sessionFails) { sessionFails = false; throw new GraphError('gone', { status: 404, code: 'itemNotFound' }); }
      return { uploadUrl: `https://upload/${folderId}`, expiresAt: '2026-10-28T04:00:00Z' };
    },
    async getItem(id) {
      calls.push(['getItem', id]);
      if (!store[id]) throw new GraphError('gone', { status: 404, code: 'itemNotFound' });
      return store[id];
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
const SESSION_BODY = { workorder_id: 731, workorder_items_id: 2001, file_name: 'front.jpg', size: 4_000_000 };

{
  const client = makeClient(); const graph = makeGraph();
  const r = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, client, graph });
  check('no token → 401', r.statusCode === 401);
  const s = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH.staff, client, graph });
  check('staff cannot upload → 403', s.statusCode === 403);
  const l = await call({ resource: 'list', query: { workorder_id: '731' }, auth: AUTH.staff, client, graph });
  check('staff can view the list', l.statusCode === 200, JSON.stringify(l.body));
  check('the list tells staff they cannot upload or delete', l.body.can_upload === false && l.body.can_delete === false);
  check('no Graph calls for refused callers', !graph.calls.some((c) => c[0] === 'ensureFolder'));
}

for (const who of ['technician', 'logistics', 'admin', 'superadmin', 'wk']) {
  const client = makeClient(); const graph = makeGraph();
  const r = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH[who], client, graph });
  check(`${who} can start an upload`, r.statusCode === 200 && r.body.upload_url, `${r.statusCode} ${JSON.stringify(r.body)}`);
}

{
  const client = makeClient(); const graph = makeGraph();
  const bad = async (body, what) => {
    const r = await call({ method: 'POST', resource: 'upload-session', body: { ...SESSION_BODY, ...body }, auth: AUTH.logistics, client, graph });
    check(`refused: ${what} → 400`, r.statusCode === 400, `${r.statusCode} ${JSON.stringify(r.body)}`);
  };
  await bad({ file_name: 'quote.pdf' }, 'not a photo or video');
  await bad({ size: MAX_FILE_BYTES + 1 }, 'over 300 MB');
  await bad({ size: 0 }, 'empty file');
  await bad({ workorder_items_id: 'abc' }, 'bad item id');
  const r = await call({ method: 'POST', resource: 'upload-session', body: { ...SESSION_BODY, workorder_items_id: 9999 }, auth: AUTH.logistics, client, graph });
  check('an item not on this workorder → 404', r.statusCode === 404);
  const w = await call({ method: 'POST', resource: 'upload-session', body: { ...SESSION_BODY, workorder_id: 1 }, auth: AUTH.logistics, client, graph });
  check('an unknown workorder → 404', w.statusCode === 404);
  check('nothing created in SharePoint for refused uploads', !graph.calls.some((c) => c[0] === 'ensureFolder'));
}

{
  const client = makeClient(); const graph = makeGraph();
  const r = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH.logistics, client, graph });
  const folderCalls = graph.calls.filter((c) => c[0] === 'ensureFolder');
  check('first upload creates the workorder folder under the evidence root', folderCalls[0][1] === 'root-folder' && folderCalls[0][2] === '19623 - WO 731', JSON.stringify(folderCalls));
  check('…then the item sub-folder inside it', folderCalls[1][1] === 'folder-1' && folderCalls[1][2] === 'TM-95T Life Fitness 95T Treadmill - item 2001');
  check('both folder ids stored in the portal database', client.state.folders.length === 2 && client.state.folders[0].workorder_items_id === null && client.state.folders[1].workorder_items_id === 2001);
  const sess = graph.calls.find((c) => c[0] === 'createUploadSession');
  check('session is opened in the ITEM folder with a timestamped name', sess[1] === 'folder-2' && /^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d front\.jpg$/.test(sess[2]), JSON.stringify(sess));
  check('response: upload_url + chunk size + expiry', r.body.upload_url === 'https://upload/folder-2' && r.body.chunk_bytes === CHUNK_BYTES && r.body.expires_at);

  const again = await call({ method: 'POST', resource: 'upload-session', body: { ...SESSION_BODY, file_name: 'back.mov' }, auth: AUTH.technician, client, graph });
  check('second upload reuses both stored folders (no new folders)', again.statusCode === 200 && graph.calls.filter((c) => c[0] === 'ensureFolder').length === 2);

  const other = await call({ method: 'POST', resource: 'upload-session', body: { ...SESSION_BODY, workorder_items_id: 2002 }, auth: AUTH.technician, client, graph });
  const last = graph.calls.filter((c) => c[0] === 'ensureFolder').at(-1);
  check('another item gets its own sub-folder in the same workorder folder', other.statusCode === 200 && last[1] === 'folder-1' && last[2] === 'Install kit - item 2002', JSON.stringify(last));
}

{
  // Someone deleted the folder in SharePoint: the stored id is stale → recreate once, then upload.
  const client = makeClient(); const graph = makeGraph({ failSessionOnce: true });
  client.state.folders.push({ workorder_id: 731, workorder_items_id: null, drive_item_id: 'stale-wo', name: 'x', web_url: null });
  client.state.folders.push({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'stale-item', name: 'y', web_url: null });
  const r = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH.logistics, client, graph });
  check('a folder deleted in SharePoint is recreated, once', r.statusCode === 200 && graph.calls.filter((c) => c[0] === 'createUploadSession').length === 2 && !client.state.folders.some((f) => /^stale/.test(f.drive_item_id)), `${r.statusCode} ${JSON.stringify(r.body)}`);
}

{
  const client = makeClient(); const graph = makeGraph({ items: {
    'file-1': { id: 'file-1', name: '2026-10-28 14-32-10 front.jpg', size: 4_000_000, file: { mimeType: 'image/jpeg' }, webUrl: 'https://sp/file-1', parentReference: { id: 'folder-2' } },
    'stray': { id: 'stray', name: 'x.jpg', size: 10, file: { mimeType: 'image/jpeg' }, webUrl: 'https://sp/stray', parentReference: { id: 'somewhere-else' } },
    'huge': { id: 'huge', name: 'big.mp4', size: MAX_FILE_BYTES + 10, file: { mimeType: 'video/mp4' }, webUrl: 'https://sp/huge', parentReference: { id: 'folder-2' } },
  } });
  await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH.logistics, client, graph });
  const done = (id, auth = AUTH.logistics) => call({ method: 'POST', resource: 'complete', body: { workorder_id: 731, workorder_items_id: 2001, drive_item_id: id }, auth, client, graph });

  const stray = await done('stray');
  check('complete refuses a file outside this item folder → 400', stray.statusCode === 400 && client.state.files.length === 0);
  const huge = await done('huge');
  check('complete refuses (and deletes) a file over 300 MB', huge.statusCode === 400 && !graph.store.huge && client.state.files.length === 0);
  const st = await done('file-1', AUTH.staff);
  check('staff cannot complete → 403', st.statusCode === 403);
  const ok = await done('file-1');
  check('complete records the file', ok.statusCode === 200 && client.state.files.length === 1 && client.state.files[0].uploaded_by === 'LG' && client.state.files[0].file_name === '2026-10-28 14-32-10 front.jpg', JSON.stringify(ok.body));
  check('…and adds one NOTE_ADDED workorder log line', client.state.logs.length === 1 && /NOTE_ADDED/.test(client.state.logs[0].sql) && /Dispatch evidence added/.test(client.state.logs[0].params.join(' ')), JSON.stringify(client.state.logs));
  const twice = await done('file-1');
  check('completing the same file twice records it once', twice.statusCode === 200 && client.state.files.length === 1 && client.state.logs.length === 1);
  // Review #2: a recorded file renamed in SharePoint must never be deleted by `complete`.
  graph.store['file-1'] = { ...graph.store['file-1'], name: 'renamed.pdf' };
  const renamed = await done('file-1');
  check('complete never deletes an already-recorded file (delete stays superadmin-only)', renamed.statusCode === 200 && !!graph.store['file-1'], `${renamed.statusCode} ${JSON.stringify(renamed.body)}`);
  graph.store['file-1'] = { ...graph.store['file-1'], name: '2026-10-28 14-32-10 front.jpg' };
  // Review #3: an unknown drive item is the caller's mistake, not Microsoft's.
  const bogus = await done('no-such-file');
  check('complete with an unknown file → 400', bogus.statusCode === 400, `${bogus.statusCode}`);
  // Review #5: a file whose size Graph does not report is not waved through.
  graph.store.nosize = { id: 'nosize', name: 'n.jpg', file: { mimeType: 'image/jpeg' }, parentReference: { id: 'folder-2' } };
  const ns = await done('nosize');
  check('complete refuses a file with no size', ns.statusCode === 400 && client.state.files.length === 1);

  const list = await call({ resource: 'list', query: { workorder_id: '731' }, auth: AUTH.technician, client, graph });
  const item = list.body.items.find((i) => i.workorder_items_id === 2001);
  check('list: every item, with its files, uploader and thumbnail', list.body.items.length === 2 && item.files.length === 1 && item.files[0].uploaded_by_name === 'Liam' && item.files[0].thumbnail_url === 'https://thumb/file-1', JSON.stringify(list.body));
  check('list: folder link + upload rights for a technician', list.body.folder_url && list.body.can_upload === true && list.body.can_delete === false);
  check('list: limits for the screen', list.body.max_file_bytes === MAX_FILE_BYTES && list.body.configured === true && list.body.available === true);

  const fileId = client.state.files[0].id;
  const del = (auth) => call({ method: 'DELETE', resource: 'file', query: { id: String(fileId) }, auth, client, graph });
  check('admin cannot delete → 403', (await del(AUTH.admin)).statusCode === 403);
  check('technician cannot delete → 403', (await del(AUTH.technician)).statusCode === 403);
  const d = await del(AUTH.superadmin);
  check('superadmin deletes: SharePoint item removed + row marked deleted', d.statusCode === 200 && !graph.store['file-1'] && client.state.files[0].deleted_by === 'NE');
  check('…with a NOTE_ADDED log line', client.state.logs.length === 2 && /Dispatch evidence removed/.test(client.state.logs[1].params.join(' ')));
  check('deleting again → 404', (await del(AUTH.superadmin)).statusCode === 404);
  const after = await call({ resource: 'list', query: { workorder_id: '731' }, auth: AUTH.technician, client, graph });
  check('deleted files leave the list', after.body.items.every((i) => i.files.length === 0));
}

{
  // A thumbnail failure must never break the list.
  const client = makeClient(); const graph = makeGraph();
  client.state.folders.push({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'folder-x', name: 'y', web_url: null });
  client.state.files.push({ id: 1, workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'f', file_name: 'a.jpg', uploaded_by: 'LG', uploaded_at: new Date(), deleted_at: null });
  graph.childrenWithThumbnails = async () => { throw new GraphError('boom', { status: 500 }); };
  const r = await call({ resource: 'list', query: { workorder_id: '731' }, auth: AUTH.admin, client, graph });
  check('list survives a thumbnail failure', r.statusCode === 200 && r.body.items[0].files[0].thumbnail_url === null);
}

{
  const client = makeClient({ missing: true }); const graph = makeGraph();
  const l = await call({ resource: 'list', query: { workorder_id: '731' }, auth: AUTH.admin, client, graph });
  check('before migration 0010: list says available:false', l.statusCode === 200 && l.body.available === false && l.body.items.length === 2);
  const u = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH.admin, client, graph });
  check('before migration 0010: upload → 503, nothing created in SharePoint', u.statusCode === 503 && !graph.calls.some((c) => c[0] === 'ensureFolder'), `${u.statusCode}`);
}

{
  const client = makeClient(); const graph = makeGraph();
  const l = await call({ resource: 'list', query: { workorder_id: '731' }, auth: AUTH.admin, client, graph, configured: false });
  check('Microsoft not configured (Production before go-live): list says configured:false', l.statusCode === 200 && l.body.configured === false);
  const u = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH.admin, client, graph, configured: false });
  check('Microsoft not configured: upload → 503', u.statusCode === 503);
  const d = await call({ method: 'DELETE', resource: 'file', query: { id: '1' }, auth: AUTH.admin, client, graph, configured: false });
  check('a non-superadmin delete is 403 even when not configured', d.statusCode === 403, `${d.statusCode}`);
}

{
  const client = makeClient();
  const graph = makeGraph();
  graph.ensureFolder = async () => { throw new GraphError('Microsoft refused the app login', { status: 401, kind: 'auth' }); };
  const u = await call({ method: 'POST', resource: 'upload-session', body: SESSION_BODY, auth: AUTH.admin, client, graph });
  check('Microsoft login failure → 502 with a plain message', u.statusCode === 502 && /Microsoft/.test(u.body.error), `${u.statusCode} ${JSON.stringify(u.body)}`);
  const m = await call({ method: 'PUT', resource: 'list', client, graph, auth: AUTH.admin });
  check('wrong method → 405', m.statusCode === 405);
  const x = await call({ resource: 'nope', client, graph, auth: AUTH.admin });
  check('unknown resource → 400', x.statusCode === 400);
}

// ---------------------------------------------------------------------------------------------
console.log('wiring');
const src = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const router = src('api/[...path].js');
check('routed through the existing catch-all (no new Vercel function)', /case 'evidence':\s*\n\s*return evidenceHandler\(req, res\);/.test(router));
check('no evidence-spike route left in the router', !/evidence-spike/.test(router));
const mig = src('db/migrations/0010_dispatch_evidence.sql');
check('migration 0010 is additive + idempotent', /CREATE TABLE IF NOT EXISTS dispatch_evidence_folders/.test(mig) && /CREATE TABLE IF NOT EXISTS dispatch_evidence_files/.test(mig) && !/DROP /i.test(mig));
check('one folder per workorder / per item (unique index)', /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON dispatch_evidence_folders \(workorder_id, \(COALESCE\(workorder_items_id, 0\)\)\)/.test(mig));
check('rollback 0010 exists', /DROP TABLE IF EXISTS dispatch_evidence_files/.test(src('db/migrations/0010_dispatch_evidence_down.sql')));
check('.env.example documents the Microsoft variables', ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_EVIDENCE_SITE_URL', 'MS_EVIDENCE_FOLDER'].every((k) => src('.env.example').includes(k)));

console.log(`\nops-dispatch-evidence-smoke: ${passed} checks passed`);
