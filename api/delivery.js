import { getClientWithTimezone } from '../lib/db.js';

// Always clamp to 2 chars to satisfy varchar(2)
function twoCharId(x) {
  const s = (x == null ? '' : String(x)).trim().toUpperCase();
  return (s || 'NA').slice(0, 2);
}

async function logEvent(client, { workorder_id, workorder_items_id = null, event_type, user_id = 'NA' }) {
  if (!workorder_id) return; // only log when WO context is known
  await client.query(
    `INSERT INTO workorder_logs (workorder_id, workorder_items_id, event_type, user_id)
     VALUES ($1,$2,$3,$4)`,
    [workorder_id, workorder_items_id, event_type, twoCharId(user_id)]
  );
}

export default async function handler(req, res) {
  const { method, query: { id, include_removalists }, body } = req;
  const client = await getClientWithTimezone();

  try {
    if (method === 'GET') {
      if (id) {
        // Single delivery with customer, removalist, and WO summary (items_text, outstanding_balance)
        const q = await client.query(
          `
          WITH wo_items AS (
            SELECT
              wi.workorder_id,
              COALESCE(
                string_agg(
                  (wi.quantity::text || ' × ' || COALESCE(p.name, wi.product_id))::text,
                  ', ' ORDER BY wi.workorder_items_id
                ) FILTER (WHERE wi.workorder_items_id IS NOT NULL),
                '—'
              ) AS items_text
            FROM workorder_items wi
            LEFT JOIN product p ON p.sku = wi.product_id
            GROUP BY wi.workorder_id
          )
          SELECT
            d.delivery_id,
            d.invoice_id,
            d.customer_id,
            d.delivery_suburb,
            d.delivery_state,
            d.delivery_charged,
            d.delivery_quoted,
            d.removalist_id,
            to_char(d.delivery_date, 'YYYY-MM-DD') AS delivery_date,  -- ← force string
            d.delivery_status,
            d.notes,
            d.workorder_id,
            d.date_created,
            c.name  AS customer_name,
            c.email AS customer_email,
            c.phone AS customer_phone,
            r.name  AS removalist_name,
            w.outstanding_balance,
            i.items_text
          FROM delivery d
          JOIN customers c ON c.id = d.customer_id
          LEFT JOIN removalist r ON r.id = d.removalist_id
          LEFT JOIN workorder   w ON w.workorder_id = d.workorder_id
          LEFT JOIN wo_items    i ON i.workorder_id = d.workorder_id
          WHERE d.delivery_id = $1
          `,
          [id]
        );
        if (!q.rows.length) return res.status(404).json({ error: 'Delivery not found' });

        // optionally include removalists list
        if (include_removalists) {
          const rem = await client.query(`SELECT id, name FROM removalist ORDER BY name ASC`);
          return res.status(200).json({ delivery: q.rows[0], removalists: rem.rows });
        }

        return res.status(200).json(q.rows[0]);
      }

      // List deliveries (newest first) with customer, removalist, and WO summary
      const list = await client.query(
        `
        WITH wo_items AS (
          SELECT
            wi.workorder_id,
            COALESCE(
              string_agg(
                (wi.quantity::text || ' × ' || COALESCE(p.name, wi.product_id))::text,
                ', ' ORDER BY wi.workorder_items_id
              ) FILTER (WHERE wi.workorder_items_id IS NOT NULL),
              '—'
            ) AS items_text
          FROM workorder_items wi
          LEFT JOIN product p ON p.sku = wi.product_id
          GROUP BY wi.workorder_id
        )
        SELECT
          d.delivery_id,
          d.invoice_id,
          d.customer_id,
          d.delivery_suburb,
          d.delivery_state,
          d.delivery_charged,
          d.delivery_quoted,
          d.removalist_id,
          to_char(d.delivery_date, 'YYYY-MM-DD') AS delivery_date,  -- ← force string
          d.delivery_status,
          d.notes,
          d.workorder_id,
          d.date_created,
          c.name AS customer_name,
          r.name AS removalist_name,
          w.outstanding_balance,
          i.items_text
        FROM delivery d
        JOIN customers c ON c.id = d.customer_id
        LEFT JOIN removalist r ON r.id = d.removalist_id
        LEFT JOIN workorder   w ON w.workorder_id = d.workorder_id
        LEFT JOIN wo_items    i ON i.workorder_id = d.workorder_id
        ORDER BY d.date_created DESC, d.delivery_id DESC

        `
      );

      // optionally include removalists list
      if (include_removalists) {
        const rem = await client.query(`SELECT id, name FROM removalist ORDER BY name ASC`);
        return res.status(200).json({ deliveries: list.rows, removalists: rem.rows });
      }

      return res.status(200).json(list.rows);
    }

    if (method === 'POST') {
      const {
        invoice_id,
        customer_id,
        delivery_suburb,
        delivery_state,
        delivery_charged,
        delivery_quoted,
        removalist_id,
        delivery_date,
        delivery_status,
        notes,
        workorder_id
      } = body || {};

      if (!invoice_id || !customer_id || !delivery_state) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // If creating directly as "Booked for Delivery", require date+carrier
      if (
        delivery_status === 'Booked for Delivery' &&
        (!delivery_date || !removalist_id)
      ) {
        return res.status(400).json({
          error: "Cannot set status to 'Booked for Delivery' without Delivery Date and Carrier",
        });
      }

      const actorId = twoCharId(req.headers['x-user-id'] || body?.user_id);

      await client.query('BEGIN');

      const r = await client.query(
        `
        INSERT INTO delivery (
          invoice_id, customer_id, delivery_suburb, delivery_state,
          delivery_charged, delivery_quoted, removalist_id, delivery_date,
          delivery_status, notes, workorder_id, date_created
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          COALESCE($9, 'To Be Booked'::delivery_status_enum), $10,$11, NOW()
        )
        RETURNING delivery_id, workorder_id, delivery_status
        `,
        [
          invoice_id,
          Number(customer_id),
          delivery_suburb || null,
          delivery_state,
          delivery_charged == null || delivery_charged === '' ? null : Number(delivery_charged),
          delivery_quoted == null || delivery_quoted === '' ? null : Number(delivery_quoted),
          removalist_id == null || removalist_id === '' ? null : Number(removalist_id),
          delivery_date || null,
          delivery_status || null,
          notes || null,
          workorder_id == null || workorder_id === '' ? null : Number(workorder_id),
        ]
      );

      // Log against WO if present
      const woid = r.rows[0].workorder_id || (workorder_id ? Number(workorder_id) : null);
      if (r.rows[0].delivery_status === 'Booked for Delivery') {
        await logEvent(client, { workorder_id: woid, event_type: 'DELIVERY_BOOKED', user_id: actorId });
      } else {
        await logEvent(client, { workorder_id: woid, event_type: 'DELIVERY_CREATED', user_id: actorId });
      }

      await client.query('COMMIT');

      return res.status(201).json({ message: 'Delivery created', delivery_id: r.rows[0].delivery_id });
    }

    if (method === 'PUT') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing delivery_id' });

      const {
        invoice_id,
        customer_id,
        delivery_suburb,
        delivery_state,
        delivery_charged,
        delivery_quoted,
        removalist_id,
        delivery_date,
        delivery_status,
        notes,
        workorder_id,
        user_id, // optional from body
      } = body || {};

      const actorId = twoCharId(req.headers['x-user-id'] || user_id);

      await client.query('BEGIN');

      // Load current record to validate + get workorder_id for logging
      const cur = await client.query(
        `SELECT delivery_id, workorder_id, delivery_status, removalist_id AS cur_removalist_id, delivery_date AS cur_delivery_date
         FROM delivery WHERE delivery_id = $1`,
        [id]
      );
      if (!cur.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Delivery not found' });
      }
      const prevStatus = cur.rows[0].delivery_status;
      const woid = workorder_id == null ? cur.rows[0].workorder_id : Number(workorder_id);

      // Compute "next" values (merged view) for validation
      const nextRemovalistId =
        removalist_id === undefined ? cur.rows[0].cur_removalist_id : (removalist_id === '' || removalist_id == null ? null : Number(removalist_id));
      const nextDeliveryDate =
        delivery_date === undefined ? cur.rows[0].cur_delivery_date : (delivery_date || null);

      // Validate attempting to move into "Booked for Delivery"
      const willBeBooked =
        delivery_status === 'Booked for Delivery' ||
        (delivery_status === undefined && prevStatus === 'Booked for Delivery'); // (covers no change case harmlessly)

      if (delivery_status === 'Booked for Delivery' && (!nextRemovalistId || !nextDeliveryDate)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: "Cannot set status to 'Booked for Delivery' without Delivery Date and Carrier",
        });
      }

      const sets = [];
      const vals = [];
      let i = 1;

      if (invoice_id !== undefined)       { sets.push(`invoice_id = $${i++}`);       vals.push(invoice_id); }
      if (customer_id !== undefined)      { sets.push(`customer_id = $${i++}`);      vals.push(Number(customer_id)); }
      if (delivery_suburb !== undefined)  { sets.push(`delivery_suburb = $${i++}`);  vals.push(delivery_suburb || null); }
      if (delivery_state !== undefined)   { sets.push(`delivery_state = $${i++}`);   vals.push(delivery_state); }
      if (delivery_charged !== undefined) { sets.push(`delivery_charged = $${i++}`); vals.push(delivery_charged === '' || delivery_charged == null ? null : Number(delivery_charged)); }
      if (delivery_quoted !== undefined)  { sets.push(`delivery_quoted = $${i++}`);  vals.push(delivery_quoted === '' || delivery_quoted == null ? null : Number(delivery_quoted)); }
      if (removalist_id !== undefined)    { sets.push(`removalist_id = $${i++}`);    vals.push(removalist_id === '' || removalist_id == null ? null : Number(removalist_id)); }
      if (delivery_date !== undefined)    { sets.push(`delivery_date = $${i++}`);    vals.push(delivery_date || null); }
      if (delivery_status !== undefined)  { sets.push(`delivery_status = $${i++}`);  vals.push(delivery_status); }
      if (notes !== undefined)            { sets.push(`notes = $${i++}`);            vals.push(notes || null); }
      if (workorder_id !== undefined)     { sets.push(`workorder_id = $${i++}`);     vals.push(workorder_id === '' || workorder_id == null ? null : Number(workorder_id)); }

      if (!sets.length) {
        await client.query('ROLLBACK');
        return res.status(200).json({ message: 'No changes' });
      }

      vals.push(id);
      await client.query(
        `UPDATE delivery SET ${sets.join(', ')} WHERE delivery_id = $${i}`,
        vals
      );

      // ===== selective logging =====
      if (delivery_status !== undefined && delivery_status !== prevStatus) {
        if (delivery_status === 'Booked for Delivery') {
          await logEvent(client, { workorder_id: woid, event_type: 'DELIVERY_BOOKED', user_id: actorId });
        }
        if (delivery_status === 'Delivery Completed') {
          await logEvent(client, { workorder_id: woid, event_type: 'ORDER_DISPATCHED', user_id: actorId });
        }
      }

      await client.query('COMMIT');
      return res.status(200).json({ message: 'Delivery updated' });
    }

    if (method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing delivery_id' });
      await client.query(`DELETE FROM delivery WHERE delivery_id = $1`, [id]);
      return res.status(204).end();
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    return res.status(405).end(`Method ${method} Not Allowed`);
  } catch (err) {
    console.error('Delivery API error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}