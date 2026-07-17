import { getClientWithTimezone } from '../db.js';
// F8b: the delivery-booked text is CONFIRMED BY A HUMAN (Nick, 17 Jul 2026) — booking
// returns a preview, and the SMS only goes when logistics explicitly confirms it via
// POST /api/delivery?resource=booking-sms. Nothing here sends automatically.
import {
  previewDeliveryBookedSms,
  notifyDeliveryBooked,
  declineDeliveryBookedSms,
} from '../deliveryNotify.js';
import { getAuthUser } from '../rbac.js';

const CUSTOMER_COLLECT_ID = 15;

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
    // ---- F8b: the delivery-booked text confirmation -------------------------------
    // POST /api/delivery?resource=booking-sms&id=<delivery_id>  { action: 'send'|'skip' }
    // Dispatched BEFORE the create path so `resource` can't fall through to it.
    //
    // Unlike the rest of this handler (legacy, ungated, identifies the actor from a body
    // field), this one REQUIRES a valid login token: it texts a customer, so the actor
    // must be real and attributable. Safe to gate because its only caller is new UI that
    // sends the token. Not role-gated beyond authentication — the `logistics` role isn't
    // assigned to anyone yet, and gating on it would lock out the admins who book
    // deliveries today. Tighten once roles are rolled out (F9).
    if ((req.query?.resource || '') === 'booking-sms') {
      if (method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method not allowed for booking-sms' });
      }
      const auth = getAuthUser(req);
      if (!auth) return res.status(401).json({ error: 'Not authenticated' });
      if (!id) return res.status(400).json({ error: 'Missing delivery_id' });

      const action = String(body?.action || '');
      if (action !== 'send' && action !== 'skip') {
        return res.status(400).json({ error: "action must be 'send' or 'skip'" });
      }

      if (action === 'skip') {
        const outcome = await declineDeliveryBookedSms(client, id, { actorId: auth.id });
        return res.status(200).json({ message: 'No text sent', outcome });
      }

      const outcome = await notifyDeliveryBooked(client, id, { actorId: auth.id });
      if (outcome.alreadySent) {
        return res.status(409).json({ error: 'That text has already been sent', outcome });
      }
      if (outcome.failed) {
        return res.status(502).json({ error: 'Podium would not accept the text — nothing was sent', outcome });
      }
      if (!outcome.notified) {
        return res.status(409).json({ error: 'The text could not be sent (delivery not booked, or no phone)', outcome });
      }
      return res.status(200).json({ message: 'Text sent', outcome });
    }

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
                  (
                    wi.quantity::text || ' × ' ||
                    COALESCE(wi.custom_description, p.name, wi.product_id) ||
                    CASE
                      WHEN wi.condition IS NOT NULL THEN
                        ' (' || wi.condition::text || ')'
                      ELSE ''
                    END
                  )::text,
                  ', ' ORDER BY wi.workorder_items_id
                ) FILTER (WHERE wi.workorder_items_id IS NOT NULL AND wi.status <> 'Canceled'),
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
            d.delivery_type,
            d.free_delivery,
            d.cash_to_removalist,
            d.installation_cost,
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
                (
                  wi.quantity::text || ' × ' ||
                  COALESCE(wi.custom_description, p.name, wi.product_id) ||
                  CASE
                    WHEN wi.condition IS NOT NULL THEN
                      ' (' || wi.condition::text || ')'
                    ELSE ''
                  END
                )::text,
                ', ' ORDER BY wi.workorder_items_id
              ) FILTER (WHERE wi.workorder_items_id IS NOT NULL AND wi.status <> 'Canceled'),
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
          d.delivery_type,
          d.free_delivery,
          d.cash_to_removalist,
          d.installation_cost,
          c.name AS customer_name,
          r.name AS removalist_name,
          w.outstanding_balance,
          i.items_text
        FROM delivery d
        JOIN customers c ON c.id = d.customer_id
        LEFT JOIN removalist r ON r.id = d.removalist_id
        LEFT JOIN workorder   w ON w.workorder_id = d.workorder_id
        LEFT JOIN wo_items    i ON i.workorder_id = d.workorder_id
        WHERE d.workorder_id IS NULL
        OR EXISTS (
              SELECT 1
                FROM workorder_items wi
              WHERE wi.workorder_id = d.workorder_id
                AND wi.status <> 'Canceled'
            )
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
        workorder_id,
        delivery_type,        // G2
        free_delivery,        // G2
        cash_to_removalist,   // G2
        installation_cost,    // G2
      } = body || {};

      if (!invoice_id || !customer_id || !delivery_state) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const dType = ['Standard', 'Standard + Installation', 'Customer Collect'].includes(delivery_type)
        ? delivery_type
        : 'Standard';

      // If creating directly as "Booked for Delivery", require date+carrier unless customer collect
      if (delivery_status === 'Booked for Delivery') {
        const rid = removalist_id == null || removalist_id === '' ? null : Number(removalist_id);
        const isCC = rid === CUSTOMER_COLLECT_ID;
        const hasDate = !!(delivery_date && String(delivery_date).trim() !== '');
        if (!rid) {
          return res.status(400).json({
            error: "Cannot set status to 'Booked for Delivery' without Carrier",
          });
        }
        if (!isCC && !hasDate) {
          return res.status(400).json({
            error: "Cannot set status to 'Booked for Delivery' without Delivery Date",
          });
        }
      }

      const actorId = twoCharId(req.headers['x-user-id'] || body?.user_id);

      await client.query('BEGIN');

      const r = await client.query(
        `
        INSERT INTO delivery (
          invoice_id, customer_id, delivery_suburb, delivery_state,
          delivery_charged, delivery_quoted, removalist_id, delivery_date,
          delivery_status, notes, workorder_id, date_created,
          delivery_type, free_delivery, cash_to_removalist, installation_cost
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          COALESCE($9, 'To Be Booked'::delivery_status_enum), $10,$11, NOW(),
          $12,$13,$14,$15
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
          dType,
          !!free_delivery,
          !!cash_to_removalist,
          installation_cost == null || installation_cost === '' ? null : Number(installation_cost),
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

      // F8b: created straight as booked → offer the text, don't send it. Best-effort:
      // a preview failure must never fail the creation the caller just made.
      let booking_sms = null;
      if (r.rows[0].delivery_status === 'Booked for Delivery') {
        try { booking_sms = await previewDeliveryBookedSms(client, r.rows[0].delivery_id); }
        catch (e) { console.error('delivery-booked preview (post-create) failed:', e); }
      }

      return res.status(201).json({ message: 'Delivery created', delivery_id: r.rows[0].delivery_id, booking_sms });
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
        delivery_type,        // G2
        free_delivery,        // G2
        cash_to_removalist,   // G2
        installation_cost,    // G2
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
        (delivery_status === undefined && prevStatus === 'Booked for Delivery'); // harmless if unchanged

      if (delivery_status === 'Booked for Delivery') {
        const rid = nextRemovalistId == null ? null : Number(nextRemovalistId);
        const isCC = rid === CUSTOMER_COLLECT_ID;

        // Must always have a carrier
        if (!rid) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: "Cannot set status to 'Booked for Delivery' without Carrier",
          });
        }

        // Date is required unless Customer Collect (id 15)
        const hasDate = !!(nextDeliveryDate && String(nextDeliveryDate).trim() !== '');
        if (!isCC && !hasDate) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: "Cannot set status to 'Booked for Delivery' without Delivery Date",
          });
        }
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
      // G2 delivery type + flags + installation cost
      if (delivery_type !== undefined)    { sets.push(`delivery_type = $${i++}`);    vals.push(['Standard','Standard + Installation','Customer Collect'].includes(delivery_type) ? delivery_type : null); }
      if (free_delivery !== undefined)    { sets.push(`free_delivery = $${i++}`);    vals.push(!!free_delivery); }
      if (cash_to_removalist !== undefined) { sets.push(`cash_to_removalist = $${i++}`); vals.push(!!cash_to_removalist); }
      if (installation_cost !== undefined){ sets.push(`installation_cost = $${i++}`); vals.push(installation_cost === '' || installation_cost == null ? null : Number(installation_cost)); }

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
      const becameBooked = delivery_status !== undefined && delivery_status !== prevStatus && delivery_status === 'Booked for Delivery';
      if (delivery_status !== undefined && delivery_status !== prevStatus) {
        if (delivery_status === 'Booked for Delivery') {
          await logEvent(client, { workorder_id: woid, event_type: 'DELIVERY_BOOKED', user_id: actorId });
        }
        if (delivery_status === 'Delivery Completed') {
          await logEvent(client, { workorder_id: woid, event_type: 'ORDER_DISPATCHED', user_id: actorId });
        }
      }

      await client.query('COMMIT');

      // F8b: just became booked → return the text for confirmation. NOT sent here — the
      // UI shows it to logistics, who send or decline. Best-effort: a preview failure must
      // never fail the booking that has already committed.
      let booking_sms = null;
      if (becameBooked) {
        try { booking_sms = await previewDeliveryBookedSms(client, id); }
        catch (e) { console.error('delivery-booked preview (post-update) failed:', e); }
      }

      return res.status(200).json({ message: 'Delivery updated', booking_sms });
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
