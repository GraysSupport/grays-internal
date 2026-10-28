// scripts/ops-podium-hide-smoke.mjs — offline smoke for "hide Podium" (28 Oct 2026).
//
// The owner is moving off Podium (likely to Coax) and asked for every Podium feature to be
// hidden for ALL users, without deleting the code, so it can be recalled later. One switch
// does it, default OFF:
//
//   server  FEATURE_PODIUM=true            (lib/featureFlags.js  isPodiumEnabled)
//   client  REACT_APP_FEATURE_PODIUM=true  (src/utils/featureFlags.js, inlined at build time)
//
// This smoke proves both states: OFF hides/blocks every entry point; ON restores them.
//
//   node scripts/ops-podium-hide-smoke.mjs

import { readFileSync } from 'node:fs';

process.env.JWT_SECRET = 'test-secret-for-podium-hide-smoke';
delete process.env.FEATURE_PODIUM;
delete process.env.REACT_APP_FEATURE_PODIUM;
delete process.env.PODIUM_WEBHOOK_SECRET;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
// Normalise CRLF so the source checks pass on a Windows checkout (core.autocrlf) too.
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function resSpy() {
  const out = { statusCode: null, body: null, headers: {}, ended: false };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return this; },
    json(body) { out.body = body; return this; },
    send(body) { out.body = body; return this; },
    end() { out.ended = true; return this; },
  };
}
const reqAt = (url, method = 'GET', query = {}) => ({ url, method, query, headers: {} });
const isDisabled = (r) => r.out.statusCode === 404 && r.out.body?.code === 'PODIUM_DISABLED';

const setFlag = (on) => {
  if (on) { process.env.FEATURE_PODIUM = 'true'; process.env.REACT_APP_FEATURE_PODIUM = 'true'; }
  else { delete process.env.FEATURE_PODIUM; delete process.env.REACT_APP_FEATURE_PODIUM; }
};

// ---- 1. the switch itself ------------------------------------------------------------
console.log('switch');
const flags = await import('../lib/featureFlags.js');
const clientFlags = await import('../src/utils/featureFlags.js');
for (const [v, want] of [[undefined, false], ['', false], ['false', false], ['1', false],
  ['yes', false], ['true', true], ['TRUE', true], [' true ', true]]) {
  check(`server FEATURE_PODIUM=${JSON.stringify(v)} → ${want}`,
    flags.isPodiumEnabled({ FEATURE_PODIUM: v }) === want);
  check(`client REACT_APP_FEATURE_PODIUM=${JSON.stringify(v)} → ${want}`,
    clientFlags.isPodiumEnabled({ REACT_APP_FEATURE_PODIUM: v }) === want);
}
check('server default (env unset) is OFF', flags.isPodiumEnabled() === false);
check('client default (env unset) is OFF', clientFlags.isPodiumEnabled() === false);

// ---- 2. Podium API catch-all + OAuth shims + webhook ---------------------------------
console.log('podium endpoints');
const podiumRouter = (await import('../api/podium/[...podium].js')).default;
const oauthStart = (await import('../api/podium/oauth/start.js')).default;
const oauthCallback = (await import('../api/podium/oauth/callback.js')).default;
const webhook = (await import('../api/podium/webhook.js')).default;

setFlag(false);
for (const path of ['status', 'inbox', 'assign', 'contact', 'oauth/start', 'oauth/callback']) {
  const r = resSpy();
  await podiumRouter(reqAt(`/api/podium/${path}`), r);
  check(`OFF: /api/podium/${path} → 404 PODIUM_DISABLED`, isDisabled(r), JSON.stringify(r.out));
}
for (const [name, h] of [['oauth/start shim', oauthStart], ['oauth/callback shim', oauthCallback]]) {
  const r = resSpy();
  await h(reqAt('/api/podium/x'), r);
  check(`OFF: ${name} → 404 PODIUM_DISABLED`, isDisabled(r), JSON.stringify(r.out));
}
{
  // Podium may still be POSTing to the registered webhook: acknowledge (200, so it does not
  // retry forever) but do nothing — no lead, no log row, no DB at all.
  const r = resSpy();
  await webhook(reqAt('/api/podium/webhook', 'POST'), r);
  check('OFF: webhook acks 200 and ignores the event', r.out.statusCode === 200 && r.out.body?.ignored === 'podium-disabled',
    JSON.stringify(r.out));
}

setFlag(true);
{
  const r = resSpy();
  await podiumRouter(reqAt('/api/podium/status'), r);
  check('ON: /api/podium/status reaches its handler (401 without a token)', r.out.statusCode === 401, JSON.stringify(r.out));
  const w = resSpy();
  await webhook(reqAt('/api/podium/webhook', 'POST'), w);
  check('ON: webhook is live again (503 — no secret in this test)', w.out.statusCode === 503, JSON.stringify(w.out));
}

// ---- 3. leads / integrations / awaiting-workorder via the main catch-all ------------
console.log('main catch-all');
const mainRouter = (await import('../api/[...path].js')).default;
setFlag(false);
for (const [url, query] of [['/api/leads', {}], ['/api/lead/12/stage', {}], ['/api/integrations', { resource: 'sync-log' }],
  ['/api/logistics', { resource: 'awaiting-workorder' }], ['/api/logistics/awaiting-workorder', {}]]) {
  const r = resSpy();
  await mainRouter(reqAt(url, 'GET', query), r);
  check(`OFF: ${url}${query.resource ? `?resource=${query.resource}` : ''} → 404 PODIUM_DISABLED`, isDisabled(r), JSON.stringify(r.out));
}
{
  // The G8 temporary delivery run shares the logistics handler and is NOT Podium.
  const r = resSpy();
  await mainRouter(reqAt('/api/logistics', 'GET', { resource: 'run-candidates' }), r);
  check('OFF: logistics run-candidates (G8, not Podium) still reaches its handler (401)', r.out.statusCode === 401, JSON.stringify(r.out));
  const p2 = resSpy();
  await mainRouter(reqAt('/api/logistics/run-candidates'), p2);
  check('OFF: logistics run-candidates in path form still reaches its handler (401)', p2.out.statusCode === 401, JSON.stringify(p2.out));
}
setFlag(true);
{
  const r = resSpy();
  await mainRouter(reqAt('/api/leads'), r);
  check('ON: /api/leads reaches its handler (401 without a token)', r.out.statusCode === 401, JSON.stringify(r.out));
  for (const [url, query] of [['/api/integrations', { resource: 'sync-log' }], ['/api/logistics', { resource: 'awaiting-workorder' }]]) {
    const x = resSpy();
    await mainRouter(reqAt(url, 'GET', query), x);
    check(`ON: ${url}?resource=${query.resource} reaches its handler (401)`, x.out.statusCode === 401, JSON.stringify(x.out));
  }
}

// ---- 4. Podium side-effects inside non-Podium handlers ------------------------------
console.log('side effects');
setFlag(false);
{
  const deliveryHandler = (await import('../lib/handlers/delivery.js')).default;
  const r = resSpy();
  const queries = [];
  const fakeClient = { query: async (sql) => { queries.push(sql); return { rows: [] }; }, release() {} };
  await deliveryHandler(reqAt('/api/delivery', 'POST', { resource: 'booking-sms', id: '5' }), r, [], { getClient: async () => fakeClient });
  check('OFF: POST /api/delivery?resource=booking-sms → 404 PODIUM_DISABLED (no text can be sent)', isDisabled(r), JSON.stringify(r.out));
  check('OFF: booking-sms ran no SQL at all', queries.length === 0, queries.join(' | '));

  const d = src('lib/handlers/delivery.js');
  const previews = d.match(/if \([^\n]*\) \{\n\s*try \{ booking_sms = await previewDeliveryBookedSms/g) || [];
  check('delivery: both booking-SMS previews exist', previews.length === 2, String(previews.length));
  check('delivery: both booking-SMS previews require isPodiumEnabled()', previews.every((p) => p.includes('isPodiumEnabled()')));

  const c = src('lib/handlers/collections.js');
  check('collections: the waitlist back-in-stock SMS only runs when Podium is on',
    /if \(isPodiumEnabled\(\)\) \{\s*waitlistNotified = await notifyWaitlistBackInStock\(/.test(c));
}

{
  // Customer Journey: the lead-funnel steps are dropped by the SERVER while hidden.
  const { buildJourney } = await import('../lib/customerJourney.js');
  const rows = [
    { category: 'lead', code: 'LEAD_CREATED', to_val: 'New', ref_type: 'lead', ref_id: 3, event_time: '2026-10-01' },
    { category: 'workorder', code: 'WORKORDER_CREATED', to_val: 'Not Started', ref_type: 'workorder', ref_id: 9, event_time: '2026-10-02' },
  ];
  const fake = () => ({
    query: async (sql) => (/FROM customers WHERE id/.test(sql) ? { rowCount: 1, rows: [{ id: 1 }] } : { rows }),
    release() {},
  });
  const off = await buildJourney(1, { getClient: async () => fake() });
  check('OFF: the customer Journey API leaves out lead-funnel steps', off.events.length === 1 && off.events[0].category === 'workorder',
    JSON.stringify(off.events.map((e) => e.category)));
  setFlag(true);
  const on = await buildJourney(1, { getClient: async () => fake() });
  check('ON: the customer Journey API includes them again', on.events.length === 2);
  setFlag(false);
}

// ---- 5. the portal screens ------------------------------------------------------------
console.log('screens');
const { buildNavItems } = await import('../src/utils/nav.js');
const superadmin = { user: { id: 'GS', access: 'superadmin' }, roles: ['superadmin', 'sales', 'logistics'] };
const PODIUM_KEYS = ['inbox', 'leads', 'logistics', 'integrations'];
setFlag(false);
{
  const keys = buildNavItems(superadmin).map((i) => i.key);
  check('OFF: menu has no Inbox / Lead Funnel / Awaiting Workorder / Integrations', PODIUM_KEYS.every((k) => !keys.includes(k)), keys.join(','));
  check('OFF: the rest of the menu is unchanged (delivery, products, register)', ['delivery', 'products', 'register'].every((k) => keys.includes(k)));
}
setFlag(true);
{
  const keys = buildNavItems(superadmin).map((i) => i.key);
  check('ON: all four Podium menu items come back', PODIUM_KEYS.every((k) => keys.includes(k)), keys.join(','));
}

const app = src('src/App.js');
check('App: while hidden, old links to the four Podium pages redirect to the dashboard',
  /const PODIUM_PATHS = \['\/inbox', '\/leads', '\/logistics\/awaiting-workorder', '\/integrations'\];/.test(app)
  && /\{!podiumOn && PODIUM_PATHS\.map\(\(path\) => \(\s*<Route key=\{path\} path=\{path\} element=\{<Navigate to="\/dashboard" replace \/>\} \/>/.test(app));
check('App: the four Podium routes are only registered when Podium is on',
  /\{podiumOn && \(\s*<>\s*<Route path="\/inbox"[\s\S]*?path="\/leads"[\s\S]*?path="\/logistics\/awaiting-workorder"[\s\S]*?path="\/integrations"[\s\S]*?<\/>\s*\)\}/.test(app));

const settings = src('src/pages/settings.js');
check('Settings: the Podium card requires the switch', /const canConnectPodium = isPodiumEnabled\(\) &&/.test(settings));
check('Settings: the Podium status fetch is skipped when the card is hidden', /if \(!canConnectPodium\) return/.test(settings));

const customer = src('src/pages/customers/[id].js');
check('Customer page: the Conversations tab requires the switch', /const podiumOn = isPodiumEnabled\(\);\s*const canSeeConversations = podiumOn &&/.test(customer));
check('Customer page: lead-funnel steps are left out of the Journey when hidden',
  /setEvents\(podiumOn \? all : all\.filter\(\(e\) => e\.category !== 'lead'\)\)/.test(customer));
check('Customer page: Conversations is not offered as a tab when hidden',
  /podiumOn \? \[\['journey', 'Journey'\], \['conversations', 'Conversations'\]\] : \[\['journey', 'Journey'\]\]/.test(customer));

setFlag(false);
console.log(`\nops-podium-hide-smoke: ${passed} checks passed`);
