// api/podium/oauth/start.js — static function entry for the OAuth start endpoint.
//
// HOTFIX (14 Jul 2026): Vercel stopped routing multi-segment paths
// (/api/podium/oauth/start) into the api/podium/[...podium].js catch-all — the
// platform returns NOT_FOUND before the function runs (same regression F6 hit with
// /api/customers/:id/journey on 13 Jul). Static file paths still route normally, so
// this file pins the exact URL the Settings page calls. The handler body is unchanged
// in lib/podiumRoutes/oauthStart.js; the catch-all keeps serving status/inbox/etc.
// 28 Oct 2026: wrapped so it answers PODIUM_DISABLED while FEATURE_PODIUM is off.
import handler from '../../../lib/podiumRoutes/oauthStart.js';
import { withPodium } from '../../../lib/featureFlags.js';

export default withPodium(handler);
