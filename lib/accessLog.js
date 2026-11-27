// lib/accessLog.js — POST /api/access-log (SEC1, 27 Nov 2026: moved out of api/[...path].js).
// Was open to anyone and wrote whatever userId the browser sent. Now: login required, and the line
// is recorded under the SIGNED user id. Used by sign-out and the inactivity time-out.
import { getAuthUser } from './rbac.js';

export async function handleAccessLog(req, res, { getClient }) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const auth = getAuthUser(req);
  if (!auth || !auth.id) return res.status(401).json({ error: 'Please sign in again' });
  const description = String(req.body?.description ?? '').trim().slice(0, 500);
  if (!description) return res.status(400).json({ error: 'Missing data' });
  const client = await getClient();
  try {
    await client.query('INSERT INTO access_log (user_id, description) VALUES ($1,$2)', [String(auth.id).toUpperCase(), description]);
    return res.status(200).json({ message: 'Log created' });
  } finally {
    client.release();
  }
}
