import { getClientWithTimezone } from '../db.js';
import { resolveWorkshopActor, redactWorkorder, workshopPutViolations } from '../workshopAccess.js';
import { getAuthUser, hasAnyRole } from '../rbac.js';
import { CANCELLED, WORKORDER_CANCEL_ROLES, CancelRefused, cancelWorkorder, reopenCancelledWorkorder } from '../workorderCancel.js';
import { queueWooStock, syncWorkorderWebsiteStock, canSeeWebsiteStockLog } from '../wooStock.js'; // G25
import { getWebsiteStockRows, retryWorkorderWebsiteStock, reopenWebsiteStockRows } from '../wooStockRetry.js'; // G25 increment 2
import { queueWebsiteAddBack, retakeWebsiteStock } from '../wooRestock.js'; // G25e1 back into stock
import { canSeeEcomAutoPopup, listEcomAutoTicked, markEcomAutoSeen } from '../ecomAutoTicked.js'; // GS one-time popup (26 Nov 2026)

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

/** Get access for current user (used to gate selling_price) **/
async function getUserAccess(client, userId2) {
  const id2 = twoCharId(userId2 || '');
  if (!id2) return null;
  const r = await client.query(`SELECT access FROM users WHERE id = $1 LIMIT 1`, [id2]);
  return r.rowCount ? r.rows[0].access : null;
}

/** Centralized logger **/
async function logEvent(
  client,
  {
    workorder_id,
    workorder_items_id = null,
    event_type,
    user_id = 'NA',
    item_status = null,
    notes_log = null,
  }
) {
  await client.query(
    `INSERT INTO workorder_logs
       (workorder_id, workorder_items_id, event_type, user_id, item_status, notes_log)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [workorder_id, workorder_items_id, event_type, twoCharId(user_id), item_status, notes_log]
  );
}

/** =========================
 * INVENTORY HELPERS
 * ========================== */

/** Atomic stock adjust with row lock and no-negative guard */
async function adjustProductStock(client, sku, delta) {
  const r = await client.query(`SELECT stock FROM product WHERE sku = $1 FOR UPDATE`, [sku]);
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

// deps.getClient lets an offline smoke inject a fake pg client (default = the real pool),
// mirroring lib/handlers/leads.js. Pure test-enablement — no behaviour change (F21).
//
// `sub` is unused today (workorder has no sub-paths) but is kept in leads.js's ARGUMENT
// POSITION deliberately: api/[...path].js passes `parts.slice(1)` as arg 3 to every other
// sub-path handler, so if this route ever gains one (/api/workorder/:id/history is the
// obvious candidate) the router would hand an array to `deps`, `deps.getClient` would be
// undefined, and this would silently fall back to the real pool instead of failing loudly.
export default async function handler(req, res, sub = [], deps = {}) {
  const {
    method,
    query: { id },
    body,
  } = req;

  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();
  // G25 website stock sync — injectable so the offline smoke never touches a real website.
  const wooEnv = deps.env || process.env;
  const syncWebsiteStock = deps.syncWebsiteStock || ((c, woId) => syncWorkorderWebsiteStock(c, woId, { env: wooEnv }));
  const retryWebsiteStock = deps.retryWebsiteStock || retryWorkorderWebsiteStock;
  // G25e1: cancelled items go back on the website; a reopen takes them again (injectable for the smoke).
  const addBackWebsiteStock = deps.addBackWebsiteStock || queueWebsiteAddBack;
  const retakeWebsite = deps.retakeWebsiteStock || retakeWebsiteStock;
  let wooQueued = 0;
  const cancelledItems = []; // { product_id, quantity, is_custom } cancelled in this save
  const restoredItems = [];  // … brought back from Canceled in this save
  // Website status rows → only for logins allowed to see website stock (superadmin / GS / GM).
  const websiteRowsFor = async (ids) => {
    try { return await getWebsiteStockRows(client, ids); } catch (err) { console.error('website stock rows:', err?.message); return new Map(); }
  };

  try {
    // G17: technicians / workshop / the WK kiosk see the job, not the money, and may only move
    // item status (never to Canceled) and set serials. See lib/workshopAccess.js.
    const workshop = await resolveWorkshopActor(req, client);

    if (method === 'GET') {
      const { id } = req.query;

      // Owner, 26 Nov 2026: GET /api/workorder?resource=ecommerce-auto-ticked — GS's one-time
      // popup (workorders the portal ticked by itself that GS hasn't opened yet). GS only, from
      // the signed login token.
      if (String(req.query?.resource || '') === 'ecommerce-auto-ticked') {
        if (!canSeeEcomAutoPopup(getAuthUser(req))) return res.status(403).json({ error: 'Only GS sees this list' });
        return res.status(200).json(await listEcomAutoTicked(client));
      }

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

        // gate selling_price by user access (superadmin only)
        const actorId = twoCharId(req.headers?.['x-user-id'] || '');
        const actorAccess = await getUserAccess(client, actorId);
        const canSeeSellingPrice = actorAccess === 'superadmin';

        const items = await client.query(
          `
          SELECT 
            wi.workorder_items_id, wi.workorder_id, wi.product_id,
            COALESCE(wi.custom_description, p.name, wi.product_id) AS product_name,
            wi.quantity, wi.condition, wi.technician_id, wi.status,
            wi.item_sn, wi.is_custom
            ${canSeeSellingPrice ? `, wi.selling_price` : ``}
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
            COALESCE(wi.custom_description, p.name, wi.product_id) AS product_name,
            l.item_status AS current_item_status,
            l.notes_log                                  
          FROM workorder_logs l
          LEFT JOIN workorder_items wi ON wi.workorder_items_id = l.workorder_items_id
          LEFT JOIN product p ON p.sku = wi.product_id
          WHERE l.workorder_id = $1
          ORDER BY l.created_at DESC, l.id DESC
          `,
          [id]
        );

        // G25: website-stock lines are for superadmin / GS / the marketing lead only — removed
        // here on the server, so other logins never receive them.
        const showWebsiteStock = canSeeWebsiteStockLog(getAuthUser(req), wooEnv);
        const activity = showWebsiteStock ? logs.rows : logs.rows.filter((l) => l.event_type !== 'WEBSITE_STOCK_SYNC');

        const payload = {
          ...wo.rows[0],
          items: items.rows,
          activity,
        };
        // G25 increment 2: per-item website status + Retry (same viewers as the log lines).
        if (showWebsiteStock && !workshop.restricted) {
          payload.website_stock = (await websiteRowsFor([id])).get(Number(id)) || [];
        }
        return res.status(200).json(workshop.restricted ? redactWorkorder(payload) : payload);
      }

      // === List workorders with filters ===
      const { status, state, salesperson, payment, technician } = req.query;

      const statusFilter = status ? decodeURIComponent(status) : undefined;
      const validStatuses = ['Work Ordered', 'Completed', CANCELLED, 'Not in Workshop', 'In Workshop'];
      if (statusFilter && !validStatuses.includes(statusFilter)) {
        return res.status(400).json({ error: 'Invalid workorder status' });
      }

      // For item aggregates:
      const itemStatusPredicate =
        statusFilter === 'Completed' ? `wi.status = 'Completed'` : `wi.status <> 'Completed'`;
      // G23: a cancelled workorder lists the items the cancel took off it (not ones removed earlier).
      const itemJoin = statusFilter === CANCELLED ? `wi.status_before_cancel IS NOT NULL` : `wi.status <> 'Canceled'`;

      let conditions = [];
      let params = [];
      let i = 1;

      if (statusFilter) {
        conditions.push(`wo.status::text = $${i++}`); // text: works before migration 0012 too
        params.push(statusFilter);
      }
      if (state) {
        conditions.push(`wo.delivery_state = $${i++}`);
        params.push(state);
      }
      if (salesperson) {
        conditions.push(`wo.salesperson = $${i++}`);
        params.push(salesperson);
      }
      // G17: the payment filter would tell a workshop login who has paid — ignored for them.
      if (payment && !workshop.restricted) {
        if (payment.toLowerCase() === 'paid') conditions.push(`wo.outstanding_balance = 0`);
        else if (payment.toLowerCase() === 'due') conditions.push(`wo.outstanding_balance > 0`);
      }
      if (technician) {
        conditions.push(`wi.technician_id = $${i++}`);
        params.push(technician);
      }

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
          wo.ecommerce,               -- ✅ NEW
          c.name AS customer_name,

          COALESCE(
            json_agg(
              json_build_object(
                'product_id',       wi.product_id,
                'product_name',     COALESCE(wi.custom_description, p.name, wi.product_id),
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
                wi.quantity::text || ' × ' || COALESCE(wi.custom_description, p.name, wi.product_id) ||
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
         AND ${itemJoin}
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

      if (workshop.restricted) return res.status(200).json(list.rows.map(redactWorkorder));
      // G25 increment 2: GS's E-Commerce popup says WHY a workorder is still unticked.
      if (canSeeWebsiteStockLog(getAuthUser(req), wooEnv)) {
        const unticked = list.rows.filter((w) => w.ecommerce === false).map((w) => w.workorder_id);
        if (unticked.length) {
          const byWo = await websiteRowsFor(unticked);
          for (const w of list.rows) if (w.ecommerce === false) w.website_stock = byWo.get(Number(w.workorder_id)) || [];
        }
      }
      return res.status(200).json(list.rows);
    }

    /** =========================
     * POST  (Create workorder)
     * ========================== */
    // G25 increment 2: POST /api/workorder?id=…&resource=website-retry — "Retry website update".
    // D7: GS + superadmin (plus the marketing lead / WOO_STOCK_LOG_VIEWERS — the people who can
    // see why it failed). Decided from the signed login token, never a client header.
    if (method === 'POST' && String(req.query?.resource || '') === 'website-retry') {
      const auth = getAuthUser(req);
      if (!canSeeWebsiteStockLog(auth, wooEnv)) return res.status(403).json({ error: 'Only GS or a superadmin can retry the website update' });
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });
      const r = await retryWebsiteStock(client, Number(id), { env: wooEnv, actorId: auth.id });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.status(200).json(r);
    }

    // Owner, 26 Nov 2026: POST /api/workorder?id=…&resource=ecommerce-auto-seen — GS opened an
    // automatically ticked workorder, so it never pops up again. GS only (signed token).
    if (method === 'POST' && String(req.query?.resource || '') === 'ecommerce-auto-seen') {
      if (!canSeeEcomAutoPopup(getAuthUser(req))) return res.status(403).json({ error: 'Only GS can clear this popup' });
      const r = await markEcomAutoSeen(client, id);
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.status(200).json(r);
    }

    if (method === 'POST') {
      if (workshop.restricted) return res.status(403).json({ error: 'Workshop logins cannot create workorders' });
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
        important_flag,
        delivery_type,          // G2: Standard | Standard + Installation | Customer Collect
        free_delivery,          // G2: included-in-sale flag
        cash_to_removalist,     // G2: customer pays removalist cash direct
        installation_cost,      // G2: our technician callout cost
      } = body || {};

      // G2 delivery service type — default Standard on create; flags default false.
      const woDeliveryType = ['Standard', 'Standard + Installation', 'Customer Collect'].includes(delivery_type)
        ? delivery_type
        : 'Standard';
      const woInstallCost =
        installation_cost === null || installation_cost === undefined || installation_cost === ''
          ? null
          : Number(installation_cost);

      if (
        !invoice_id ||
        !customer_id ||
        !salesperson ||
        !delivery_state ||
        !lead_time ||
        outstanding_balance == null
      ) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const actorId = twoCharId(req.headers?.['x-user-id'] || salesperson);
      const actorAccess = await getUserAccess(client, actorId);
      const canEditSellingPrice = actorAccess === 'superadmin';

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
          delivery_charged, lead_time, estimated_completion, notes, status, date_created, outstanding_balance, important_flag,
          delivery_type, free_delivery, cash_to_removalist, installation_cost
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,$12,$13,$14,$15,$16)
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
          important_flag == null ? false : !!important_flag,
          woDeliveryType,
          !!free_delivery,
          !!cash_to_removalist,
          woInstallCost,
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

          const itmStatus = item.status && String(item.status).trim() ? item.status : 'Not in Workshop';

          const qty = Number(item.quantity);
          if (item.is_custom && !(item.custom_description && String(item.custom_description).trim())) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Custom items require a description.' });
          }

          // INVENTORY: debit stock before inserting item
          if (!item.is_custom) {
            await adjustProductStock(client, item.product_id, -qty);
            // G25: queue the website stock change in the same transaction (no-op while off).
            wooQueued += await queueWooStock(client, { workorderId, items: [item] }, { env: wooEnv });
          }

          await client.query(
            `
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status,
              item_sn, is_custom, custom_description, custom_unit_price, selling_price
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `,
            [
              workorderId,
              item.product_id,
              qty,
              item.condition || 'NA',
              twoCharId(item.technician_id),
              itmStatus,
              item.item_sn ?? null,
              !!item.is_custom,
              item.is_custom ? item.custom_description || null : null,
              item.is_custom && item.custom_unit_price != null && item.custom_unit_price !== ''
                ? Number(item.custom_unit_price)
                : null,
              canEditSellingPrice && item.selling_price != null && item.selling_price !== ''
                ? Number(item.selling_price)
                : null,
            ]
          );
        }
      }

      await logEvent(client, {
        workorder_id: workorderId,
        event_type: 'WORKORDER_CREATED',
        user_id: actorId,
      });

      // capture the initial notes value if present
      if ((notes || '').trim()) {
        await logEvent(client, {
          workorder_id: workorderId,
          event_type: 'NOTE_ADDED',
          user_id: actorId,
          notes_log: notes,
        });
      }

      await client.query('COMMIT');

      // G25: after the commit, best-effort (never throws, never undoes the workorder).
      let website = null;
      if (wooQueued) website = await syncWebsiteStock(client, workorderId);
      return res.status(201).json({ message: 'Workorder created', workorder_id: workorderId, website });
    }

    /** =========================
     * PUT  (Update workorder + items/add/remove)
     * ========================== */
    if (method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });
      if (workshop.restricted) {
        // Checked BEFORE the transaction: a refused save writes nothing.
        const refused = workshopPutViolations(body);
        if (refused.length) {
          return res.status(403).json({
            error: `Workshop logins can only change item status (not Canceled) and serial numbers. Refused: ${refused.join(', ')}`,
            refused,
          });
        }
        const itemIds = (Array.isArray(body?.items) ? body.items : []).map((it) => Number(it?.workorder_items_id));
        if (itemIds.length) {
          // A completed workorder is reopened by an admin, not changed item by item: moving an
          // item off Completed and back would create a second delivery for the same order.
          const st = await client.query(`SELECT status FROM workorder WHERE workorder_id = $1`, [id]);
          if (st.rows[0]?.status === 'Completed') {
            return res.status(403).json({ error: 'This workorder is completed — ask an admin to reopen it before changing its items' });
          }
          // Only live items on THIS workorder: bringing back a Canceled item re-adds a product
          // (and takes stock), which a workshop login may not do.
          const cur = await client.query(
            `SELECT workorder_items_id, status FROM workorder_items WHERE workorder_id = $1 AND workorder_items_id = ANY($2::int[])`,
            [id, itemIds]
          );
          const live = new Set(cur.rows.filter((r) => r.status !== 'Canceled').map((r) => Number(r.workorder_items_id)));
          const bad = itemIds.filter((x) => !live.has(x));
          if (bad.length) {
            return res.status(403).json({ error: `Workshop logins can only change live items on this workorder. Refused item(s): ${bad.join(', ')}` });
          }
        }
      }
      // A workshop login's own token decides who the change is logged as — not a claimed id.
      const actorId = workshop.restricted && workshop.id
        ? twoCharId(workshop.id)
        : twoCharId(req.headers?.['x-user-id'] || body?.user_id || '');
      const actorAccess = await getUserAccess(client, actorId);
      const canEditSellingPrice = actorAccess === 'superadmin';

      const {
        notes,
        delivery_charged,
        outstanding_balance,
        estimated_completion,
        important_flag,
        ecommerce,            // ✅ NEW (GS only)
        items,
        add_items,
        delete_item_ids,
        status,
        salesperson,
        delivery_type,          // G2
        free_delivery,          // G2
        cash_to_removalist,     // G2
        installation_cost,      // G2
      } = body || {};

      await client.query('BEGIN');

      // Load WO for comparisons
      // G23: lock the workorder for the whole save, so a cancel and an item/delivery change never interleave.
      const currentWO = await client.query(`SELECT * FROM workorder WHERE workorder_id = $1 FOR UPDATE`, [id]);
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
      const validWOStatuses = ['Work Ordered', 'Completed', CANCELLED];
      if (explicitStatusProvided && !validWOStatuses.includes(String(status))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid workorder status' });
      }

      // G23: cancel / reopen. Only these roles (from the signed login, not a claimed id).
      // A reopen must say so (`reopen: true`, sent only by the Reopen button): an ordinary save from a
      // page opened before someone else cancelled still carries 'Work Ordered' and must not reopen.
      const wasCancelled = String(beforeWO.status) === CANCELLED;
      const cancelling = explicitStatusProvided && status === CANCELLED && !wasCancelled;
      const reopening = explicitStatusProvided && wasCancelled && status === 'Work Ordered' && body?.reopen === true;
      const refuse = async (code, error) => { await client.query('ROLLBACK'); return res.status(code).json({ error }); };
      const touchesItems = (Array.isArray(items) && items.length > 0)
        || (Array.isArray(add_items) && add_items.length > 0) || (Array.isArray(delete_item_ids) && delete_item_ids.length > 0);
      let cancelActor = actorId;
      if (cancelling || reopening) {
        const auth = getAuthUser(req);
        if (!auth) return refuse(401, 'Authentication required');
        if (!hasAnyRole(auth.roles, WORKORDER_CANCEL_ROLES)) {
          return refuse(403, 'Only superadmin, admin, logistics or sales logins can cancel or reopen a workorder');
        }
        cancelActor = twoCharId(auth.id); // logged as the signed login, not a claimed id
        if (touchesItems) return refuse(409, 'Cancel or reopen on its own — save other item changes first');
      }
      if (cancelling && String(beforeWO.status) === 'Completed') {
        return refuse(409, 'This workorder is completed — set it back to Work Ordered first if it really is to be cancelled');
      }
      if (wasCancelled && !reopening) {
        if (explicitStatusProvided && status !== CANCELLED) {
          return refuse(409, 'This workorder has been cancelled — reload the page; use Reopen workorder to bring it back');
        }
        if (touchesItems) return refuse(409, 'This workorder is cancelled — reopen it before changing its items');
      }

      // 1) Update WO-level fields
      const updates = [];
      const params = [];
      let p = 1;

      if (notes !== undefined) {
        updates.push(`notes = $${p++}`);
        params.push(notes || null);
      }
      if (delivery_charged !== undefined) {
        updates.push(`delivery_charged = $${p++}`);
        params.push(delivery_charged === null || delivery_charged === '' ? null : Number(delivery_charged));
      }
      if (outstanding_balance !== undefined) {
        updates.push(`outstanding_balance = $${p++}`);
        params.push(Number(outstanding_balance));
      }
      if (estimated_completion !== undefined) {
        updates.push(`estimated_completion = $${p++}`);
        params.push(estimated_completion || beforeWO.estimated_completion);
      }
      if (important_flag !== undefined) {
        updates.push(`important_flag = $${p++}`);
        params.push(!!important_flag);
      }
      if (salesperson !== undefined) {
        updates.push(`salesperson = $${p++}`);
        params.push(twoCharId(salesperson));
      }
      // G2 delivery service type + flags + installation cost
      if (delivery_type !== undefined) {
        const dt = ['Standard', 'Standard + Installation', 'Customer Collect'].includes(delivery_type)
          ? delivery_type
          : null;
        updates.push(`delivery_type = $${p++}`);
        params.push(dt);
      }
      if (free_delivery !== undefined) {
        updates.push(`free_delivery = $${p++}`);
        params.push(!!free_delivery);
      }
      if (cash_to_removalist !== undefined) {
        updates.push(`cash_to_removalist = $${p++}`);
        params.push(!!cash_to_removalist);
      }
      if (installation_cost !== undefined) {
        updates.push(`installation_cost = $${p++}`);
        params.push(installation_cost === null || installation_cost === '' ? null : Number(installation_cost));
      }

      // ✅ GS-only ecommerce flag (no logging)
      if (typeof ecommerce !== 'undefined' && actorId === 'GS') {
        updates.push(`ecommerce = $${p++}`);
        params.push(!!ecommerce);
      }

      if (updates.length) {
        params.push(id);
        await client.query(`UPDATE workorder SET ${updates.join(', ')} WHERE workorder_id = $${p}`, params);

        if (notes !== undefined && (notes || '') !== (beforeWO.notes || '')) {
          await logEvent(client, {
            workorder_id: id,
            event_type: 'NOTE_ADDED',
            user_id: actorId,
            notes_log: notes,
          });
        }
        if (outstanding_balance !== undefined && Number(outstanding_balance) !== Number(beforeWO.outstanding_balance)) {
          await logEvent(client, { workorder_id: id, event_type: 'PAYMENT_UPDATED', user_id: actorId });
        }
        if (important_flag !== undefined && beforeWO.important_flag !== !!important_flag) {
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_FLAG_CHANGED', user_id: actorId });
        }
      }

      // G23: a cancel, a reopen, or any save of a cancelled workorder stops here — items, the
      // auto-complete and the delivery below never run for it.
      if (cancelling || reopening || wasCancelled) {
        try {
          const ctx = { id, actorId: cancelActor, logEvent, adjustProductStock };
          if (cancelling) {
            const done = await cancelWorkorder(client, ctx);
            // G25e1: what the website lost for these items goes back (same transaction).
            wooQueued += await addBackWebsiteStock(client, {
              workorderId: Number(id), items: done.cancelledItems || [],
              salesperson: beforeWO.salesperson, ecommerce: beforeWO.ecommerce,
            }, { env: wooEnv });
          } else if (reopening) {
            const done = await reopenCancelledWorkorder(client, ctx);
            // G25: website updates the cancel closed off are due again (same transaction).
            wooQueued += await reopenWebsiteStockRows(client, Number(id), { env: wooEnv });
            // G25e1 (E-D4): add-backs already on the website are taken again — exactly once.
            wooQueued += await retakeWebsite(client, { workorderId: Number(id), items: done.restoredItems || [] }, { env: wooEnv });
          }
        } catch (err) {
          if (!(err instanceof CancelRefused)) throw err;
          await client.query('ROLLBACK');
          return res.status(err.status).json({ error: err.message });
        }
        await client.query('COMMIT');
        if (wooQueued) await syncWebsiteStock(client, Number(id));
        req.query.id = id;
        return await handler({ ...req, method: 'GET' }, res, sub, deps);
      }

      // 2) Update existing items (status / technician / item_sn / selling_price(superadmin))
      if (Array.isArray(items) && items.length) {
        for (const row of items) {
          const { workorder_items_id, status, technician_id, item_sn, selling_price } = row || {};
          if (!workorder_items_id) continue;

          const cur = await client.query(
            `SELECT workorder_items_id, status, technician_id, in_workshop, product_id, quantity,
                    item_sn, selling_price, is_custom
               FROM workorder_items
              WHERE workorder_items_id = $1 AND workorder_id = $2`,
            [workorder_items_id, id]
          );
          if (!cur.rows.length) continue;

          const before = cur.rows[0];
          const fields = [];
          const vals = [];
          let i = 1;

          if (technician_id !== undefined) {
            const tech = technician_id === '' || technician_id == null ? null : twoCharId(technician_id);

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
              const isCustom = !!before.is_custom;
              if (!isCustom) await adjustProductStock(client, before.product_id, +delta);
              cancelledItems.push({ product_id: before.product_id, quantity: before.quantity, is_custom: isCustom }); // G25e1
            } else if (status !== 'Canceled' && before.status === 'Canceled') {
              const delta = -Number(before.quantity);
              const isCustom = !!before.is_custom;
              if (!isCustom) await adjustProductStock(client, before.product_id, delta);
              restoredItems.push({ product_id: before.product_id, quantity: before.quantity, is_custom: isCustom }); // G25e1
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
            } else {
              fields.push(`status = $${i++}`);
              vals.push(status);
            }

            await logEvent(client, {
              workorder_id: id,
              workorder_items_id,
              event_type: 'ITEM_STATUS_CHANGED',
              user_id: actorId,
              item_status: status,
            });
          }

          // item_sn – free text; allow null/empty to clear
          if (row.hasOwnProperty('item_sn')) {
            const sn = item_sn == null || String(item_sn).trim() === '' ? null : String(item_sn).trim();
            const beforeSn = before.item_sn == null ? null : String(before.item_sn);
            if (sn !== beforeSn) {
              fields.push(`item_sn = $${i++}`);
              vals.push(sn);
            }
          }

          // selling_price – superadmin only
          if (canEditSellingPrice && row.hasOwnProperty('selling_price')) {
            const sp = selling_price === '' || selling_price == null ? null : Number(selling_price);
            const beforeSp = before.selling_price == null ? null : Number(before.selling_price);
            if (sp !== beforeSp) {
              fields.push(`selling_price = $${i++}`);
              vals.push(sp);
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

      // 2b) Add new items (supports serial + selling_price(superadmin))
      if (Array.isArray(add_items) && add_items.length) {
        for (const item of add_items) {
          if (!item?.product_id || !item?.quantity || !item?.condition) continue;

          // Enforce technician is required when adding items later
          if (!item?.technician_id || String(item.technician_id).trim() === '') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Technician is required for each new item.' });
          }

          const itmStatus = item.status && String(item.status).trim() ? item.status : 'Not in Workshop';
          const qty = Number(item.quantity);

          // INVENTORY: debit stock before insert
          if (!item.is_custom) {
            await adjustProductStock(client, item.product_id, -qty);
            // G25: queue the website stock change in the same transaction (no-op while off).
            wooQueued += await queueWooStock(client, { workorderId: id, items: [item] }, { env: wooEnv });
          }

          const ins = await client.query(
            `
            INSERT INTO workorder_items (
              workorder_id, product_id, quantity, condition, technician_id, status,
              item_sn, is_custom, custom_description, custom_unit_price, selling_price
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING workorder_items_id
            `,
            [
              id,
              item.product_id,
              qty,
              item.condition || 'NA',
              twoCharId(item.technician_id),
              itmStatus,
              item.item_sn ?? null,
              !!item.is_custom,
              item.is_custom ? item.custom_description || null : null,
              item.is_custom && item.custom_unit_price != null && item.custom_unit_price !== ''
                ? Number(item.custom_unit_price)
                : null,
              canEditSellingPrice && item.selling_price != null && item.selling_price !== ''
                ? Number(item.selling_price)
                : null,
            ]
          );

          const newItemId = ins.rows[0].workorder_items_id;

          await logEvent(client, {
            workorder_id: id,
            workorder_items_id: newItemId,
            event_type: 'ITEM_ADDED',
            user_id: actorId,
            item_status: itmStatus,
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
            user_id: actorId,
          });

          if (row.status !== 'Canceled') {
            const delta = Number(row.quantity);
            const { rows: chk } = await client.query(
              `SELECT is_custom FROM workorder_items WHERE workorder_items_id = $1`,
              [row.workorder_items_id]
            );
            // G25e1: `chk` is already the rows array (was `chk.rows.length`, which threw → 500).
            if (chk.length && !chk[0].is_custom) {
              await adjustProductStock(client, row.product_id, +delta);
              cancelledItems.push({ product_id: row.product_id, quantity: row.quantity, is_custom: false }); // G25e1
            }
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
        const curStatus = await client.query(`SELECT status FROM workorder WHERE workorder_id = $1`, [id]);
        const isCompletedNow = curStatus.rows.length && curStatus.rows[0].status === 'Completed';

        if (!isCompletedNow) {
          await client.query(`UPDATE workorder SET status = 'Completed' WHERE workorder_id = $1`, [id]);
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_STATUS_CHANGED', user_id: actorId });
          await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_COMPLETED', user_id: actorId });
        }

        // Create delivery ONLY if transitioned this request or explicit override
        const explicitCompletedNow =
          explicitStatusProvided && beforeWO.status !== 'Completed' && status === 'Completed';
        if (transitionedToCompletedViaItems || explicitCompletedNow) {
          const d = beforeWO;
          await client.query(
            `
            INSERT INTO delivery (
              invoice_id, customer_id, delivery_suburb, delivery_state,
              delivery_charged, delivery_quoted, removalist_id, delivery_date,
              delivery_status, notes, workorder_id, date_created,
              delivery_type, free_delivery, cash_to_removalist, installation_cost
            ) VALUES (
              $1,$2,$3,$4,$5,NULL,NULL,NULL,'To Be Booked',$6,$7,NOW(),
              $8,$9,$10,$11
            )
            `,
            [
              d.invoice_id,
              d.customer_id,
              d.delivery_suburb || null,
              d.delivery_state,
              d.delivery_charged == null ? null : Number(d.delivery_charged),
              d.notes ? `${d.notes}\n\n` : '',
              Number(id),
              d.delivery_type ?? null,           // G2: carry the WO's service type
              !!d.free_delivery,
              !!d.cash_to_removalist,
              d.installation_cost == null ? null : Number(d.installation_cost),
            ]
          );

          await logEvent(client, {
            workorder_id: id,
            event_type: 'DELIVERY_ORDER_CREATED',
            user_id: actorId,
          });
        }
      }

      // 4) Apply explicit WO status only if it represents a change from the DB value at request start
      if (explicitStatusProvided && status !== beforeWO.status) {
        await client.query(`UPDATE workorder SET status = $1 WHERE workorder_id = $2`, [status, id]);
        await logEvent(client, {
          workorder_id: id,
          event_type: 'WORKORDER_STATUS_CHANGED',
          user_id: actorId,
        });
      }

      // G25e1: cancelled items give back what the website lost; items back from Canceled take
      // it again (E-D4). Same transaction; the website calls happen after the commit.
      if (cancelledItems.length) {
        const salesNow = salesperson !== undefined ? twoCharId(salesperson) : beforeWO.salesperson;
        const ecommerceNow = typeof ecommerce !== 'undefined' && actorId === 'GS' ? !!ecommerce : beforeWO.ecommerce;
        wooQueued += await addBackWebsiteStock(client, { workorderId: Number(id), items: cancelledItems, salesperson: salesNow, ecommerce: ecommerceNow }, { env: wooEnv });
      }
      if (restoredItems.length) {
        wooQueued += await retakeWebsite(client, { workorderId: Number(id), items: restoredItems }, { env: wooEnv, reopenClosedSale: true });
      }

      await client.query('COMMIT');

      // G25: items were added → update the website stock after the commit (best-effort).
      if (wooQueued) await syncWebsiteStock(client, Number(id));

      // Return updated resource
      req.query.id = id;
      // Pass deps through: without it this re-read would acquire a REAL pool client even
      // when the caller injected one, so an offline test would silently hit the network.
      return await handler({ ...req, method: 'GET' }, res, sub, deps);
    }

    /** =========================
     * DELETE
     * ========================== */
    if (method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Missing workorder_id' });
      if (workshop.restricted) return res.status(403).json({ error: 'Workshop logins cannot delete workorders' });
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
    try {
      await client.query('ROLLBACK');
    } catch {}

    const msg = String(err?.message || '');

    if (/insufficient\s+stock/i.test(msg)) return res.status(409).json({ error: msg });
    if (/product not found/i.test(msg)) return res.status(404).json({ error: msg });
    if (/invalid stock math/i.test(msg)) return res.status(400).json({ error: msg });
    // G23 before migration 0012 (no 'Cancelled' value / status_before_cancel column).
    if ((err?.code === '22P02' && /Cancelled/.test(msg)) || (err?.code === '42703' && /status_before_cancel/.test(msg))) {
      return res.status(409).json({ error: 'Cancelling needs database update 0012, which has not been applied yet' });
    }

    console.error('Workorder API error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
