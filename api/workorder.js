// api/workorder.js
import { getClientWithTimezone } from '../lib/db.js';

// Helpers
function parseWeeks(label) {
  const m = String(label || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Always clamp to 2 chars to satisfy varchar(2)
function twoCharId(x) {
  const s = (x == null ? '' : String(x)).trim().toUpperCase();
  return (s || 'NA').slice(0, 2);
}

async function logEvent(client, { workorder_id, workorder_items_id = null, event_type, user_id = 'NA' }) {
  await client.query(
    `INSERT INTO workorder_logs (workorder_id, workorder_items_id, event_type, user_id)
     VALUES ($1,$2,$3,$4)`,
    [workorder_id, workorder_items_id, event_type, twoCharId(user_id)]
  );
}

export default async function handler(req, res) {
  const { method, query: { id }, body } = req;
  const client = await getClientWithTimezone();

  try {
    if (method === 'GET') {
      if (id) {
        // Workorder + items + activity log
        const wo = await client.query(
          `
          WITH base AS (
            SELECT 
              wo.*,
              c.name  AS customer_name,
              c.email AS customer_email,
              c.phone AS customer_phone
            FROM workorder wo
            JOIN customers c ON c.id = wo.customer_id
            WHERE wo.workorder_id = $1
          )
          SELECT * FROM base
          `,
          [id]
        );
        if (!wo.rows.length) return res.status(404).json({ error: 'Workorder not found' });

        const items = await client.query(
          `
          SELECT 
            wi.workorder_items_id, wi.workorder_id, wi.product_id,
            COALESCE(p.name, wi.product_id) AS product_name,
            wi.quantity, wi.condition, wi.technician_id, wi.status, wi.in_workshop,
            wi.wokrshop_duration
          FROM workorder_items wi
          LEFT JOIN product p ON p.sku = wi.product_id
          WHERE wi.workorder_id = $1
          ORDER BY wi.workorder_items_id ASC
          `,
          [id]
        );

        const logs = await client.query(
          `
          SELECT 
            l.id,
            to_char(l.created_at AT TIME ZONE 'Australia/Melbourne','DD-Mon-YYYY HH24:MI:SS') AS ts,
            l.event_type,
            l.user_id,
            l.workorder_items_id,
            COALESCE(p.name, wi.product_id) AS product_name,
            wi.status AS current_item_status
          FROM workorder_logs l
          LEFT JOIN workorder_items wi ON wi.workorder_items_id = l.workorder_items_id
          LEFT JOIN product p ON p.sku = wi.product_id
          WHERE l.workorder_id = $1
          ORDER BY l.created_at ASC, l.id ASC
          `,
          [id]
        );

        const woRow = wo.rows[0];
        return res.status(200).json({
          ...woRow,
          items: items.rows,
          activity: logs.rows
        });
      }

      // === List workorders (RESPECT ?status=...) ===
      const { status: statusFilter } = req.query;

      const baseSql = `
        SELECT
          wo.workorder_id,
          wo.invoice_id,
          wo.date_created,
          wo.status,
          wo.outstanding_balance,
          wo.delivery_suburb,
          wo.delivery_state,
          wo.salesperson,
          wo.estimated_completion,
          wo.notes,
          c.name AS customer_name,
          COALESCE(
            json_agg(
              json_build_object(
                'product_id',   wi.product_id,
                'product_name', COALESCE(p.name, wi.product_id),
                'quantity',     wi.quantity
              )
            ) FILTER (WHERE wi.workorder_items_id IS NOT NULL),
            '[]'::json
          ) AS items,
          COALESCE(
            string_agg(
              (wi.quantity::text || ' × ' || COALESCE(p.name, wi.product_id))::text,
              ', ' ORDER BY wi.workorder_items_id
            ) FILTER (WHERE wi.workorder_items_id IS NOT NULL),
            '—'
          ) AS items_text
        FROM workorder wo
        JOIN customers c ON wo.customer_id = c.id
        LEFT JOIN workorder_items wi ON wi.workorder_id = wo.workorder_id
        LEFT JOIN product p ON p.sku = wi.product_id
      `;

      const whereSql = statusFilter ? `WHERE wo.status = $1` : ``;

      const list = await client.query(
        `
          ${baseSql}
          ${whereSql}
          GROUP BY wo.workorder_id, c.name
          ORDER BY wo.date_created DESC
        `,
        statusFilter ? [statusFilter] : []
      );

      return res.status(200).json(list.rows);
    }

    if (method === 'POST') {
      const {
        invoice_id,
        customer_id,
        salesperson,
        delivery_suburb,
        delivery_state,
        delivery_charged,
        lead_time,
        estimated_completion,
        notes,
        status,
        outstanding_balance,
        items
      } = body || {};

      if (!invoice_id || !customer_id || !salesperson || !delivery_state || !lead_time || outstanding_balance == null) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const actorId = twoCharId(req.headers['x-user-id'] || salesperson);

      await client.query('BEGIN');

      let estComplete = estimated_completion;
      if (!estComplete) {
        const weeks = parseWeeks(lead_time);
        if (weeks > 0) {
          const r = await client.query(
            `SELECT (NOW()::date + ($1 * 7) * INTERVAL '1 day')::date AS d`,
            [weeks]
          );
          estComplete = r.rows[0].d;
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
          estComplete,
          notes || null,
          status || 'Work Ordered',
          Number(outstanding_balance)
        ]
      );
      const workorderId = woRes.rows[0].workorder_id;

      if (Array.isArray(items) && items.length) {
        for (const item of items) {
          const itmStatus = item.status && String(item.status).trim()
            ? item.status
            : 'Not in Workshop';
          await client.query(
            `
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status
            ) VALUES ($1,$2,$3,$4,$5,$6)
            `,
            [
              workorderId,
              item.product_id,
              Number(item.quantity),
              item.condition,
              item.technician_id,
              itmStatus
            ]
          );
        }
      }

      await logEvent(client, {
        workorder_id: workorderId,
        event_type: 'WORKORDER_CREATED',
        user_id: actorId
      });

      await client.query('COMMIT');
      return res.status(201).json({ message: 'Workorder created', workorder_id: workorderId });
    }

    if (method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });
      const actorId = twoCharId(req.headers['x-user-id'] || body?.user_id || '');

      const {
        notes,
        delivery_charged,
        outstanding_balance,
        estimated_completion,
        items // [{ workorder_items_id, status, technician_id }]
      } = body || {};

      await client.query('BEGIN');

      // Load WO for comparisons
      const currentWO = await client.query(
        `SELECT * FROM workorder WHERE workorder_id = $1`,
        [id]
      );
      if (!currentWO.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Workorder not found' });
      }
      const beforeWO = currentWO.rows[0];

      // 1) Update WO-level fields
      const updates = [];
      const params = [];
      let p = 1;

      if (notes !== undefined) { updates.push(`notes = $${p++}`); params.push(notes || null); }
      if (delivery_charged !== undefined) { updates.push(`delivery_charged = $${p++}`); params.push(delivery_charged === null || delivery_charged === '' ? null : Number(delivery_charged)); }
      if (outstanding_balance !== undefined) { updates.push(`outstanding_balance = $${p++}`); params.push(Number(outstanding_balance)); }
      if (estimated_completion !== undefined) { updates.push(`estimated_completion = $${p++}`); params.push(estimated_completion || beforeWO.estimated_completion); }

      if (updates.length) {
        params.push(id);
        await client.query(`UPDATE workorder SET ${updates.join(', ')} WHERE workorder_id = $${p}`, params);

        if (notes !== undefined && (notes || '') !== (beforeWO.notes || '')) {
          await logEvent(client, { workorder_id: id, event_type: 'NOTE_ADDED', user_id: actorId });
        }
        if (outstanding_balance !== undefined && Number(outstanding_balance) !== Number(beforeWO.outstanding_balance)) {
          await logEvent(client, { workorder_id: id, event_type: 'PAYMENT_UPDATED', user_id: actorId });
        }
      }

      // 2) Update items (status / tech)
      if (Array.isArray(items) && items.length) {
        for (const row of items) {
          const { workorder_items_id, status, technician_id } = row || {};
          if (!workorder_items_id) continue;

          const cur = await client.query(
            `SELECT workorder_items_id, status, technician_id, in_workshop, wokrshop_duration
               FROM workorder_items WHERE workorder_items_id = $1 AND workorder_id = $2`,
            [workorder_items_id, id]
          );
          if (!cur.rows.length) continue;

          const before = cur.rows[0];
          const fields = [];
          const vals = [];
          let i = 1;

          if (technician_id !== undefined && technician_id !== before.technician_id) {
            fields.push(`technician_id = $${i++}`); vals.push(technician_id);
          }

          if (status !== undefined && status !== before.status) {
            if (status === 'In Workshop') {
              fields.push(`status = $${i++}`, `in_workshop = COALESCE(in_workshop, NOW())`);
              vals.push(status);
              await logEvent(client, { workorder_id: id, workorder_items_id, event_type: 'ITEM_STATUS_CHANGED', user_id: actorId });
            } else if (status === 'Completed') {
              let set = `status = $${i++}`;
              vals.push(status);
              set += `, wokrshop_duration = CASE WHEN in_workshop IS NOT NULL 
                         THEN ROUND(EXTRACT(EPOCH FROM (NOW() - in_workshop)) / 3600.0::numeric, 2)
                         ELSE wokrshop_duration END`;
              fields.push(set);
              await logEvent(client, { workorder_id: id, workorder_items_id, event_type: 'ITEM_STATUS_CHANGED', user_id: actorId });
            } else if (status === 'Not in Workshop') {
              fields.push(`status = $${i++}`, `in_workshop = NULL`);
              vals.push(status);
              await logEvent(client, { workorder_id: id, workorder_items_id, event_type: 'ITEM_STATUS_CHANGED', user_id: actorId });
            } else {
              fields.push(`status = $${i++}`);
              vals.push(status);
              await logEvent(client, { workorder_id: id, workorder_items_id, event_type: 'ITEM_STATUS_CHANGED', user_id: actorId });
            }
          }

          if (fields.length) {
            vals.push(workorder_items_id);
            await client.query(
              `UPDATE workorder_items SET ${fields.join(', ')} WHERE workorder_items_id = $${i}`,
              vals
            );
          }
        }
      }

      // 3) Auto-complete workorder & auto-create delivery if all items completed
      const allItems = await client.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'Completed') AS done,
                COUNT(*) AS total
         FROM workorder_items WHERE workorder_id = $1`,
        [id]
      );
      const done = Number(allItems.rows[0].done);
      const total = Number(allItems.rows[0].total);

      if (total > 0 && done === total) {
        const curStatus = await client.query(
          `SELECT status FROM workorder WHERE workorder_id = $1`,
          [id]
        );

        const notAlreadyCompleted = curStatus.rows.length && curStatus.rows[0].status !== 'Completed';

        if (notAlreadyCompleted) {
          await client.query(
            `UPDATE workorder SET status = 'Completed' WHERE workorder_id = $1`,
            [id]
          );
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_STATUS_CHANGED', user_id: actorId });
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_COMPLETED', user_id: actorId });
        }

        // Ensure a single delivery per WO: create if none exists
        const exists = await client.query(
          `SELECT delivery_id FROM delivery WHERE workorder_id = $1 LIMIT 1`,
          [id]
        );
        if (!exists.rows.length) {
          const d = beforeWO; // previously loaded
          const noteSuffix = `Auto-created from Workorder #${id} on NOW()`;
          await client.query(
            `
            INSERT INTO delivery (
              invoice_id, customer_id, delivery_suburb, delivery_state,
              delivery_charged, delivery_quoted, removalist_id, delivery_date,
              delivery_status, notes, workorder_id, date_created
            ) VALUES (
              $1,$2,$3,$4,$5,NULL,NULL,NULL,'To Be Booked',$6,$7,NOW()
            )
            `,
            [
              d.invoice_id,
              d.customer_id,
              d.delivery_suburb || null,
              d.delivery_state,
              d.delivery_charged == null ? null : Number(d.delivery_charged),
              (d.notes ? `${d.notes}\n\n` : '') + noteSuffix,
              Number(id),
            ]
          );

          await logEvent(client, {
            workorder_id: id,
            event_type: 'DELIVERY_ORDER_CREATED',
            user_id: actorId
          });
        }
      }

      await client.query('COMMIT');

      // Return updated resource
      req.query.id = id;
      return await handler({ ...req, method: 'GET' }, res);
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
