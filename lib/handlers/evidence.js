// lib/handlers/evidence.js — G18 dispatch evidence (photos + videos per workorder item → SharePoint).
// Routed via api/[...path].js as `case 'evidence'` (no new serverless function). The logic,
// routes and rules live in lib/dispatchEvidence.js.
import { getClientWithTimezone } from '../db.js';
import { handleEvidence } from '../dispatchEvidence.js';

export default async function handler(req, res) {
  const client = await getClientWithTimezone();
  try {
    return await handleEvidence(req, res, client);
  } catch (err) {
    console.error('evidence handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
