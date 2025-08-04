import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  try {
    const result = await pool.query('SELECT brand_id, brand_name FROM brand');
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Brand query failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch brands' });
  }
}