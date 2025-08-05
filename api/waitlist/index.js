import { getClientWithTimezone } from '../../lib/db.js'; // adjust path if needed

export default async function handler(req, res) {
  const { method, query: { id }, body } = req;
  const client = await getClientWithTimezone();

  try {
    if (method === 'GET') {
      if (id) {
        const result = await client.query('SELECT * FROM waitlist');
        if (result.rows.length === 0) return res.status(404).json({ error: 'Waitlist not found' });
        return res.status(200).json(result.rows[0]);
      } else {
        const result = await client.query(`
          SELECT 
            w.*, 
            c.name AS customer_name, 
            c.email AS customer_email,
            c.phone AS customer_phone,
            w.salesperson,
            p.name AS product_name,
            p.stock
          FROM waitlist w
          JOIN customers c ON w.customer_id = c.id
          JOIN product p ON w.product_sku = p.sku
          WHERE w.status IN ('Active', 'Notified')
          ORDER BY p.stock DESC NULLS LAST, w.waitlisted ASC;
        `);
        return res.status(200).json(result.rows);
      }
    }

    if (method === 'POST') {
      const { customer_id, product_sku, staff_id, status = 'Active' } = body;
      await client.query(
        'INSERT INTO waitlist (customer_id, product_sku, salesperson, status, waitlisted) VALUES ($1, $2, $3, $4, NOW())',
        [customer_id, product_sku, staff_id, status]
      );
      return res.status(201).json({ message: 'Waitlist created' });
    }

    if (method === 'PUT') {
      const { customer_id, product_sku, staff_id, status } = body;
      await client.query(
        'UPDATE waitlist SET customer_id=$1, product_sku=$2, salesperson=$3, status=$4 WHERE id=$5',
        [customer_id, product_sku, staff_id, status, id]
      );
      return res.status(200).json({ message: 'Waitlist updated' });
    }

    if (method === 'DELETE') {
      await client.query('DELETE FROM waitlist WHERE id = $1', [id]);
      return res.status(204).end();
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${method} Not Allowed`);
  } catch (err) {
    console.error('Waitlist error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
