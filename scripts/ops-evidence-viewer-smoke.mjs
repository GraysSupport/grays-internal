// scripts/ops-evidence-viewer-smoke.mjs — offline smoke for G28 (owner, 10 Nov 2026): photos and
// videos open in a pop-up INSIDE the portal instead of sending people to SharePoint (which needs a
// Microsoft login most users don't have).
//
//   GET /api/evidence?resource=view&id=12          a dispatch-evidence file → short-lived view link
//   GET /api/evidence?resource=before-view&id=7    a before-refurbishment photo → short-lived view link
//
// The link comes from Microsoft Graph at the moment of the click (pre-authenticated, ~1 hour):
// photos the browser can show → the file itself; HEIC/HEIF → a large JPEG preview; videos → the
// file. Exercises lib/msgraph.js viewLinks with a fake fetch, and the handlers with a fake pg
// client + fake Graph — no network, no database, no secrets.
//
//   node scripts/ops-evidence-viewer-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

const jwt = (await import('jsonwebtoken')).default;
const { createGraph, GraphError } = await import('../lib/msgraph.js');
const { handleEvidence, viewKind } = await import('../lib/dispatchEvidence.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('viewKind');
check('jpg / png / webp / gif → shown as-is', ['a.jpg', 'b.JPEG', 'c.png', 'd.webp'].every((n) => viewKind(n, 'image/jpeg') === 'image'));
check('HEIC / HEIF → preview (browsers cannot show them)', viewKind('IMG_1.HEIC', 'image/heic') === 'preview' && viewKind('x.heif', null) === 'preview');
check('mp4 / mov / m4v → video', ['a.mp4', 'b.MOV', 'c.m4v'].every((n) => viewKind(n, null) === 'video') && viewKind('x', 'video/mp4') === 'video');

console.log('msgraph viewLinks');
const ENV = {
  MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 'shh',
  MS_EVIDENCE_SITE_URL: 'https://graysfitness.sharepoint.com/sites/shared.group', MS_EVIDENCE_FOLDER: 'Dispatch Evidence - TEST',
};
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [method, re, reply] of routes) {
      if ((init.method || 'GET') === method && re.test(url)) {
        return { ok: (reply.status || 200) < 300, status: reply.status || 200, json: async () => reply.json, text: async () => JSON.stringify(reply.json ?? null) };
      }
    }
    return { ok: false, status: 599, json: async () => ({}), text: async () => '{"error":{"message":"no route"}}' };
  };
  fn.calls = calls;
  return fn;
}
{
  const f = fakeFetch([
    ['POST', /oauth2/, { json: { access_token: 'tok', expires_in: 3599 } }],
    ['GET', /\/sites\/graysfitness/, { json: { id: 'site-1' } }],
    ['GET', /\/sites\/site-1\/drive$/, { json: { id: 'drive-1' } }],
    ['GET', /\/root:\//, { json: { id: 'root' } }],
    ['GET', /\/drives\/drive-1\/items\/f1\?\$expand=thumbnails$/, {
      json: { id: 'f1', name: 'a.HEIC', file: { mimeType: 'image/heic' }, '@microsoft.graph.downloadUrl': 'https://dl/f1', thumbnails: [{ large: { url: 'https://thumb/large/f1' } }] },
    }],
  ]);
  const v = await createGraph({ env: ENV, fetch: f }).viewLinks('f1');
  check('viewLinks returns the pre-authenticated download URL and the large preview', v.downloadUrl === 'https://dl/f1' && v.large === 'https://thumb/large/f1' && v.name === 'a.HEIC' && v.mimeType === 'image/heic', JSON.stringify(v));
  check('… and never puts the secret in a URL', !f.calls.some((c) => String(c.url).includes('shh')));
}

console.log('handler');
const token = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET)}`;
const AUTH = { staff: token('ST', ['staff']), technician: token('ED', ['technician']), wk: token('WK', ['admin']) };
const ROWS = {
  dispatch: { 12: { id: 12, workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'd-photo', file_name: 'front.jpg' }, 13: { id: 13, workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'd-video', file_name: 'walk.MOV' }, 14: { id: 14, workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'd-gone', file_name: 'x.jpg' } },
  before: { 7: { id: 7, lot_id: 55, workorder_items_id: null, drive_item_id: 'b-heic', file_name: 'IMG_9.HEIC' } },
};
function makeClient({ missing = false } = {}) {
  return {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (missing && /lot_photos|dispatch_evidence/.test(sql)) throw Object.assign(new Error('missing'), { code: '42P01' });
      if (/FROM dispatch_evidence_files/.test(sql) && /WHERE id = \$1/.test(sql)) return { rows: ROWS.dispatch[Number(params[0])] ? [ROWS.dispatch[Number(params[0])]] : [] };
      if (/FROM lot_photos/.test(sql) && /WHERE id = \$1/.test(sql)) return { rows: ROWS.before[Number(params[0])] ? [ROWS.before[Number(params[0])]] : [] };
      throw new Error(`fake client: unexpected SQL: ${sql.slice(0, 120)}`);
    },
  };
}
const ITEMS = {
  'd-photo': { name: 'front.jpg', mimeType: 'image/jpeg', downloadUrl: 'https://dl/d-photo', large: 'https://thumb/d-photo' },
  'd-video': { name: 'walk.MOV', mimeType: 'video/quicktime', downloadUrl: 'https://dl/d-video', large: 'https://thumb/d-video' },
  'b-heic': { name: 'IMG_9.HEIC', mimeType: 'image/heic', downloadUrl: 'https://dl/b-heic', large: 'https://thumb/b-heic' },
};
const graph = {
  calls: [],
  async viewLinks(id) {
    this.calls.push(id);
    if (!ITEMS[id]) throw new GraphError('gone', { status: 404, code: 'itemNotFound' });
    return ITEMS[id];
  },
};
async function call({ resource, id, auth, configured = true, client = makeClient(), method = 'GET' }) {
  const res = {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handleEvidence({ method, query: { resource, ...(id != null ? { id: String(id) } : {}) }, headers: auth ? { authorization: auth } : {} }, res, client, { graph, configured });
  return res;
}

check('no token → 401', (await call({ resource: 'view', id: 12 })).statusCode === 401);
check('POST → 405', (await call({ resource: 'view', id: 12, auth: AUTH.staff, method: 'POST' })).statusCode === 405);
{
  const r = await call({ resource: 'view', id: 12, auth: AUTH.staff });
  check('any logged-in user can view a dispatch photo (same as the list)', r.statusCode === 200, JSON.stringify(r.body));
  check('a jpg opens as the full-size file', r.body.kind === 'image' && r.body.url === 'https://dl/d-photo' && r.body.file_name === 'front.jpg', JSON.stringify(r.body));
  check('the link is never cached by the browser/CDN', /no-store/.test(r.headers['Cache-Control'] || ''));
}
{
  const r = await call({ resource: 'view', id: 13, auth: AUTH.technician });
  check('a video opens as a playable file', r.statusCode === 200 && r.body.kind === 'video' && r.body.url === 'https://dl/d-video');
}
{
  const r = await call({ resource: 'before-view', id: 7, auth: AUTH.wk });
  check('a before-photo HEIC opens as the large JPEG preview', r.statusCode === 200 && r.body.kind === 'image' && r.body.url === 'https://thumb/b-heic', JSON.stringify(r.body));
}
{
  // Review: a HEIC with no preview yet, or a video with no download link, never falls back to a
  // file the browser cannot show.
  ITEMS['b-heic'] = { ...ITEMS['b-heic'], large: null };
  const r = await call({ resource: 'before-view', id: 7, auth: AUTH.wk });
  check('HEIC with no preview yet → 404 with a plain message (not the raw HEIC)', r.statusCode === 404 && /not ready yet/.test(r.body.error), JSON.stringify(r.body));
  ITEMS['d-video'] = { ...ITEMS['d-video'], downloadUrl: null };
  const v = await call({ resource: 'view', id: 13, auth: AUTH.staff });
  check('video with no download link → 404 (never the JPEG preview)', v.statusCode === 404);
}
check('unknown / deleted file → 404', (await call({ resource: 'view', id: 99, auth: AUTH.staff })).statusCode === 404);
check('file gone from SharePoint → 404', (await call({ resource: 'view', id: 14, auth: AUTH.staff })).statusCode === 404);
check('bad id → 400', (await call({ resource: 'before-view', id: 'abc', auth: AUTH.staff })).statusCode === 400);
check('Microsoft not connected → 503', (await call({ resource: 'view', id: 12, auth: AUTH.staff, configured: false })).statusCode === 503);
check('tables missing → 503', (await call({ resource: 'before-view', id: 7, auth: AUTH.staff, client: makeClient({ missing: true }) })).statusCode === 503);

console.log(`\nops-evidence-viewer-smoke: ${passed} checks passed`);
