// /api/collections.js
import { getClientWithTimezone } from '../lib/db.js';

// ---- Helpers ----
const toInt = (v) => (v == null || v === '' ? null : parseInt(v, 10));

// Treat empty string as NULL for nullable text/enum columns
const toNullableStr = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// Required/enum-with-default: return default if empty/undefined
const toNonEmptyOrDefault = (v, def) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? def : s;
};

const ensureArray = (x) => (Array.isArray(x) ? x : (x ? [x] : []));
const isOther = (sku) => String(sku || '').toUpperCase() === 'OTHER';

// Iterative mean per your rule, but treat null/undefined/0 as "no previous avg"
function computeAvgAfterAdding(prevAvg, price, qty) {
  const q = Math.max(0, Number(qty || 0));
  const p = Number(price);

  // If prevAvg is null/undefined/0/NaN or <= 0, consider it missing.
  let cur = prevAvg == null ? null : Number(prevAvg);
  if (!(cur > 0)) cur = null;

  for (let i = 0; i < q; i++) {
    cur = cur == null ? p : (cur + p) / 2;
  }
  // If qty was 0, cur could still be null — fall back to p to be safe
  return cur == null ? p : cur;
}

/**
 * Superadmin guard
 * NOTE: Update table/columns if your auth DB differs.
 */
async function requireSuperadmin(req, client) {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return { ok: false, status: 401, error: 'Missing x-user-id' };
  }

  // ⚠️ Change this to match your DB schema if needed.
  const u = await client.query(
    `SELECT id, access
       FROM users
      WHERE id = $1`,
    [userId]
  );

  const access = u.rows?.[0]?.access;
  if (!access) return { ok: false, status: 401, error: 'Invalid user' };

  if (String(access).toLowerCase() !== 'superadmin') {
    return { ok: false, status: 403, error: 'Forbidden: superadmin only' };
  }

  return { ok: true, user: u.rows[0] };
}

export default async function handler(req, res) {
  const { method, query, body } = req;
  const client = await getClientWithTimezone();

  try {
    // -------- READS --------
    if (method === 'GET') {
      // GET /api/collections?resource=carriers -> removalists list
      if (query.resource === 'carriers') {
        const { rows } = await client.query(
          `SELECT id, name, phone, email
             FROM removalist
            ORDER BY name ASC`
        );
        return res.status(200).json(rows || []);
      }

      // GET /api/collections?resource=items&collection_id=123 -> items for a collection
      if (query.resource === 'items') {
        const cid = toInt(query.collection_id);
        if (!cid) return res.status(400).json({ error: 'collection_id is required' });
        const { rows } = await client.query(
          `SELECT ci.*, p.name, p.brand
             FROM collection_items ci
             LEFT JOIN product p ON p.sku = ci.product_sku
            WHERE ci.collection_id = $1
            ORDER BY ci.collection_items_id ASC`,
          [cid]
        );
        return res.status(200).json(rows || []);
      }

      // GET /api/collections?id=123[&include=items] -> single collection (optionally with items)
      if (query.id) {
        const { rows } = await client.query(
          `SELECT c.*, r.name AS removalist_name
             FROM collections c
             LEFT JOIN removalist r ON r.id = c.removalist_id
            WHERE c.id = $1`,
          [query.id]
        );

        const coll = rows?.[0] || null;
        if (!coll) return res.status(200).json(null);

        if (query.include === 'items') {
          const itemsRes = await client.query(
            `SELECT ci.*, p.name, p.brand
               FROM collection_items ci
               LEFT JOIN product p ON p.sku = ci.product_sku
              WHERE ci.collection_id = $1
              ORDER BY ci.collection_items_id ASC`,
            [query.id]
          );
          return res.status(200).json({ collection: coll, items: itemsRes.rows || [] });
        }

        return res.status(200).json(coll);
      }

      // GET /api/collections?completed=true|false -> list
      const { completed } = query;
      let sql = `
        SELECT c.*, r.name AS removalist_name
          FROM collections c
          LEFT JOIN removalist r ON r.id = c.removalist_id
      `;
      if (completed === 'true') sql += ` WHERE c.status = 'Completed' `;
      else if (completed === 'false') sql += ` WHERE c.status <> 'Completed' `;
      sql += ` ORDER BY c.collection_date NULLS LAST, c.name ASC `;
      const { rows } = await client.query(sql);
      return res.status(200).json(rows || []);
    }

    // -------- CREATE / ACTIONS --------
    if (method === 'POST') {
      // POST /api/collections?resource=apply-inventory&id=123  (superadmin only)
      if (query.resource === 'apply-inventory') {
        const { id } = query;
        if (!id) return res.status(400).json({ error: 'id is required' });

        const auth = await requireSuperadmin(req, client);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

        await client.query('BEGIN');
        try {
          // Lock collection row to prevent concurrent applies
          const collRes = await client.query(
            `SELECT *
               FROM collections
              WHERE id = $1
              FOR UPDATE`,
            [id]
          );
          if (!collRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
          }

          const coll = collRes.rows[0];

          // Require Completed (optional but recommended)
          if (coll.status !== 'Completed') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Collection must be Completed before applying inventory updates.' });
          }

          // Idempotency guard
          if (coll.inventory_applied_at) {
            await client.query('ROLLBACK');
            return res.status(200).json({
              success: true,
              alreadyApplied: true,
              inventory_applied_at: coll.inventory_applied_at,
            });
          }

          // Compute allocation from DB items
          const dbItemsRes = await client.query(
            `SELECT product_sku, quantity, purchase_price
               FROM collection_items
              WHERE collection_id = $1`,
            [id]
          );
          const dbItems = ensureArray(dbItemsRes.rows || []);

          const est = Number(coll.est_extraction || 0);
          const act = Number(coll.act_extraction || 0);
          const diff = act - est;

          const totalQtyExclOtherDB = dbItems
            .filter((it) => !isOther(it.product_sku))
            .reduce((a, b) => a + Number(b.quantity || 0), 0);

          const perUnitAdjDB = totalQtyExclOtherDB > 0 ? diff / totalQtyExclOtherDB : 0;

          // Build effective items for completion calculations (raw + per-unit allocation, OTHER excluded)
          const itemsForCompletion = dbItems.map((it) =>
            isOther(it.product_sku)
              ? { ...it, purchase_price: Number(it.purchase_price || 0) }
              : { ...it, purchase_price: Number(it.purchase_price || 0) + perUnitAdjDB }
          );

          // Lock affected products
          const affectedSkus = [...new Set(
            itemsForCompletion
              .filter((it) => !isOther(it.product_sku))
              .map((it) => String(it.product_sku).toUpperCase())
          )];

          if (affectedSkus.length) {
            const lockRes = await client.query(
              `SELECT sku, avg_cost, stock
                 FROM product
                WHERE sku = ANY($1)
                FOR UPDATE`,
              [affectedSkus]
            );

            const stats = new Map();
            for (const r of lockRes.rows) {
              stats.set(String(r.sku).toUpperCase(), {
                avg_cost: r.avg_cost,
                stock: r.stock,
              });
            }

            // Apply avg/stock updates using effective prices
            for (const it of itemsForCompletion) {
              if (isOther(it.product_sku)) continue;

              const sku = String(it.product_sku).toUpperCase();
              const qty = Number(it.quantity || 0);
              const price = Number(it.purchase_price || 0);

              const cur = stats.get(sku) || { avg_cost: null, stock: 0 };
              const nextAvg = computeAvgAfterAdding(cur.avg_cost, price, qty);
              const nextStock = Number(cur.stock || 0) + qty;

              await client.query(
                `UPDATE product
                    SET avg_cost = $1,
                        stock = $2
                  WHERE sku = $3`,
                [nextAvg, nextStock, sku]
              );
            }
          }

          // Mark applied
          const done = await client.query(
            `UPDATE collections
                SET inventory_applied_at = NOW()
              WHERE id = $1
            RETURNING inventory_applied_at`,
            [id]
          );

          await client.query('COMMIT');
          return res.status(200).json({
            success: true,
            inventory_applied_at: done.rows[0].inventory_applied_at,
          });
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch {}
          throw e;
        }
      }

      // POST /api/collections?resource=reset-inventory-apply&id=123  (superadmin only)
      if (query.resource === 'reset-inventory-apply') {
        const { id } = query;
        if (!id) return res.status(400).json({ error: 'id is required' });

        const auth = await requireSuperadmin(req, client);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

        await client.query('BEGIN');
        try {
          const cur = await client.query(
            `SELECT id, inventory_applied_at
               FROM collections
              WHERE id = $1
              FOR UPDATE`,
            [id]
          );
          if (!cur.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
          }

          const upd = await client.query(
            `UPDATE collections
                SET inventory_applied_at = NULL
              WHERE id = $1
            RETURNING id, inventory_applied_at`,
            [id]
          );

          await client.query('COMMIT');
          return res.status(200).json({ success: true, collection: upd.rows[0] });
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch {}
          throw e;
        }
      }

      // POST /api/collections?resource=item  (legacy: add a collection item; NO avg/stock updates here)
      if (query.resource === 'item') {
        const payload = {
          collection_id: toInt(body.collection_id),
          product_sku: toNonEmptyOrDefault(body.product_sku, '').toUpperCase(),
          quantity: toInt(body.quantity) || 1,
          purchase_price: body.purchase_price == null ? null : Number(body.purchase_price),
          custom_description: toNullableStr(body.custom_description),
        };

        if (!payload.collection_id) return res.status(400).json({ error: 'collection_id is required' });
        if (!payload.product_sku) return res.status(400).json({ error: 'product_sku is required' });
        if (payload.purchase_price == null || isNaN(payload.purchase_price) || payload.purchase_price <= 0) {
          return res.status(400).json({ error: 'purchase_price must be > 0' });
        }
        if (payload.quantity <= 0) return res.status(400).json({ error: 'quantity must be >= 1' });

        // Insert only; do not update product avg/stock here (deferred to manual apply)
        const ins = await client.query(
          `INSERT INTO collection_items (collection_id, product_sku, quantity, purchase_price, custom_description)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING collection_items_id`,
          [payload.collection_id, payload.product_sku, payload.quantity, payload.purchase_price, payload.custom_description]
        );

        return res.status(201).json({
          success: true,
          collection_items_id: ins.rows[0].collection_items_id,
        });
      }

      // POST /api/collections  (create collection)
      const payload = {
        name: toNullableStr(body.name),                 // required later
        suburb: toNullableStr(body.suburb),
        state: toNullableStr(body.state),               // enum NULL if ''
        description: toNullableStr(body.description),
        removalist_id: toInt(body.removalist_id),
        collection_date: toNullableStr(body.collection_date), // 'YYYY-MM-DD' or NULL
        notes: toNullableStr(body.notes),
        status: toNonEmptyOrDefault(body.status, 'To Be Booked'),
      };

      if (!payload.name) {
        return res.status(400).json({ error: 'Name is required.' });
      }
      if (
        payload.status === 'Completed' &&
        (!payload.collection_date || !payload.removalist_id)
      ) {
        return res.status(400).json({
          error: 'To set status Completed, collection date and carrier are required.',
        });
      }

      const { rows } = await client.query(
        `INSERT INTO collections
           (name, suburb, state, description, removalist_id, collection_date, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          payload.name,
          payload.suburb,
          payload.state,
          payload.description,
          payload.removalist_id,
          payload.collection_date,
          payload.notes,
          payload.status,
        ]
      );
      return res.status(201).json(rows[0]);
    }

    // -------- UPDATE (Bulk save; NO completion effects anymore) --------
    if (method === 'PATCH') {
      // PATCH /api/collections?resource=item  (not supported)
      if (query.resource === 'item') {
        return res.status(405).json({ error: 'Item update not supported. Delete and re-add instead.' });
      }

      // PATCH /api/collections?id=...
      const { id } = query;
      if (!id) return res.status(400).json({ error: 'id is required' });

      const cur = await client.query(`SELECT * FROM collections WHERE id=$1`, [id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      const prev = cur.rows[0];

      const patch = {
        name: body.name !== undefined ? toNullableStr(body.name) : prev.name,
        suburb: body.suburb !== undefined ? toNullableStr(body.suburb) : prev.suburb,
        state: body.state !== undefined ? toNullableStr(body.state) : prev.state, // enum
        description: body.description !== undefined ? toNullableStr(body.description) : prev.description,
        removalist_id:
          body.removalist_id !== undefined ? toInt(body.removalist_id) : prev.removalist_id,
        collection_date:
          body.collection_date !== undefined ? toNullableStr(body.collection_date) : prev.collection_date,
        notes: body.notes !== undefined ? toNullableStr(body.notes) : prev.notes,
        status: body.status !== undefined ? toNonEmptyOrDefault(body.status, prev.status) : prev.status,
        est_extraction:
          body.est_extraction !== undefined
            ? (body.est_extraction == null ? null : Number(body.est_extraction))
            : prev.est_extraction,
        act_extraction:
          body.act_extraction !== undefined
            ? (body.act_extraction == null ? null : Number(body.act_extraction))
            : prev.act_extraction,
      };

      if (!patch.name) return res.status(400).json({ error: 'Name is required.' });
      if (
        patch.status === 'Completed' &&
        (!patch.collection_date || !patch.removalist_id)
      ) {
        return res.status(400).json({
          error: 'To set status Completed, collection date and carrier are required.',
        });
      }

      // Are items included in this PATCH?
      const hasItemsInBody = Object.prototype.hasOwnProperty.call(body, 'items');

      // Normalize incoming items if provided (store RAW prices only; no allocation persisted)
      let rawItemsFromBody = null;
      if (hasItemsInBody) {
        rawItemsFromBody = ensureArray(body.items).map((it) => ({
          product_sku: toNonEmptyOrDefault(it.product_sku, '').toUpperCase(),
          quantity: toInt(it.quantity) || 0,
          purchase_price: it.purchase_price == null ? null : Number(it.purchase_price),
          custom_description: toNullableStr(it.custom_description),
        })).filter((it) =>
          it.product_sku &&
          it.quantity > 0 &&
          it.purchase_price != null &&
          it.purchase_price >= 0
        );
      }

      await client.query('BEGIN');

      // If items were provided, replace existing items snapshot with RAW ones (no allocation persisted)
      if (hasItemsInBody) {
        await client.query(`DELETE FROM collection_items WHERE collection_id = $1`, [id]);
        if (rawItemsFromBody.length) {
          const values = [];
          const params = [];
          let i = 1;
          for (const it of rawItemsFromBody) {
            values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
            params.push(Number(id), it.product_sku, Number(it.quantity || 0), Number(it.purchase_price || 0), it.custom_description);
          }
          await client.query(
            `INSERT INTO collection_items (collection_id, product_sku, quantity, purchase_price, custom_description)
            VALUES ${values.join(',')}`,
            params
          );
        }
      }

      // ✅ NOTE: No automatic inventory updates here anymore.

      // Finally, update the collection itself (writes est/act extraction & status)
      const { rows } = await client.query(
        `UPDATE collections
            SET name=$1, suburb=$2, state=$3, description=$4,
                removalist_id=$5, collection_date=$6, notes=$7, status=$8,
                est_extraction=$9, act_extraction=$10
          WHERE id=$11
        RETURNING *`,
        [
          patch.name,
          patch.suburb,
          patch.state,
          patch.description,
          patch.removalist_id,
          patch.collection_date,
          patch.notes,
          patch.status,
          patch.est_extraction,
          patch.act_extraction,
          id,
        ]
      );

      await client.query('COMMIT');
      return res.status(200).json(rows[0]);
    }

    // -------- DELETE --------
    if (method === 'DELETE') {
      // DELETE /api/collections?resource=item (legacy)
      if (query.resource === 'item') {
        const collection_items_id = toInt(body?.collection_items_id);
        if (!collection_items_id) return res.status(400).json({ error: 'collection_items_id is required' });

        // Just delete the record; no avg/stock rollback.
        await client.query(
          `DELETE FROM collection_items WHERE collection_items_id = $1`,
          [collection_items_id]
        );
        return res.status(204).end();
      }

      // DELETE /api/collections?id=...
      const { id } = query;
      if (!id) return res.status(400).json({ error: 'id is required' });
      await client.query(`DELETE FROM collections WHERE id=$1`, [id]);
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('collections API error:', e);
    try { await client.query('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}
