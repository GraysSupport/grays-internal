import { getClientWithTimezone } from '../lib/db.js';

/** Helpers **/
function parseWeeks(label) {
  const m = String(label || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Clamp to 2 chars to satisfy varchar(2)
function twoCharId(x) {
  const s = (x == null ? '' : String(x)).trim().toUpperCase();
  return (s || 'NA').slice(0, 2);
}

/** Centralized logger **/
async function logEvent(client, {
  workorder_id,
  workorder_items_id = null,
  event_type,
  user_id = 'NA',
  item_status = null,
}) {
  await client.query(
    `INSERT INTO workorder_logs
       (workorder_id, workorder_items_id, event_type, user_id, item_status)
     VALUES ($1,$2,$3,$4,$5)`,
    [workorder_id, workorder_items_id, event_type, twoCharId(user_id), item_status]
  );
}

/** =========================
 * INVENTORY HELPERS
 * ========================== */

/** Atomic stock adjust with row lock and no-negative guard */
async function adjustProductStock(client, sku, delta) {
  const r = await client.query(
    `SELECT stock FROM product WHERE sku = $1 FOR UPDATE`,
    [sku]
  );
  if (!r.rowCount) throw new Error(`Product not found: ${sku}`);

  const current = Number(r.rows[0].stock ?? 0);
  const next = current + Number(delta);

  if (Number.isNaN(next)) throw new Error(`Invalid stock math for ${sku}`);
  if (delta < 0 && next < 0) {
    throw new Error(`Insufficient stock for ${sku}. Have ${current}, need ${-delta}.`);
  }

  await client.query(`UPDATE product SET stock = $1 WHERE sku = $2`, [next, sku]);
  return { before: current, after: next };
}

export default async function handler(req, res) {
  const { method, query: { id }, body } = req;
  const client = await getClientWithTimezone();

  try {
    if (method === 'GET') {
      const { id } = req.query;

      // === Get technicians list (dropdown) ===
      if (req.query.technicians) {
        const techsRes = await client.query(
          `SELECT id, name FROM users WHERE access = 'technician' ORDER BY name`
        );
        return res.status(200).json(techsRes.rows);
      }

      // === Get single workorder ===
      if (id) {
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
            wi.quantity, wi.condition, wi.technician_id, wi.status,
            wi.workshop_duration,            -- NEW
            wi.item_sn                       -- NEW
          FROM workorder_items wi
          LEFT JOIN product p ON p.sku = wi.product_id
          WHERE wi.workorder_id = $1
            AND wi.status <> 'Canceled'
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
            l.item_status AS current_item_status
          FROM workorder_logs l
          LEFT JOIN workorder_items wi ON wi.workorder_items_id = l.workorder_items_id
          LEFT JOIN product p ON p.sku = wi.product_id
          WHERE l.workorder_id = $1
          ORDER BY l.created_at DESC, l.id DESC
          `,
          [id]
        );

        return res.status(200).json({
          ...wo.rows[0],
          items: items.rows,
          activity: logs.rows
        });
      }

      // === List workorders with filters ===
      const { status, state, salesperson, payment, technician } = req.query;

      const statusFilter = status ? decodeURIComponent(status) : undefined;
      const validStatuses = ['Work Ordered', 'Completed', 'Not in Workshop', 'In Workshop'];
      if (statusFilter && !validStatuses.includes(statusFilter)) {
        return res.status(400).json({ error: 'Invalid workorder status' });
      }

      // For item aggregates:
      const itemStatusPredicate =
        statusFilter === 'Completed'
          ? `wi.status = 'Completed'`
          : `wi.status <> 'Completed'`;

      let conditions = [];
      let params = [];
      let i = 1;

      if (statusFilter) { conditions.push(`wo.status = $${i++}`); params.push(statusFilter); }
      if (state) { conditions.push(`wo.delivery_state = $${i++}`); params.push(state); }
      if (salesperson) { conditions.push(`wo.salesperson = $${i++}`); params.push(salesperson); }
      if (payment) { 
        if (payment.toLowerCase() === 'paid') conditions.push(`wo.outstanding_balance = 0`);
        else if (payment.toLowerCase() === 'due') conditions.push(`wo.outstanding_balance > 0`);
      }
      if (technician) { conditions.push(`wi.technician_id = $${i++}`); params.push(technician); }

      const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

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
          wo.important_flag,
          c.name AS customer_name,

          COALESCE(
            json_agg(
              json_build_object(
                'product_id',       wi.product_id,
                'product_name',     COALESCE(p.name, wi.product_id),
                'quantity',         wi.quantity,
                'condition',        wi.condition,   
                'technician_id',    wi.technician_id,
                'technician_name',  u.name,
                'status',           wi.status
              )
            ) FILTER (WHERE wi.workorder_items_id IS NOT NULL AND ${itemStatusPredicate}),
            '[]'::json
          ) AS items,

          COALESCE(
            string_agg(
              (
                wi.quantity::text || ' × ' || COALESCE(p.name, wi.product_id) ||
                ' (' || wi.condition::text || ')'     
              )::text,
              ', ' ORDER BY wi.workorder_items_id
            ) FILTER (WHERE wi.workorder_items_id IS NOT NULL AND ${itemStatusPredicate}),
            '—'
          ) AS items_text,

          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id',   wi.technician_id,
              'name', u.name
            )) FILTER (WHERE wi.technician_id IS NOT NULL AND ${itemStatusPredicate}),
            '[]'::json
          ) AS technicians

        FROM workorder wo
        JOIN customers c ON wo.customer_id = c.id
        LEFT JOIN workorder_items wi
          ON wi.workorder_id = wo.workorder_id
         AND wi.status <> 'Canceled'
        LEFT JOIN product p ON p.sku = wi.product_id
        LEFT JOIN users u ON u.id = wi.technician_id AND u.access = 'technician'
      `;

      const list = await client.query(
        `
          ${baseSql}
          ${whereSql}
          GROUP BY wo.workorder_id, c.name
          ORDER BY wo.date_created DESC
        `,
        params
      );

      return res.status(200).json(list.rows);
    }


    /** =========================
     * POST  (Create workorder)
     * ========================== */
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
        items,
        important_flag
      } = body || {};

      if (!invoice_id || !customer_id || !salesperson || !delivery_state || !lead_time || outstanding_balance == null) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const actorId = twoCharId(req.headers['x-user-id'] || salesperson);

      await client.query('BEGIN');

      // Auto-calc estimated completion from lead_time if needed
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
          delivery_charged, lead_time, estimated_completion, notes, status, date_created, outstanding_balance, important_flag
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,$12)
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
          Number(outstanding_balance),
          important_flag == null ? false : !!important_flag
        ]
      );
      const workorderId = woRes.rows[0].workorder_id;

      if (Array.isArray(items) && items.length) {
        for (const item of items) {
          // Enforce technician is required when adding items at create-time
          if (!item?.technician_id || String(item.technician_id).trim() === '') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Technician is required for each item.' });
          }

          const itmStatus = item.status && String(item.status).trim()
            ? item.status
            : 'Not in Workshop';

          const qty = Number(item.quantity);

          // INVENTORY: debit stock before inserting item
          await adjustProductStock(client, item.product_id, -qty);

          await client.query(
            `
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status,
              workshop_duration, item_sn                             -- NEW
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `,
            [
              workorderId,
              item.product_id,
              qty,
              item.condition,
              twoCharId(item.technician_id),
              itmStatus,
              item.workshop_duration == null || item.workshop_duration === '' ? null : Number(item.workshop_duration),
              item.item_sn ?? null
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

    /** =========================
     * PUT  (Update workorder + items/add/remove)
     * ========================== */
    if (method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });
      const actorId = twoCharId(req.headers['x-user-id'] || body?.user_id || '');

      const {
        notes,
        delivery_charged,
        outstanding_balance,
        estimated_completion,
        important_flag,                 // NEW
        items,                          // [{ workorder_items_id, status, technician_id, workshop_duration?, item_sn? }]
        add_items,                      // NEW [{ product_id, quantity, condition, technician_id, status?, workshop_duration?, item_sn? }]
        delete_item_ids,                // NEW [id, id, ...]
        status                          // NEW: optional top-level workorder status override
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

      // Capture completion counts BEFORE updates
      const countsBefore = await client.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'Completed') AS done,
                COUNT(*) AS total
         FROM workorder_items
         WHERE workorder_id = $1
           AND status <> 'Canceled'`,
        [id]
      );
      const doneBefore = Number(countsBefore.rows[0].done);
      const totalBefore = Number(countsBefore.rows[0].total);
      const allCompletedBefore = totalBefore > 0 && doneBefore === totalBefore;

      // Validate WO-level status if provided
      const explicitStatusProvided = typeof status !== 'undefined';
      const validWOStatuses = ['Work Ordered', 'Completed'];
      if (explicitStatusProvided && !validWOStatuses.includes(String(status))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid workorder status' });
      }

      // 1) Update WO-level fields (excluding top-level status here; applied later if it truly changes)
      const updates = [];
      const params = [];
      let p = 1;

      if (notes !== undefined) { updates.push(`notes = $${p++}`); params.push(notes || null); }
      if (delivery_charged !== undefined) { updates.push(`delivery_charged = $${p++}`); params.push(delivery_charged === null || delivery_charged === '' ? null : Number(delivery_charged)); }
      if (outstanding_balance !== undefined) { updates.push(`outstanding_balance = $${p++}`); params.push(Number(outstanding_balance)); }
      if (estimated_completion !== undefined) { updates.push(`estimated_completion = $${p++}`); params.push(estimated_completion || beforeWO.estimated_completion); }
      if (important_flag !== undefined) { updates.push(`important_flag = $${p++}`); params.push(!!important_flag); }

      if (updates.length) {
        params.push(id);
        await client.query(`UPDATE workorder SET ${updates.join(', ')} WHERE workorder_id = $${p}`, params);

        if (notes !== undefined && (notes || '') !== (beforeWO.notes || '')) {
          await logEvent(client, { workorder_id: id, event_type: 'NOTE_ADDED', user_id: actorId });
        }
        if (outstanding_balance !== undefined && Number(outstanding_balance) !== Number(beforeWO.outstanding_balance)) {
          await logEvent(client, { workorder_id: id, event_type: 'PAYMENT_UPDATED', user_id: actorId });
        }
        if (important_flag !== undefined && beforeWO.important_flag !== !!important_flag) {
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_FLAG_CHANGED', user_id: actorId });
        }
      }

      // 2) Update existing items (status / technician / workshop_duration / item_sn)
      if (Array.isArray(items) && items.length) {
        for (const row of items) {
          const { workorder_items_id, status, technician_id, workshop_duration, item_sn } = row || {};
          if (!workorder_items_id) continue;

          const cur = await client.query(
            `SELECT workorder_items_id, status, technician_id, in_workshop, product_id, quantity,
                    workshop_duration, item_sn
               FROM workorder_items WHERE workorder_items_id = $1 AND workorder_id = $2`,
            [workorder_items_id, id]
          );
          if (!cur.rows.length) continue;

          const before = cur.rows[0];
          const fields = [];
          const vals = [];
          let i = 1;

          if (technician_id !== undefined) {
            const tech = (technician_id === '' || technician_id == null)
              ? null
              : twoCharId(technician_id);

            // Disallow clearing technician (DB column is NOT NULL)
            if (tech === null) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'Technician cannot be cleared from an existing item.' });
            }

            const beforeTech = before.technician_id ?? null;
            if (tech !== beforeTech) {
              fields.push(`technician_id = $${i++}`);
              vals.push(tech);
            }
          }

          if (status !== undefined && status !== before.status) {
            // INVENTORY: status transition side-effects
            if (status === 'Canceled' && before.status !== 'Canceled') {
              const delta = Number(before.quantity);
              await adjustProductStock(client, before.product_id, +delta);
            } else if (status !== 'Canceled' && before.status === 'Canceled') {
              const delta = -Number(before.quantity);
              await adjustProductStock(client, before.product_id, delta);
            }

            if (status === 'In Workshop') {
              fields.push(`status = $${i++}`, `in_workshop = COALESCE(in_workshop, NOW())`);
              vals.push(status);
            } else if (status === 'Completed') {
              fields.push(`status = $${i++}`);
              vals.push(status);
            } else if (status === 'Not in Workshop') {
              fields.push(`status = $${i++}`, `in_workshop = NULL`);
              vals.push(status);
            } else if (status === 'Canceled') {
              fields.push(`status = $${i++}`);
              vals.push(status);
            } else {
              fields.push(`status = $${i++}`);
              vals.push(status);
            }

            await logEvent(client, {
              workorder_id: id,
              workorder_items_id,
              event_type: 'ITEM_STATUS_CHANGED',
              user_id: actorId,
              item_status: status
            });
          }

          // NEW: workshop_duration
          if (row.hasOwnProperty('workshop_duration')) {
            const dur =
              workshop_duration === '' || workshop_duration == null
                ? null
                : Number(workshop_duration);
            const beforeDur =
              before.workshop_duration == null ? null : Number(before.workshop_duration);
            if (dur !== beforeDur) {
              fields.push(`workshop_duration = $${i++}`);
              vals.push(dur);
            }
          }

          // NEW: item_sn (serial number) – free text; allow null/empty to clear
          if (row.hasOwnProperty('item_sn')) {
            const sn = (item_sn == null || String(item_sn).trim() === '') ? null : String(item_sn).trim();
            const beforeSn = before.item_sn == null ? null : String(before.item_sn);
            if (sn !== beforeSn) {
              fields.push(`item_sn = $${i++}`);
              vals.push(sn);
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

      // 2b) Add new items (support duration + serial)
      if (Array.isArray(add_items) && add_items.length) {
        for (const item of add_items) {
          if (!item?.product_id || !item?.quantity || !item?.condition) continue;
          // Enforce technician is required when adding items later
          if (!item?.technician_id || String(item.technician_id).trim() === '') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Technician is required for each new item.' });
          }

          const itmStatus = item.status && String(item.status).trim()
            ? item.status
            : 'Not in Workshop';

          const qty = Number(item.quantity);

          // INVENTORY: debit stock before insert
          await adjustProductStock(client, item.product_id, -qty);

          const ins = await client.query(
            `
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status,
              workshop_duration, item_sn
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING workorder_items_id
            `,
            [
              id,
              item.product_id,
              qty,
              item.condition,
              twoCharId(item.technician_id),
              itmStatus,
              item.workshop_duration == null || item.workshop_duration === '' ? null : Number(item.workshop_duration),
              item.item_sn ?? null
            ]
          );

          const newItemId = ins.rows[0].workorder_items_id;

          await logEvent(client, {
            workorder_id: id,
            workorder_items_id: newItemId,
            event_type: 'ITEM_ADDED',
            user_id: actorId,
            item_status: itmStatus
          });
        }
      }

      // 2c) Delete items -> mark as Canceled (and restock if they weren't already canceled)
      if (Array.isArray(delete_item_ids) && delete_item_ids.length) {
        const { rows: existing } = await client.query(
          `SELECT workorder_items_id, product_id, quantity, status
             FROM workorder_items
            WHERE workorder_id = $1
              AND workorder_items_id = ANY($2::int[])`,
          [id, delete_item_ids]
        );

        for (const row of existing) {
          await logEvent(client, {
            workorder_id: id,
            workorder_items_id: row.workorder_items_id,
            event_type: 'ITEM_REMOVED',
            user_id: actorId
          });

          if (row.status !== 'Canceled') {
            const delta = Number(row.quantity);
            // INVENTORY: credit stock
            await adjustProductStock(client, row.product_id, +delta);
          }
        }

        await client.query(
          `UPDATE workorder_items
             SET status = 'Canceled'
           WHERE workorder_id = $1
             AND workorder_items_id = ANY($2::int[])`,
          [id, delete_item_ids]
        );
      }

      // Capture completion counts AFTER updates
      const countsAfter = await client.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'Completed') AS done,
                COUNT(*) AS total
         FROM workorder_items
         WHERE workorder_id = $1
           AND status <> 'Canceled'`,
        [id]
      );
      const doneAfter = Number(countsAfter.rows[0].done);
      const totalAfter = Number(countsAfter.rows[0].total);
      const allCompletedAfter = totalAfter > 0 && doneAfter === totalAfter;

      // Determine if this request CAUSED a transition to "all completed"
      const transitionedToCompletedViaItems = !allCompletedBefore && allCompletedAfter;

      // 3) Auto-complete workorder on transition; do not create delivery for edits that don't cause transition
      if (allCompletedAfter) {
        const curStatus = await client.query(
          `SELECT status FROM workorder WHERE workorder_id = $1`,
          [id]
        );
        const isCompletedNow = curStatus.rows.length && curStatus.rows[0].status === 'Completed';

        // If not already completed, set to Completed now
        if (!isCompletedNow) {
          await client.query(
            `UPDATE workorder SET status = 'Completed' WHERE workorder_id = $1`,
            [id]
          );
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_STATUS_CHANGED', user_id: actorId });
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_COMPLETED', user_id: actorId });
        }

        // Create delivery ONLY if transitioned this request or explicit override
        const explicitCompletedNow = (explicitStatusProvided && beforeWO.status !== 'Completed' && status === 'Completed');
        if (transitionedToCompletedViaItems || explicitCompletedNow) {
          const d = beforeWO;
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
              (d.notes ? `${d.notes}\n\n` : ''),
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

      // 4) Apply explicit WO status only if it represents a change from the DB value at request start
      if (explicitStatusProvided && status !== beforeWO.status) {
        await client.query(
          `UPDATE workorder SET status = $1 WHERE workorder_id = $2`,
          [status, id]
        );
        await logEvent(client, {
          workorder_id: id,
          event_type: 'WORKORDER_STATUS_CHANGED',
          user_id: actorId
        });
      }

      await client.query('COMMIT');

      // Return updated resource
      req.query.id = id;
      return await handler({ ...req, method: 'GET' }, res);
    }

    /** =========================
     * DELETE
     * ========================== */
    if (method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });
      await client.query('BEGIN');

      // INVENTORY: restock non-canceled items before deletion
      const { rows: toRestock } = await client.query(
        `SELECT product_id, quantity
           FROM workorder_items
          WHERE workorder_id = $1
            AND status <> 'Canceled'`,
        [id]
      );
      for (const row of toRestock) {
        const delta = Number(row.quantity);
        await adjustProductStock(client, row.product_id, +delta);
      }

      await client.query(`DELETE FROM workorder_items WHERE workorder_id = $1`, [id]);
      await client.query(`DELETE FROM workorder WHERE workorder_id = $1`, [id]);
      await client.query('COMMIT');
      return res.status(204).end();
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    return res.status(405).end(`Method ${method} Not Allowed`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
      const msg = String(err?.message || '');
      // Surface specific inventory errors so the UI can toast them
      if (/insufficient\s+stock/i.test(msg)) {
        // 409 Conflict fits stock contention/availability problems
        return res.status(409).json({ error: msg });
      }
      if (/product not found/i.test(msg)) {
        return res.status(404).json({ error: msg });
      }
      if (/invalid stock math/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      // Fallback
      console.error('Workorder API error:', err);
      return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
