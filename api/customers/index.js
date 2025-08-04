import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  const { method, query, body } = req;
  const { id } = query;

  try {
    if (method === 'GET') {
      if (id) {
        const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Customer not found' });
        }
        return res.status(200).json(result.rows[0]);
      } else {
        const result = await pool.query('SELECT * FROM customers ORDER BY id ASC');
        return res.status(200).json(result.rows);
      }
    }

    if (method === 'POST') {
      const { name, email, phone, address, notes } = body;
      if (!name || !email) {
        return res.status(400).json({ error: 'Name and email are required' });
      }

      const insert = await pool.query(
        `INSERT INTO customers (name, email, phone, address, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, email, phone || null, address || null, notes || null]
      );

      return res.status(201).json(insert.rows[0]);
    }

    if (method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Missing customer ID' });

      const { name, email, phone, address, notes } = body;
      const update = await pool.query(
        `UPDATE customers
         SET name = $1, email = $2, phone = $3, address = $4, notes = $5
         WHERE id = $6 RETURNING *`,
        [name, email, phone || null, address || null, notes || null, id]
      );

      if (update.rowCount === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      return res.status(200).json(update.rows[0]);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Customer API error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
