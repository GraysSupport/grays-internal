import { getClientWithTimezone } from '../../lib/db.js';

// Parsing lead time weeks label
function parseWeeks(label) {
  const m = String(label || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

export default async function handler(req, res) {
  const { method, query: { id }, body } = req;
  const client = await getClientWithTimezone();

  try {
    if (method === 'GET') {
      if (id) {
        // Single workorder with items + customer
        const result = await client.query(
          `
          SELECT 
            wo.workorder_id,
            wo.invoice_id,
            wo.customer_id,
            wo.salesperson,
            wo.delivery_suburb,
            wo.delivery_state,
            wo.delivery_charged,
            wo.lead_time,
            wo.estimated_completion,
            wo.notes,
            wo.status,
            wo.date_created,
            wo.outstanding_balance,
            c.name  AS customer_name,
            c.email AS customer_email,
            c.phone AS customer_phone,
            COALESCE(
              json_agg(
                json_build_object(
                  'workorder_items_id', wi.workorder_items_id,
                  'product_id',        wi.product_id,
                  'quantity',          wi.quantity,
                  'condition',         wi.condition,
                  'technician_id',     wi.technician_id,
                  'status',            wi.status,
                  'in_workshop',       wi.in_workshop
                )
              ) FILTER (WHERE wi.workorder_items_id IS NOT NULL),
              '[]'::json
            ) AS items
          FROM workorder wo
          JOIN customers c ON wo.customer_id = c.id
          LEFT JOIN workorder_items wi ON wo.workorder_id = wi.workorder_id
          WHERE wo.workorder_id = $1
          GROUP BY wo.workorder_id, c.name, c.email, c.phone
          `,
          [id]
        );

        if (!result.rows.length) {
          return res.status(404).json({ error: 'Workorder not found' });
        }
        return res.status(200).json(result.rows[0]);
      }

      // List workorders (summary)
      const list = await client.query(
        `
        SELECT 
          wo.workorder_id,
          wo.invoice_id,
          wo.date_created,
          wo.status,
          wo.outstanding_balance,
          c.name AS customer_name
        FROM workorder wo
        JOIN customers c ON wo.customer_id = c.id
        ORDER BY wo.date_created DESC
        `
      );
      return res.status(200).json(list.rows);
    }

    if (method === 'POST') {
      const {
        invoice_id,
        customer_id,
        salesperson,          // varchar(2)
        delivery_suburb,
        delivery_state,       // delivery_state_enum
        delivery_charged,
        lead_time,            // lead_time_enum e.g. "3 Weeks"
        estimated_completion, // optional (server can compute)
        notes,
        status,               // workorder_status_enum (defaults in DB to 'Work Ordered' if omitted)
        outstanding_balance,  // numeric (NOT NULL)
        items                 // [{ product_id, quantity, condition, technician_id, status? }]
      } = body || {};

      if (!invoice_id || !customer_id || !salesperson || !delivery_state || !lead_time || outstanding_balance == null) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      await client.query('BEGIN');

      // If client didn't send, compute estimated_completion = NOW() + lead_time(weeks)
      let estComplete = estimated_completion;
      if (!estComplete) {
        const weeks = parseWeeks(lead_time);
        if (weeks > 0) {
          const r = await client.query(
            `SELECT (NOW()::date + ($1 * 7) * INTERVAL '1 day')::date AS d`,
            [weeks]
          );
          estComplete = r.rows[0].d; // yyyy-mm-dd
        }
      }

      const woRes = await client.query(
        `
        INSERT INTO workorder (
          invoice_id, customer_id, salesperson, delivery_suburb, delivery_state,
          delivery_charged, lead_time, estimated_completion, notes, status, date_created, outstanding_balance
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)
        RETURNING workorder_id
        `,
        [
          invoice_id,
          customer_id,
          salesperson,
          delivery_suburb || null,
          delivery_state,
          delivery_charged ?? null,
          lead_time,
          estComplete,         // server-calculated if needed
          notes || null,
          status || 'Work Ordered',
          Number(outstanding_balance)
        ]
      );

      const workorderId = woRes.rows[0].workorder_id;

      if (Array.isArray(items) && items.length) {
        for (const item of items) {
          const itmStatus =
            item.status && String(item.status).trim()
              ? item.status
              : 'Not in Workshop'; // aligns with DB default

          await client.query(
            `
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            `,
            [
              workorderId,
              item.product_id,
              Number(item.quantity),
              item.condition,         // must match condition_enum
              item.technician_id,     // varchar(2)
              itmStatus
            ]
          );
        }
      }

      await client.query('COMMIT');
      return res.status(201).json({ message: 'Workorder created', workorder_id: workorderId });
    }

    if (method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });

      const {
        invoice_id,
        customer_id,
        salesperson,
        delivery_suburb,
        delivery_state,
        delivery_charged,
        lead_time,
        estimated_completion, // client may overwrite
        notes,
        status,
        outstanding_balance,
        items
      } = body || {};

      await client.query('BEGIN');

      await client.query(
        `
        UPDATE workorder
           SET invoice_id=$1,
               customer_id=$2,
               salesperson=$3,
               delivery_suburb=$4,
               delivery_state=$5,
               delivery_charged=$6,
               lead_time=$7,
               estimated_completion=$8,
               notes=$9,
               status=$10,
               outstanding_balance=$11
         WHERE workorder_id=$12
        `,
        [
          invoice_id,
          customer_id,
          salesperson,
          delivery_suburb || null,
          delivery_state,
          delivery_charged ?? null,
          lead_time,
          estimated_completion,
          notes || null,
          status || 'Work Ordered',
          Number(outstanding_balance),
          id
        ]
      );

      // Replace items (simple approach)
      await client.query(`DELETE FROM workorder_items WHERE workorder_id = $1`, [id]);

      if (Array.isArray(items) && items.length) {
        for (const item of items) {
          const itmStatus =
            item.status && String(item.status).trim()
              ? item.status
              : 'Not in Workshop';

          await client.query(
            `
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            `,
            [
              id,
              item.product_id,
              Number(item.quantity),
              item.condition,
              item.technician_id,
              itmStatus
            ]
          );
        }
      }

      await client.query('COMMIT');
      return res.status(200).json({ message: 'Workorder updated' });
    }

    if (method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });
      await client.query('BEGIN');
      await client.query(`DELETE FROM workorder_items WHERE workorder_id = $1`, [id]);
      await client.query(`DELETE FROM workorder WHERE workorder_id = $1`, [id]);
      await client.query('COMMIT');
      return res.status(204).end();
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    return res.status(405).end(`Method ${method} Not Allowed`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Workorder API error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
