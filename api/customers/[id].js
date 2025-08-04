import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  const {
    query: { id },
    method,
  } = req;

  if (!id) return res.status(400).json({ error: 'Missing customer ID' });

  try {
    if (method === 'GET') {
      const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      return res.status(200).json(result.rows[0]);
    }

    if (method === 'PUT') {
      const { name, email, phone, address, notes } = req.body;
      await pool.query(
        'UPDATE customers SET name = $1, email = $2, phone = $3, address = $4, notes = $5 WHERE id = $6',
        [name, email, phone, address, notes, id]
      );
      return res.status(200).json({ message: 'Customer updated' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('API Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
