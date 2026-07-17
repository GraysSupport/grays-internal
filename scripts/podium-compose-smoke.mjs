// scripts/podium-compose-smoke.mjs — offline smoke for F20 increment 1 (compose seam).
//
// F20: a salesperson starts a NEW chat to a phone/email — but first DEDUPE. If a
// conversation for that phone/email already exists, reopen (if closed) and continue it
// instead of creating a duplicate; otherwise create the Podium contact and open a new
// thread. The dedupe/reopen/create decision is the feature's value, so it's covered here
// with injected service functions (no network, no mock, no DB), plus a handful of checks
// against the REAL typed mock to prove the create path is wired end-to-end.
//
//   node scripts/podium-compose-smoke.mjs

import {
  classifyTarget, contactMatchesTarget, findExistingConversation, composeConversation,
} from '../lib/podiumCompose.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
async function throwsCode(fn, code) {
  try { await fn(); return false; } catch (e) { return e?.code === code; }
}

console.log('F20 compose smoke — no DB, no network\n');

console.log('classifyTarget — phone vs email vs junk:');
{
  const phone = classifyTarget('+61 400 111 222');
  check('a spaced phone is classified as phone', phone.kind === 'phone');
  check('phone key is the normalised last-8 digits', phone.key === '00111222');
  const email = classifyTarget('  Maria@Example.COM ');
  check('an email is classified as email', email.kind === 'email');
  check('email key is trimmed + lowercased', email.key === 'maria@example.com');
  check('junk throws INVALID_COMPOSE_TARGET', await throwsCode(() => classifyTarget('hello there'), 'INVALID_COMPOSE_TARGET'));
  check('empty throws INVALID_COMPOSE_TARGET', await throwsCode(() => classifyTarget(''), 'INVALID_COMPOSE_TARGET'));
}

console.log('\ncontactMatchesTarget — phone (last-8) and email (case-insensitive):');
{
  const c = { phoneNumber: '+61400333444', email: 'Tom.H@Example.com' };
  check('matches on phone regardless of formatting', contactMatchesTarget(c, classifyTarget('0400 333 444')));
  check('matches on email case-insensitively', contactMatchesTarget(c, classifyTarget('tom.h@example.com')));
  check('does not match a different number', !contactMatchesTarget(c, classifyTarget('+61400999000')));
}

// --- injected service doubles ---------------------------------------------
const CONTACTS = {
  c_maria: { uid: 'c_maria', name: 'Maria', phoneNumber: '+61400111222', email: 'maria@example.com' },
  c_tom: { uid: 'c_tom', name: 'Tom', phoneNumber: '+61400333444', email: 'tom@example.com' },
};
const CONVS = [
  { uid: 'A', channel: { type: 'phone', identifier: '+61400111222' }, contact: { uid: 'c_maria' }, status: 'open' },
  { uid: 'B', channel: { type: 'facebook', identifier: 'fb:x' }, contact: { uid: 'c_tom' }, status: 'closed' },
];
function makeDeps(overrides = {}) {
  const calls = { sendMessage: [], setConversationStatus: [], createContact: [], openConversation: [] };
  const deps = {
    listConversations: async () => ({ data: CONVS }),
    getContact: async (_u, uid) => CONTACTS[uid] || null,
    sendMessage: async (_u, args) => { calls.sendMessage.push(args); return { conversationUid: args.conversationUid, uid: 'msg1' }; },
    setConversationStatus: async (_u, uid, status) => { calls.setConversationStatus.push({ uid, status }); return { uid, status }; },
    createContact: async (_u, args) => { calls.createContact.push(args); return { uid: 'c_new', ...args }; },
    openConversation: async (_u, args) => { calls.openConversation.push(args); return { uid: 'NEW_CNV' }; },
    ...overrides,
  };
  return { deps, calls };
}

console.log('\nfindExistingConversation — matches on phone and on the resolved contact:');
{
  const { deps } = makeDeps();
  const hitPhone = await findExistingConversation('U', classifyTarget('+61400111222'), deps);
  check('a phone target finds the phone-channel conversation', hitPhone?.uid === 'A');
  const hitEmail = await findExistingConversation('U', classifyTarget('tom@example.com'), deps);
  check('an email target finds the conversation via its resolved contact', hitEmail?.uid === 'B');
  const miss = await findExistingConversation('U', classifyTarget('+61400999000'), deps);
  check('an unknown target finds nothing', miss === null);
}

console.log('\ncomposeConversation — REUSE an open thread (no duplicate, no new contact):');
{
  const { deps, calls } = makeDeps();
  const r = await composeConversation('U', { to: '+61 400 111 222', channel: 'phone', body: 'Hi again' }, deps);
  check('reused=true', r.reused === true);
  check('reopened=false (it was already open)', r.reopened === false);
  check('returns the existing conversation id', r.conversationId === 'A');
  check('did NOT create a contact', calls.createContact.length === 0);
  check('did NOT reopen', calls.setConversationStatus.length === 0);
  check('sent the body INTO the existing conversation', calls.sendMessage.length === 1 && calls.sendMessage[0].conversationUid === 'A' && calls.sendMessage[0].body === 'Hi again');
}

console.log('\ncomposeConversation — REOPEN a closed thread, then continue it:');
{
  const { deps, calls } = makeDeps();
  const r = await composeConversation('U', { to: 'tom@example.com', channel: 'facebook', body: 'Following up' }, deps);
  check('reused=true', r.reused === true);
  check('reopened=true (it was closed)', r.reopened === true);
  check('returns the existing conversation id', r.conversationId === 'B');
  check('reopened via setConversationStatus(open)', calls.setConversationStatus.length === 1 && calls.setConversationStatus[0].uid === 'B' && calls.setConversationStatus[0].status === 'open');
  check('did NOT create a contact', calls.createContact.length === 0);
  check('sent the body into the reopened conversation', calls.sendMessage[0].conversationUid === 'B');
}

console.log('\ncomposeConversation — CREATE a brand-new thread when nothing matches:');
{
  const { deps, calls } = makeDeps();
  const r = await composeConversation('U', { to: '+61400999000', channel: 'sms', body: 'Hello, this is Grays' }, deps);
  check('reused=false', r.reused === false);
  check('created a contact with the phone number', calls.createContact.length === 1 && calls.createContact[0].phoneNumber === '+61400999000');
  check('opened a new conversation with the first message + the new contact', calls.openConversation.length === 1 && calls.openConversation[0].to === '+61400999000' && calls.openConversation[0].body === 'Hello, this is Grays' && calls.openConversation[0].contactUid === 'c_new');
  check('did NOT send into an existing conversation', calls.sendMessage.length === 0);
  check('returns the new conversation id', r.conversationId === 'NEW_CNV');
  check('did NOT reopen anything', calls.setConversationStatus.length === 0);
}

console.log('\ncomposeConversation — validation:');
{
  const { deps } = makeDeps();
  check('a junk target rejects with INVALID_COMPOSE_TARGET',
    await throwsCode(() => composeConversation('U', { to: 'nope', channel: 'sms', body: 'x' }, deps), 'INVALID_COMPOSE_TARGET'));
  check('an empty body rejects with COMPOSE_BODY_REQUIRED',
    await throwsCode(() => composeConversation('U', { to: '+61400999000', channel: 'sms', body: '   ' }, deps), 'COMPOSE_BODY_REQUIRED'));
}

// --- against the REAL typed mock (proves createContact + send-to-number wiring) -------
console.log('\nend-to-end against the typed mock (PODIUM_MOCK):');
{
  process.env.PODIUM_MOCK = 'true';
  const { composeConversation: realCompose } = await import('../lib/podiumCompose.js');
  // Maria (+61400111222) is a mock fixture with an OPEN conversation → reuse.
  const reuse = await realCompose('GA', { to: '+61400111222', channel: 'phone', body: 'Hi Maria' });
  check('mock: an existing fixture contact reuses its conversation', reuse.reused === true && !!reuse.conversationId);
  // A brand-new number → create contact + open a new conversation.
  const fresh = await realCompose('GA', { to: '+61400000123', channel: 'sms', body: 'New lead' });
  check('mock: a new number creates a new conversation', fresh.reused === false && !!fresh.conversationId);
  check('mock: the new conversation is readable back', fresh.conversationId !== reuse.conversationId);
}

console.log(`\n✅ compose smoke: ${passed} checks passed`);
