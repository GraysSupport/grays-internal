// api/collections.js
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

      // GET /api/collections?id=123 -> single collection
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

    // -------- CREATE --------
    if (method === 'POST') {
      const payload = {
        name: toNullableStr(body.name),                 // required later
        suburb: toNullableStr(body.suburb),
        state: toNullableStr(body.state),               // <— enum NULL if ''
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
          payload.state,          // will be NULL if '' on input
          payload.description,
          payload.removalist_id,
          payload.collection_date,
          payload.notes,
          payload.status,
        ]
      );
      return res.status(201).json(rows[0]);
    }

    // -------- UPDATE --------
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

    // -------- DELETE --------
    if (method === 'DELETE') {
      const { id } = query;
      if (!id) return res.status(400).json({ error: 'id is required' });
      await client.query(`DELETE FROM collections WHERE id=$1`, [id]);
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('collections API error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}
