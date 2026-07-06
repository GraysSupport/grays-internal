// scripts/podium-webhook-register.mjs — admin-once Podium webhook registration (F2).
//
// Registers the location/org webhook subscription so Podium starts POSTing events to
// our receiver (api/podium/webhook.js). Run ONCE by an admin whose Podium account is
// linked with a location-scoped token (F1 step 3). Per location/org, NOT per-user (P4).
//
//   PODIUM_MOCK=true  node scripts/podium-webhook-register.mjs            # dry, mock echo
//   PODIUM_MOCK=false PODIUM_CLIENT_ID=… PODIUM_WEBHOOK_SECRET=… \
//     PODIUM_WEBHOOK_URL=https://<portal>/api/podium/webhook \
//     node scripts/podium-webhook-register.mjs <adminPortalUserId>        # live
//
// The receiver verifies every event's HMAC with PODIUM_WEBHOOK_SECRET, so the SAME
// secret must be set here and in the receiver's Vercel env. In mock mode the call is
// served by lib/podium.mock.js (echo) so the wiring is exercisable without live creds.
//
// LIVE PREREQ (deferred until Podium creds exist): an admin must have completed the
// location-scoped OAuth connect (scope_level='location') so createWebhook() runs on a
// token that can manage webhooks. Until then this script is mock-only.

const adminUserId = process.argv[2] || process.env.PODIUM_ADMIN_USER_ID || 'AD';

process.env.PODIUM_API_VERSION = process.env.PODIUM_API_VERSION || '2021-04-01';

const { createWebhook, isMock } = await import('../lib/podium.js');

const url = process.env.PODIUM_WEBHOOK_URL
  || (process.env.PODIUM_REDIRECT_URI
      ? process.env.PODIUM_REDIRECT_URI.replace(/\/oauth\/callback$/, '/webhook')
      : 'https://example.invalid/api/podium/webhook');

// The event types the receiver routes (§10). message.* + the conversation-assignment
// event (exact name VERIFY at live wiring) + contact/lead/review as we grow into them.
const eventTypes = [
  'message.received',
  'message.sent',
  'message.failed',
  'conversation.assignee.updated', // VERIFY exact assignment event name vs docs.podium.com
];

console.log(`Podium webhook registration (mock=${isMock()})`);
console.log(`  admin user : ${adminUserId}`);
console.log(`  receiver   : ${url}`);
console.log(`  events     : ${eventTypes.join(', ')}`);

if (!isMock() && !process.env.PODIUM_WEBHOOK_SECRET) {
  console.error('\n✗ PODIUM_WEBHOOK_SECRET is required for a live registration (it is the HMAC key the receiver verifies).');
  process.exit(1);
}

try {
  const wh = await createWebhook(adminUserId, {
    url,
    secret: process.env.PODIUM_WEBHOOK_SECRET || 'mock_secret',
    eventTypes,
    locationUid: process.env.PODIUM_LOCATION_UID,
    organizationUid: process.env.PODIUM_ORG_UID,
  });
  console.log('\n✓ Registered webhook:', JSON.stringify(wh, null, 2));
  if (isMock()) console.log('\n(Mock echo — no real subscription created. Set PODIUM_MOCK=false + creds to register live.)');
} catch (err) {
  console.error('\n✗ Registration failed:', err.message);
  process.exit(1);
}
