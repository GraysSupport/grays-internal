import { getClientWithTimezone } from '../../lib/db.js';

export default async function handler(req, res) {
  const { method, query: { id }, body } = req;
  const client = await getClientWithTimezone();

  try {
    if (method === 'GET') {
      if (id) {
        // Get workorder with items and customer details
        const result = await client.query(`
          SELECT 
            wo.*,
            c.name AS customer_name,
            c.email AS customer_email,
            c.phone AS customer_phone,
            json_agg(
              json_build_object(
                'workorder_items_id', wi.workorder_items_id,
                'product_id', wi.product_id,
                'quantity', wi.quantity,
                'condition', wi.condition,
                'technician_id', wi.technician_id,
                'status', wi.status
              )
            ) AS items
          FROM workorder wo
          JOIN customers c ON wo.customer_id = c.id
          LEFT JOIN workorder_items wi ON wo.workorder_id = wi.workorder_id
          WHERE wo.workorder_id = $1
          GROUP BY wo.workorder_id, c.name, c.email, c.phone
        `, [id]);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Workorder not found' });
        return res.status(200).json(result.rows[0]);
      } else {
        // List all workorders with minimal details
        const result = await client.query(`
          SELECT 
            wo.workorder_id,
            wo.invoice_id,
            wo.date_created AT TIME ZONE 'Australia/Melbourne' AS date_created,
            c.name AS customer_name,
            wo.status
          FROM workorder wo
          JOIN customers c ON wo.customer_id = c.id
          ORDER BY wo.date_created DESC;
        `);
        return res.status(200).json(result.rows);
      }
    }

    if (method === 'POST') {
      const {
        invoice_id,
        customer_id,
        salesperson,
        delivery_suburb,
        delivery_state,
        delivery_charged,
        notes,
        lead_time,
        estimated_complete,
        status,
        items // array of { product_id, quantity, condition, technician_id, status }
      } = body;

      await client.query('BEGIN');

      const woRes = await client.query(`
        INSERT INTO workorder (
          invoice_id, customer_id, salesperson, delivery_suburb, delivery_state, 
          delivery_charged, notes, lead_time, estimated_complete, status, date_created
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        RETURNING workorder_id
      `, [
        invoice_id, customer_id, salesperson, delivery_suburb, delivery_state,
        delivery_charged, notes, lead_time, estimated_complete, status
      ]);

      const workorderId = woRes.rows[0].workorder_id;

      if (Array.isArray(items)) {
        for (const item of items) {
          await client.query(`
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status
            ) VALUES ($1,$2,$3,$4,$5,$6)
          `, [
            workorderId, item.product_id, item.quantity, item.condition, item.technician_id, item.status
          ]);
        }
      }

      await client.query('COMMIT');
      return res.status(201).json({ message: 'Workorder created', workorder_id: workorderId });
    }

    if (method === 'PUT') {
      const {
        invoice_id,
        customer_id,
        salesperson,
        delivery_suburb,
        delivery_state,
        delivery_charged,
        notes,
        lead_time,
        estimated_complete,
        status,
        items // array of { workorder_items_id?, product_id, quantity, condition, technician_id, status }
      } = body;

      await client.query('BEGIN');

      await client.query(`
        UPDATE workorder
        SET invoice_id=$1, customer_id=$2, salesperson=$3, delivery_suburb=$4, delivery_state=$5,
            delivery_charged=$6, notes=$7, lead_time=$8, estimated_complete=$9, status=$10
        WHERE workorder_id=$11
      `, [
        invoice_id, customer_id, salesperson, delivery_suburb, delivery_state,
        delivery_charged, notes, lead_time, estimated_complete, status, id
      ]);

      // Clear and reinsert items (simpler approach)
      await client.query(`DELETE FROM workorder_items WHERE workorder_id = $1`, [id]);

      if (Array.isArray(items)) {
        for (const item of items) {
          await client.query(`
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status
            ) VALUES ($1,$2,$3,$4,$5,$6)
          `, [
            id, item.product_id, item.quantity, item.condition, item.technician_id, item.status
          ]);
        }
      }

      await client.query('COMMIT');
      return res.status(200).json({ message: 'Workorder updated' });
    }

    if (method === 'DELETE') {
      await client.query('BEGIN');
      await client.query(`DELETE FROM workorder_items WHERE workorder_id = $1`, [id]);
      await client.query(`DELETE FROM workorder WHERE workorder_id = $1`, [id]);
      await client.query('COMMIT');
      return res.status(204).end();
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${method} Not Allowed`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Workorder error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
