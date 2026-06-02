import { getClientWithTimezone } from '../lib/db.js';

export const FACILITY_NAMES = {
  '2000': 'NSW', '3000': 'VIC', '4000': 'QLD',
  '5000': 'SA',  '6000': 'WA',  '7000': 'TAS', '8000': 'NT',
};

// Order types matching Winnings SAP document types
const ORDER_TYPES   = ['ZWSO', 'ZISO', 'ZRE'];
const VALID_STATUSES = ['Draft', 'Submitted', 'Confirmed', 'Shipped', 'Cancelled'];

// Order types that require a Ship To Code
const REQUIRES_SHIP_TO_CODE = new Set(['ZISO', 'ZRE']);

// ─── helpers ─────────────────────────────────────────────────────────────────

function isSuperadmin(req) {
  return (req.headers['x-user-access'] || '').toLowerCase() === 'superadmin';
}

/** Generate a unique SO number: SO-YYYYMMDD-NNNN */
async function generateSoNumber(client) {
  const ymd    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `SO-${ymd}-`;
  const r = await client.query(
    `SELECT so_number FROM peloton_sales_orders
      WHERE so_number LIKE $1
      ORDER BY so_number DESC LIMIT 1`,
    [`${prefix}%`]
  );
  if (!r.rowCount) return `${prefix}0001`;
  const seq = parseInt(r.rows[0].so_number.slice(prefix.length), 10) || 0;
  return `${prefix}${String(seq + 1).padStart(4, '0')}`;
}

// ─── main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const section = (req.query.section || '').toLowerCase();
  if (section === 'sales-orders') return handleSalesOrders(req, res);
  return handleStock(req, res);
}

// ─────────────────────────────────────────────────────────────────────────────
// SAP STOCK PROXY
// ─────────────────────────────────────────────────────────────────────────────

async function handleStock(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const env     = (process.env.WINNINGS_ENV || '').toUpperCase();
  const isProd  = env === 'PROD';
  const apiKey  = isProd ? process.env.WINNINGS_API_KEY_PROD  : process.env.WINNINGS_API_KEY_QAS;
  const sapUser = isProd ? process.env.WINNINGS_SAP_USER_PROD : process.env.WINNINGS_SAP_USER_QAS;
  const sapPass = isProd ? process.env.WINNINGS_SAP_PASSWORD_PROD : process.env.WINNINGS_SAP_PASSWORD_QAS;
  const base    = isProd ? process.env.WINNINGS_SAP_BASE_PROD : process.env.WINNINGS_SAP_BASE_QAS;
  const prefix  = isProd ? 'PROD' : 'QAS';

  const missing = [
    !apiKey   && `WINNINGS_API_KEY_${prefix}`,
    !sapUser  && `WINNINGS_SAP_USER_${prefix}`,
    !sapPass  && `WINNINGS_SAP_PASSWORD_${prefix}`,
    !base     && `WINNINGS_SAP_BASE_${prefix}`,
  ].filter(Boolean);

  if (missing.length) {
    return res.status(500).json({
      error: `Winnings ${prefix} environment not fully configured. Missing: ${missing.join(', ')}`,
    });
  }

  const { facility, sku, includeZeroStock } = req.query;
  if (!facility) {
    return res.status(400).json({ error: 'facility is required (e.g. ?facility=2000 for NSW)' });
  }

  const filterParts = [`Facility eq '${facility}'`];
  if (sku)                         filterParts.push(`CustomerSKU eq '${sku}'`);
  if (includeZeroStock === 'true') filterParts.push(`IncludeZeroStock eq 'X'`);

  const url = `${base}/ZSD_INVENTORY_STOCK_SRV/InventoryStockSet?$filter=${encodeURIComponent(filterParts.join(' and '))}`;

  try {
    const sapRes = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'User': sapUser, 'Password': sapPass, 'Accept': 'application/json' },
    });

    const data = await sapRes.json().catch(() => ({}));
    if (!sapRes.ok) {
      const msg = data?.error?.message?.value || `SAP returned HTTP ${sapRes.status}`;
      return res.status(sapRes.status).json({ error: msg });
    }

    return res.status(200).json({
      results: Array.isArray(data?.d?.results) ? data.d.results : [],
      facility,
      facilityName: FACILITY_NAMES[facility] || facility,
      env,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[winnings/stock] fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to reach Winnings SAP API. Check server logs.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SALES ORDERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleSalesOrders(req, res) {
  if (!isSuperadmin(req)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const client = await getClientWithTimezone();

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { id, status, facility, order_type } = req.query;

      // Single order
      if (id) {
        const so = await client.query(
          `SELECT so.*,
                  to_char(so.created_at AT TIME ZONE 'Australia/Melbourne','DD-Mon-YYYY HH24:MI') AS created_fmt
             FROM peloton_sales_orders so WHERE so.so_id = $1`,
          [id]
        );
        if (!so.rowCount) return res.status(404).json({ error: 'Sales order not found' });

        const items = await client.query(
          `SELECT * FROM peloton_sales_order_items WHERE so_id = $1 ORDER BY item_id`,
          [id]
        );
        return res.status(200).json({ ...so.rows[0], items: items.rows });
      }

      // List with optional filters
      const conditions = [];
      const params     = [];
      let   p          = 1;
      if (status)     { conditions.push(`so.status     = $${p++}`); params.push(status);     }
      if (facility)   { conditions.push(`so.facility   = $${p++}`); params.push(facility);   }
      if (order_type) { conditions.push(`so.order_type = $${p++}`); params.push(order_type); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const list = await client.query(
        `SELECT
           so.so_id, so.so_number, so.order_type, so.facility, so.status,
           so.customer_name, so.customer_ref, so.ship_to, so.ship_to_code,
           so.return_reference, so.requested_date, so.notes, so.created_by,
           to_char(so.created_at AT TIME ZONE 'Australia/Melbourne','DD-Mon-YYYY HH24:MI') AS created_fmt,
           COALESCE(
             json_agg(json_build_object(
               'item_id',     i.item_id,
               'sku',         i.sku,
               'description', i.description,
               'quantity',    i.quantity,
               'unit_price',  i.unit_price
             )) FILTER (WHERE i.item_id IS NOT NULL),
             '[]'::json
           ) AS items
         FROM peloton_sales_orders so
         LEFT JOIN peloton_sales_order_items i ON i.so_id = so.so_id
         ${where}
         GROUP BY so.so_id
         ORDER BY so.created_at DESC`,
        params
      );
      return res.status(200).json(list.rows);
    }

    // ── POST (create) ────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const {
        order_type = 'ZWSO',
        facility,
        customer_name,
        customer_ref,
        ship_to,
        ship_to_code,
        return_reference,
        requested_date,
        status = 'Draft',
        notes,
        items = [],
        created_by,
      } = req.body || {};

      // Validate
      if (!ORDER_TYPES.includes(order_type)) {
        return res.status(400).json({ error: `Invalid order_type: ${order_type}. Must be one of: ${ORDER_TYPES.join(', ')}` });
      }
      if (!facility || !customer_name) {
        return res.status(400).json({ error: 'facility and customer_name are required' });
      }
      if (!FACILITY_NAMES[facility]) {
        return res.status(400).json({ error: `Invalid facility code: ${facility}` });
      }
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status: ${status}` });
      }
      // Ship To Code required for ZISO and ZRE
      if (REQUIRES_SHIP_TO_CODE.has(order_type) && !ship_to_code?.trim()) {
        return res.status(400).json({ error: `ship_to_code is required for ${order_type} orders` });
      }
      // Return reference required for ZRE
      if (order_type === 'ZRE' && !return_reference?.trim()) {
        return res.status(400).json({ error: 'return_reference (original SO number) is required for Return orders' });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'At least one line item is required' });
      }
      for (const it of items) {
        if (!it.sku?.trim()) {
          return res.status(400).json({ error: 'Each item requires a SKU' });
        }
        if (!it.quantity || Number(it.quantity) <= 0) {
          return res.status(400).json({ error: 'Each item requires a positive quantity' });
        }
      }

      await client.query('BEGIN');
      const soNumber = await generateSoNumber(client);

      const soRes = await client.query(
        `INSERT INTO peloton_sales_orders
           (so_number, order_type, facility, status, customer_name, customer_ref,
            ship_to, ship_to_code, return_reference, requested_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING so_id`,
        [
          soNumber, order_type, facility, status, customer_name,
          customer_ref      || null,
          ship_to           || null,
          ship_to_code      || null,
          return_reference  || null,
          requested_date    || null,
          notes             || null,
          created_by        || null,
        ]
      );
      const soId = soRes.rows[0].so_id;

      for (const it of items) {
        await client.query(
          `INSERT INTO peloton_sales_order_items (so_id, sku, description, quantity, unit_price)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            soId,
            String(it.sku).trim(),
            it.description || null,
            Number(it.quantity),
            it.unit_price != null && it.unit_price !== '' ? Number(it.unit_price) : null,
          ]
        );
      }

      await client.query('COMMIT');
      return res.status(201).json({ so_id: soId, so_number: soNumber, order_type });
    }

    // ── PUT (update header fields / status) ──────────────────────────────────
    if (req.method === 'PUT') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing so_id' });

      const {
        status, notes, ship_to, ship_to_code,
        return_reference, requested_date, customer_ref,
      } = req.body || {};

      const updates = [];
      const params  = [];
      let   p       = 1;

      if (status !== undefined) {
        if (!VALID_STATUSES.includes(status)) {
          return res.status(400).json({ error: `Invalid status: ${status}` });
        }
        updates.push(`status = $${p++}`); params.push(status);
      }
      if (notes            !== undefined) { updates.push(`notes            = $${p++}`); params.push(notes            || null); }
      if (ship_to          !== undefined) { updates.push(`ship_to          = $${p++}`); params.push(ship_to          || null); }
      if (ship_to_code     !== undefined) { updates.push(`ship_to_code     = $${p++}`); params.push(ship_to_code     || null); }
      if (return_reference !== undefined) { updates.push(`return_reference = $${p++}`); params.push(return_reference || null); }
      if (requested_date   !== undefined) { updates.push(`requested_date   = $${p++}`); params.push(requested_date   || null); }
      if (customer_ref     !== undefined) { updates.push(`customer_ref     = $${p++}`); params.push(customer_ref     || null); }

      if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });

      updates.push(`updated_at = NOW()`);
      params.push(id);

      const r = await client.query(
        `UPDATE peloton_sales_orders SET ${updates.join(', ')} WHERE so_id = $${p} RETURNING so_id, status`,
        params
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Sales order not found' });
      return res.status(200).json({ message: 'Updated', so_id: Number(id), status: r.rows[0].status });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[winnings/sales-orders] error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
