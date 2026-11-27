// lib/products.js — /api/products (SEC1, 27 Nov 2026: moved out of api/[...path].js).
// Was open to anyone and showed cost to any request carrying "x-user-access: superadmin".
// Now: a login is required (router gate + this check); cost (avg_cost) only for a SIGNED superadmin;
// workshop logins (technician / workshop / WK kiosk) may read the list but never change it (G17).
import { getAuthUser, hasRole } from './rbac.js';
import { isWorkshopRestricted } from './workshopAccess.js';

const COLS = 'sku, brand, name, stock, price';

export async function handleProducts(req, res, subSku, { getClient }) {
  const auth = getAuthUser(req);
  if (!auth || !auth.id) return res.status(401).json({ error: 'Please sign in again' });
  const { method, query, body } = req;
  if (!['GET', 'POST', 'PUT'].includes(method)) {
    res.setHeader('Allow', ['GET', 'POST', 'PUT']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (method !== 'GET' && isWorkshopRestricted(auth)) {
    return res.status(403).json({ error: 'Workshop logins cannot change products' });
  }
  const cols = hasRole(auth.roles, 'superadmin') ? `${COLS}, avg_cost` : COLS;
  const sku = subSku ?? query?.sku;
  const client = await getClient();
  try {
    if (method === 'GET') {
      if (sku) {
        const r = await client.query(`SELECT ${cols} FROM product WHERE sku = $1`, [sku]);
        if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
        return res.status(200).json(r.rows[0]);
      }
      const r = await client.query(`SELECT ${cols} FROM product`);
      return res.status(200).json(r.rows);
    }
    if (method === 'POST') {
      const { sku: newSku, brand, name, stock, price } = body || {};
      await client.query('INSERT INTO product (sku, brand, name, stock, price) VALUES ($1,$2,$3,$4,$5)', [newSku, brand, name, stock, price]);
      return res.status(201).json({ message: 'Product created' });
    }
    if (!sku) return res.status(400).json({ error: 'SKU is required' });
    const { name, brand, stock, price } = body || {};
    await client.query('UPDATE product SET name=$1, brand=$2, stock=$3, price=$4 WHERE sku=$5', [name, brand, stock, price, sku]);
    return res.status(200).json({ message: 'Product updated' });
  } finally {
    client.release();
  }
}
