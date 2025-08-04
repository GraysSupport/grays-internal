import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  const {
    query: { sku },
    method,
    body,
  } = req;

  if (!sku) {
    return res.status(400).json({ error: 'SKU is required' });
  }

  try {
    if (method === 'GET') {
      const result = await pool.query('SELECT * FROM product WHERE sku = $1', [sku]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Product not found' });
      }
      return res.status(200).json(result.rows[0]);
    }

    if (method === 'PUT') {
      const { name, brand, stock, price } = body;

      await pool.query(
        'UPDATE product SET name = $1, brand = $2, stock = $3, price = $4 WHERE sku = $5',
        [name, brand, stock, price, sku]
      );

      return res.status(200).json({ message: 'Product updated' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Product error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}