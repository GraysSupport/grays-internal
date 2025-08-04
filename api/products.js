import { Pool } from 'pg';

let pool;

export default async function handler(req, res) {
  if (!pool) {
    try {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
    } catch (err) {
      console.error('DB connection error:', err.message);
      return res.status(500).json({ error: 'Database init failed' });
    }
  }

  if (req.method === 'GET') {
    try {
      const result = await pool.query('SELECT * FROM product');
      return res.status(200).json(result.rows);
    } catch (err) {
      console.error('Query error:', err.message);
      return res.status(500).json({ error: 'Query failed' });
    }
  }

  if (req.method === 'POST') {
    const { sku, brand, name, stock, price } = req.body;
    try {
      await pool.query(
        'INSERT INTO product (sku, brand, name, stock, price) VALUES ($1, $2, $3, $4, $5)',
        [sku, brand, name, stock, price]
      );
      return res.status(201).json({ message: 'Product created' });
    } catch (err) {
      console.error('Insert error:', err.message);
      return res.status(500).json({ error: 'Product creation failed' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}