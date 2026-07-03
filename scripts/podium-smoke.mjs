// scripts/podium-smoke.mjs — offline smoke test for the Podium service (F1).
//
// Exercises lib/podium.js end-to-end against lib/podium.mock.js. NO network, NO
// database, NO secrets — it forces PODIUM_MOCK=true, so request() short-circuits
// to the in-memory mock and never touches podium_oauth. Reviewers can run:
//
//   node scripts/podium-smoke.mjs
//
// Exit 0 = all checks passed; non-zero = a check threw.

process.env.PODIUM_MOCK = 'true';
// Give the version pin + scopes deterministic values for the assertions below.
process.env.PODIUM_API_VERSION = process.env.PODIUM_API_VERSION || '2021-04-01';
process.env.PODIUM_CLIENT_ID = process.env.PODIUM_CLIENT_ID || 'mock_client';
process.env.PODIUM_REDIRECT_URI = 'https://portal.example/api/podium/oauth/callback';

const podium = await import('../lib/podium.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const REP = 'AM'; // portal 2-char user id

console.log('Podium service smoke (PODIUM_MOCK=true)\n');

// 1. mock/config helpers
check('isMock() true under PODIUM_MOCK', podium.isMock() === true);
check('apiVersion() pinned', podium.apiVersion() === '2021-04-01');
check('scopes() = least-privilege set', podium.scopes().includes('read_messages') && !podium.scopes().includes('webhooks'));

// 2. needsRefresh (pure token math)
check('needsRefresh: far-future token is fresh', podium.needsRefresh(Date.now() + 60 * 60 * 1000) === false);
check('needsRefresh: expired token needs refresh', podium.needsRefresh(Date.now() - 1000) === true);
check('needsRefresh: within 5min skew needs refresh', podium.needsRefresh(Date.now() + 60 * 1000) === true);
check('needsRefresh: null needs refresh', podium.needsRefresh(null) === true);

// 3. authorize URL
const url = podium.buildAuthorizeUrl(REP);
check('authorize URL hits /oauth/authorize', url.startsWith('https://api.podium.com/oauth/authorize?'));
check('authorize URL carries state=userId', url.includes('state=AM'));
check('authorize URL space-encodes scopes', url.includes('read_messages') && url.includes('%20'));
check('authorize URL includes redirect_uri', url.includes(encodeURIComponent('https://portal.example/api/podium/oauth/callback')));

// 4. OAuth exchange + refresh (mock)
const tok = await podium.exchangeCode('auth-code-123');
check('exchangeCode returns access+refresh', !!tok.access_token && !!tok.refresh_token);
check('exchangeCode TTL is 10h', tok.expires_in === 10 * 60 * 60);
const refreshed = await podium.refreshAccessToken(tok.refresh_token);
check('refreshAccessToken returns a new access token', refreshed.access_token && refreshed.access_token !== tok.access_token);

// 5. tokenForUser in mock mode does NOT hit the DB
const mockTok = await podium.tokenForUser(REP);
check('tokenForUser returns synthetic token in mock', mockTok === `mock_at_${REP}`);

// 6. list conversations + cursor pagination
const page1 = await podium.listConversations(REP, { limit: 2 });
check('listConversations page1 has 2 items', page1.data.length === 2, `got ${page1.data.length}`);
check('listConversations page1 has nextCursor', !!page1.metadata.nextCursor);
const page2 = await podium.listConversations(REP, { limit: 2, cursor: page1.metadata.nextCursor });
check('listConversations page2 is a different page', page2.data[0].uid !== page1.data[0].uid);

const allConvos = await podium.paginate(REP, 'conversations', { limit: 2 });
check('paginate() walks every conversation', allConvos.length === 5, `got ${allConvos.length}`);

// 7. "My conversations" filter (drives F1b/F3 default view)
const mine = await podium.listConversations(REP, { assigneeUid: 'pod_usr_amELia' });
check('assignee filter returns only Amelia’s convos', mine.data.length === 2 && mine.data.every((c) => c.assignedUser?.uid === 'pod_usr_amELia'));

// 8. messages (live-only; never persisted — P1)
const msgs = await podium.listMessages(REP, 'pod_cnv_00001');
check('listMessages returns the thread', msgs.data.length === 3);
check('messages carry a body for live render only', typeof msgs.data[0].body === 'string');

// 9. send message
const sent = await podium.sendMessage(REP, { conversationUid: 'pod_cnv_00001', body: 'On its way!' });
check('sendMessage returns sent status', sent.status === 'sent' && sent.direction === 'outbound');

// 10. assignment (F1b)
const assigned = await podium.assignConversation(REP, 'pod_cnv_00003', 'pod_usr_amELia');
check('assignConversation sets the assignee', assigned.assignedUser?.uid === 'pod_usr_amELia');

// 11. users + contact + review invite
const users = await podium.getUsers(REP);
check('getUsers lists members', users.data.length === 3);
const contact = await podium.getContact(REP, 'pod_con_maRIA1');
check('getContact resolves the contact', contact.name === 'Maria Papadopoulos');
const invite = await podium.requestReview(REP, { contactUid: 'pod_con_maRIA1' });
check('requestReview sends an invite', invite.status === 'sent');

console.log(`\nAll ${passed} checks passed ✅`);
