// /api/collections.js
import { getClientWithTimezone } from '../lib/db.js';

// ---- Helpers ----
const toInt = (v) => (v == null || v === '' ? null : parseInt(v, 10));
const toNum = (v) => (v == null || v === '' ? null : Number(v));
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

export default async function handler(req, res) {
  const { method, query, body } = req;
  const client = await getClientWithTimezone();

  try {
    // -----------------------  SUBRESOURCES  -----------------------
    // Carriers list
    if (method === 'GET' && query.resource === 'carriers') {
      const { rows } = await client.query(
        `SELECT id, name, phone, email
           FROM removalist
          ORDER BY name ASC`
      );
      return res.status(200).json(rows || []);
    }

    // Items: list by collection_id
    // GET /api/collections?resource=items&collection_id=123
    if (method === 'GET' && query.resource === 'items') {
      const cid = toInt(query.collection_id);
      if (!cid) return res.status(400).json({ error: 'collection_id is required' });
      const { rows } = await client.query(
        `SELECT ci.collection_items_id, ci.collection_id, ci.product_sku, ci.quantity, ci.purchase_price,
                p.name AS product_name, p.brand
           FROM collection_items ci
           LEFT JOIN product p ON p.sku = ci.product_sku
          WHERE ci.collection_id = $1
          ORDER BY ci.collection_items_id ASC`,
        [cid]
      );
      return res.status(200).json(rows || []);
    }

    // Items: BULK UPSERT for a collection + avg_cost update (with extraction_cost from request body)
    // POST /api/collections?resource=items&collection_id=123
    // body: { items: [{collection_items_id?, product_sku, quantity, purchase_price}], extraction_cost?: number }
    if (method === 'POST' && query.resource === 'items') {
      const cid = toInt(query.collection_id);
      if (!cid) return res.status(400).json({ error: 'collection_id is required' });

      const incoming = Array.isArray(body?.items) ? body.items : [];
      // light validation
      for (const it of incoming) {
        if (!String(it?.product_sku || '').trim()) {
          return res.status(400).json({ error: 'product_sku is required for all items' });
        }
        if (toInt(it.quantity) == null) {
          return res.status(400).json({ error: 'quantity is required for all items' });
        }
      }

      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        `SELECT collection_items_id FROM collection_items WHERE collection_id = $1`,
        [cid]
      );
      const existingIds = new Set(existing.map(r => r.collection_items_id));

      const normalized = incoming.map(it => ({
        collection_items_id: toInt(it.collection_items_id),
        product_sku: String(it.product_sku).trim(),
        quantity: toInt(it.quantity),
        purchase_price: toNum(it.purchase_price),
      }));

      // Upsert loop
      for (const it of normalized) {
        if (it.collection_items_id && existingIds.has(it.collection_items_id)) {
          await client.query(
            `UPDATE collection_items
                SET product_sku=$1, quantity=$2, purchase_price=$3
              WHERE collection_items_id=$4 AND collection_id=$5`,
            [it.product_sku, it.quantity, it.purchase_price, it.collection_items_id, cid]
          );
          existingIds.delete(it.collection_items_id);
        } else {
          await client.query(
            `INSERT INTO collection_items (collection_id, product_sku, quantity, purchase_price)
             VALUES ($1,$2,$3,$4)`,
            [cid, it.product_sku, it.quantity, it.purchase_price]
          );
        }
      }

      // Delete items not present anymore
      if (existingIds.size) {
        await client.query(
          `DELETE FROM collection_items
            WHERE collection_items_id = ANY($1::int[])
              AND collection_id = $2`,
          [Array.from(existingIds), cid]
        );
      }

      // ---------- Pricing logic (front-end supplied extraction_cost) ----------
      // Rule:
      // 1) Ignore OTHER items (product_sku === 'OTHER') completely
      // 2) Equally distribute extraction_cost across ALL non-OTHER units (sum of quantities)
      // 3) adjusted_unit_cost = perUnitPurchasePrice - perUnitShare
      // 4) Compute quantity-weighted adjusted unit cost per SKU
      // 5) Update product.avg_cost = average(old_avg, adjusted_cost) [2-point moving average]
      const extractionCost = toNum(body?.extraction_cost) || 0;

      // If purchase_price is a line total instead of per-unit, swap to:
      //   const unitCost = it.purchase_price / it.quantity;
      const nonOther = normalized.filter(
        it => it.product_sku !== 'OTHER' && it.purchase_price != null && (it.quantity || 0) > 0
      );

      const totalUnits = nonOther.reduce((sum, it) => sum + it.quantity, 0);
      const perUnitShare = totalUnits > 0 ? (extractionCost / totalUnits) : 0;

      const skuAgg = new Map(); // sku -> { sumCost, sumQty }
      for (const it of nonOther) {
        const unitCost = it.purchase_price; // per-unit assumption
        const adjusted = unitCost - perUnitShare;
        const acc = skuAgg.get(it.product_sku) || { sumCost: 0, sumQty: 0 };
        acc.sumCost += adjusted * it.quantity;
        acc.sumQty  += it.quantity;
        skuAgg.set(it.product_sku, acc);
      }

      const vals = [];
      const params = [];
      let i = 1;
      for (const [sku, acc] of skuAgg.entries()) {
        if (acc.sumQty > 0) {
          const weighted = Math.round((acc.sumCost / acc.sumQty) * 100) / 100; // cents
          params.push(sku, weighted);
          vals.push(`($${i++}, $${i++})`);
        }
      }

      if (vals.length) {
        const nextAvgSql = `CASE
          WHEN p.avg_cost IS NULL THEN s.adjusted_cost
          ELSE ROUND( (p.avg_cost + s.adjusted_cost) / 2.0, 2 )
        END`;

        await client.query(
          `
          WITH s(product_sku, adjusted_cost) AS (
            VALUES ${vals.join(',')}
          )
          UPDATE product p
             SET avg_cost = ${nextAvgSql}
            FROM s
           WHERE p.sku = s.product_sku
          `,
          params
        );
      }
      // ---------- end pricing logic ----------

      await client.query('COMMIT');
      return res.status(200).json({ ok: true });
    }

    // Single item PATCH
    // PATCH /api/collections?resource=item&id=456
    // body: { product_sku?, quantity?, purchase_price?, extraction_cost?: number }
    if (method === 'PATCH' && query.resource === 'item') {
      const id = toInt(query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      await client.query('BEGIN');

      const { rows: [cur] } = await client.query(
        `SELECT * FROM collection_items WHERE collection_items_id=$1`,
        [id]
      );
      if (!cur) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }

      const product_sku = body.product_sku === undefined ? cur.product_sku : String(body.product_sku).trim();
      const quantity = body.quantity === undefined ? cur.quantity : toInt(body.quantity);
      const purchase_price = body.purchase_price === undefined ? cur.purchase_price : toNum(body.purchase_price);

      await client.query(
        `UPDATE collection_items
            SET product_sku=$1, quantity=$2, purchase_price=$3
          WHERE collection_items_id=$4`,
        [product_sku, quantity, purchase_price, id]
      );

      // Pricing logic for PATCH (uses extraction_cost from request body)
      if (product_sku !== 'OTHER' && purchase_price != null && (quantity || 0) > 0) {
        const extractionCost = toNum(body?.extraction_cost) || 0;

        const { rows: unitRows } = await client.query(
          `SELECT COALESCE(SUM(ci.quantity),0) AS total_units
             FROM collection_items ci
            WHERE ci.collection_id = (SELECT collection_id FROM collection_items WHERE collection_items_id=$1)
              AND ci.product_sku <> 'OTHER'`,
          [id]
        );

        const totalUnits = Number(unitRows?.[0]?.total_units || 0);
        const perUnitShare = totalUnits > 0 ? (extractionCost / totalUnits) : 0;

        // If purchase_price is line total, change to: const unitCost = purchase_price / quantity;
        const unitCost = purchase_price;
        const adjusted = unitCost - perUnitShare;

        await client.query(
          `
          WITH s(product_sku, adjusted_cost) AS (
            SELECT $1::varchar(15), ROUND($2::numeric, 2)
          )
          UPDATE product p
             SET avg_cost = CASE
               WHEN p.avg_cost IS NULL THEN s.adjusted_cost
               ELSE ROUND( (p.avg_cost + s.adjusted_cost) / 2.0, 2 )
             END
            FROM s
           WHERE p.sku = s.product_sku
          `,
          [product_sku, adjusted]
        );
      }

      await client.query('COMMIT');
      return res.status(200).json({ ok: true });
    }

    // Single item DELETE
    // DELETE /api/collections?resource=item&id=456
    if (method === 'DELETE' && query.resource === 'item') {
      const id = toInt(query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      await client.query(`DELETE FROM collection_items WHERE collection_items_id=$1`, [id]);
      return res.status(204).end();
    }

    // -----------------------  COLLECTIONS  -----------------------
    if (method === 'GET') {
      // GET /api/collections?id=123&include=items
      if (query.id && query.include === 'items') {
        const { rows } = await client.query(
          `SELECT c.*, r.name AS removalist_name
             FROM collections c
             LEFT JOIN removalist r ON r.id = c.removalist_id
            WHERE c.id = $1`,
          [query.id]
        );
        const collection = rows[0] || null;

        const itemsRes = await client.query(
          `SELECT ci.collection_items_id, ci.collection_id, ci.product_sku, ci.quantity, ci.purchase_price,
                  p.name as product_name, p.brand
             FROM collection_items ci
             LEFT JOIN product p ON p.sku = ci.product_sku
            WHERE ci.collection_id = $1
            ORDER BY ci.collection_items_id ASC`,
          [query.id]
        );

        return res.status(200).json({ collection, items: itemsRes.rows || [] });
      }

      // GET /api/collections?id=123
      if (query.id) {
        const { rows } = await client.query(
          `SELECT c.*, r.name AS removalist_name
             FROM collections c
             LEFT JOIN removalist r ON r.id = c.removalist_id
            WHERE c.id = $1`,
          [query.id]
        );
        return res.status(200).json(rows[0] || null);
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

    // CREATE collection (header only)
    if (method === 'POST') {
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

    // UPDATE collection (header only)
    if (method === 'PATCH') {
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

      const { rows } = await client.query(
        `UPDATE collections
            SET name=$1, suburb=$2, state=$3, description=$4,
                removalist_id=$5, collection_date=$6, notes=$7, status=$8
          WHERE id=$9
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
          id,
        ]
      );
      return res.status(200).json(rows[0]);
    }

    // DELETE collection (header + cascade-delete items if FK is set)
    if (method === 'DELETE') {
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
