import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async function handler(req, res) {
  const { id } = req.query;
  const { method } = req;

  try {
    if (method === 'GET') {
      const result = await pool.query('SELECT * FROM waitlist WHERE waitlist_id = $1', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
      return res.status(200).json(result.rows[0]);
    }

    if (method === 'PUT') {
      const { status, notes } = req.body;
      await pool.query(
        'UPDATE waitlist SET status = $1, notes = $2 WHERE waitlist_id = $3',
        [status, notes, id]
      );
      return res.status(200).json({ message: 'Waitlist updated' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
}