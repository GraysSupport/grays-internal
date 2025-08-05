import { getClientWithTimezone } from '../lib/db.js';


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const client = await getClientWithTimezone();
  const { userId, description } = req.body;
  if (!userId || !description) return res.status(400).json({ error: 'Missing data' });

  try {
    await client.query(
      'INSERT INTO access_log (user_id, description) VALUES ($1, $2)',
      [userId, description]
    );
    res.status(200).json({ message: 'Log created' });
  } catch (error) {
    console.error('Logging error:', error);
    res.status(500).json({ error: 'Failed to log access' });
  }
}
