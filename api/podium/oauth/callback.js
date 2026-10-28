// api/podium/oauth/callback.js — static function entry for the OAuth callback.
//
// HOTFIX (14 Jul 2026): same as oauth/start.js — Vercel no longer routes
// multi-segment paths into api/podium/[...podium].js, and this URL is the exact
// redirect_uri registered with the Podium app (must match byte-for-byte), so it gets
// its own static function file. Handler body unchanged in lib/podiumRoutes/.
// 28 Oct 2026: wrapped so it answers PODIUM_DISABLED while FEATURE_PODIUM is off.
import handler from '../../../lib/podiumRoutes/oauthCallback.js';
import { withPodium } from '../../../lib/featureFlags.js';

export default withPodium(handler);
