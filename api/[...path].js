// /api/[...path].js
import { compare, hash } from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getClientWithTimezone } from '../lib/db.js';

/** Robust path segmentation that works on Vercel + Next.js local */
function segs(req) {
  try {
    const url = req.url || '';
    const pathOnly = url.split('?')[0] || '';
    const afterApi = pathOnly.replace(/^\/?api\/?/, '');
    const parts = afterApi.split('/').filter(Boolean);
    if (parts.length) return parts;
  } catch (_) {}
  // Fallback for Next.js catch-all (?path=...)
  const raw = req.query?.path;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return res.status(405).end('Method Not Allowed');
}

export default async function handler(req, res) {
  const [root, sub] = segs(req);
  try {
    switch (root) {
      case undefined:
        return res.status(200).json({ ok: true, message: 'API root' });

      // Primary routes + aliases so old front-end calls still work
      case 'customers':
      case 'customer':
        return handleCustomers(req, res, sub);

      case 'products':
      case 'product':
        return handleProducts(req, res, sub);

      case 'waitlist':
      case 'waitlists':
        return handleWaitlist(req, res, sub);

      case 'brands':
        return handleBrands(req, res);

      // Auth + legacy aliases
      case 'auth':
        return handleAuth(req, res, sub);
      case 'login':
        if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
        return handleAuth(req, res, 'login');
      case 'register':
      case 'signup':
        if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
        return handleAuth(req, res, 'register');
      case 'change-password':
        if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
        return handleAuth(req, res, 'change-password');

      // Admin
      case 'users':
        return handleUsers(req, res);

      case 'access-log':
        return handleAccessLog(req, res);

      default:
        return res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/* ---------- CUSTOMERS ---------- */
async function handleCustomers(req, res, subId) {
  const client = await getClientWithTimezone();
  try {
    const { method, query, body } = req;
    const id = subId ?? query.id;

    if (method === 'GET') {
      if (id) {
        const r = await client.query('SELECT * FROM customers WHERE id = $1', [id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Customer not found' });
        return res.status(200).json(r.rows[0]);
      }
      const r = await client.query('SELECT * FROM customers ORDER BY id ASC');
      return res.status(200).json(r.rows);
    }

    if (method === 'POST') {
      const { name, email, phone, address, notes } = body;
      if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
      const r = await client.query(
        `INSERT INTO customers (name, email, phone, address, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, email, phone || null, address || '', notes || null]
      );
      return res.status(201).json(r.rows[0]);
    }

    if (method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Missing customer ID' });
      const { name, email, phone, address, notes } = body;
      const r = await client.query(
        `UPDATE customers
           SET name=$1, email=$2, phone=$3, address=$4, notes=$5
         WHERE id=$6 RETURNING *`,
        [name, email, phone || null, address || '', notes || null, id]
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Customer not found' });
      return res.status(200).json(r.rows[0]);
    }

    return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
  } finally {
    client.release();
  }
}

/* ---------- PRODUCTS ---------- */
async function handleProducts(req, res, subSku) {
  const client = await getClientWithTimezone();
  try {
    const { method, query, body } = req;
    const sku = subSku ?? query.sku;

    if (method === 'GET') {
      if (sku) {
        const r = await client.query('SELECT * FROM product WHERE sku = $1', [sku]);
        if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
        return res.status(200).json(r.rows[0]);
      }
      const r = await client.query('SELECT * FROM product');
      return res.status(200).json(r.rows);
    }

    if (method === 'POST') {
      const { sku, brand, name, stock, price } = body;
      await client.query(
        'INSERT INTO product (sku, brand, name, stock, price) VALUES ($1,$2,$3,$4,$5)',
        [sku, brand, name, stock, price]
      );
      return res.status(201).json({ message: 'Product created' });
    }

    if (method === 'PUT') {
      if (!sku) return res.status(400).json({ error: 'SKU is required' });
      const { name, brand, stock, price } = body;
      await client.query(
        'UPDATE product SET name=$1, brand=$2, stock=$3, price=$4 WHERE sku=$5',
        [name, brand, stock, price, sku]
      );
      return res.status(200).json({ message: 'Product updated' });
    }

    return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
  } finally {
    client.release();
  }
}

/* ---------- BRANDS ---------- */
async function handleBrands(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const client = await getClientWithTimezone();
  try {
    const r = await client.query('SELECT brand_id, brand_name FROM brand');
    return res.status(200).json(r.rows);
  } finally {
    client.release();
  }
}

/* ---------- WAITLIST ---------- */
async function handleWaitlist(req, res, subId) {
  const client = await getClientWithTimezone();
  try {
    const { method, query, body } = req;
    const id = subId ?? query.id;

    if (method === 'GET') {
      if (id) {
        const r = await client.query('SELECT * FROM waitlist WHERE waitlist_id = $1', [id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Waitlist not found' });
        return res.status(200).json(r.rows[0]);
      }
      const r = await client.query(`
        SELECT 
          w.waitlist_id,
          w.customer_id,
          w.product_sku,
          w.salesperson,
          w.status,
          w.notes,
          w.waitlisted,
          c.name  AS customer_name, 
          c.email AS customer_email,
          c.phone AS customer_phone,
          p.name  AS product_name,
          p.stock
        FROM waitlist w
        JOIN customers c ON w.customer_id = c.id
        JOIN product   p ON w.product_sku = p.sku
        /* If you want ALL statuses in analytics, remove the WHERE filter entirely */
        WHERE w.status IN ('Active', 'Notified')
        ORDER BY p.stock DESC NULLS LAST, w.waitlisted ASC
      `);
      return res.status(200).json(r.rows);
    }

    if (method === 'POST') {
      const { customer_id, product_sku, staff_id, status = 'Active', notes = '' } = body;
      await client.query(
        `INSERT INTO waitlist (customer_id, product_sku, salesperson, status, notes, waitlisted)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [customer_id, product_sku, staff_id, status, notes]
      );
      return res.status(201).json({ message: 'Waitlist created' });
    }

    if (method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'Missing waitlist_id' });
      const { customer_id, product_sku, staff_id, status, notes } = body;
      await client.query(
        `UPDATE waitlist
           SET customer_id=$1, product_sku=$2, salesperson=$3, status=$4, notes=$5
         WHERE waitlist_id=$6`,
        [customer_id, product_sku, staff_id, status, notes, id]
      );
      return res.status(200).json({ message: 'Waitlist updated' });
    }

    if (method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Missing waitlist_id' });
      await client.query('DELETE FROM waitlist WHERE waitlist_id = $1', [id]);
      return res.status(204).end();
    }

    return methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE']);
  } finally {
    client.release();
  }
}

/* ---------- AUTH ---------- */
async function handleAuth(req, res, action) {
  const client = await getClientWithTimezone();
  try {
    if (action === 'login') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const { email, password } = req.body;
      const r = await client.query('SELECT * FROM users WHERE email = $1', [email]);
      if (!r.rows.length) return res.status(401).json({ error: 'User not found' });
      const user = r.rows[0];
      const ok = await compare(password, user.password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

      const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
        expiresIn: '1h',
      });

      await client.query(
        'INSERT INTO access_log (user_id, description) VALUES ($1,$2)',
        [user.id, 'User logged in']
      );

      return res.status(200).json({
        message: 'Login successful',
        token,
        id: user.id,
        name: user.name,
        email: user.email,
        access: user.access,
      });
    }

    if (action === 'register') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const { id, name, email, password } = req.body;

      const existing = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (existing.rows.length) return res.status(409).json({ error: 'Email is already registered' });

      const hashed = await hash(password, 10);
      await client.query(
        'INSERT INTO users (id, name, email, password) VALUES ($1,$2,$3,$4)',
        [id, name, email, hashed]
      );
      return res.status(200).json({ message: 'User registered successfully' });
    }

    if (action === 'change-password') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const { email, oldPassword, newPassword } = req.body;

      const r = await client.query('SELECT * FROM users WHERE email = $1', [email]);
      if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
      const user = r.rows[0];

      const ok = await compare(oldPassword, user.password);
      if (!ok) return res.status(401).json({ error: 'Incorrect old password' });

      const hashed = await hash(newPassword, 10);
      await client.query('UPDATE users SET password = $1 WHERE email = $2', [hashed, email]);

      await client.query(
        'INSERT INTO access_log (user_id, description) VALUES ($1,$2)',
        [user.id, 'User changed password']
      );

      return res.status(200).json({ message: 'Password updated successfully' });
    }

    return res.status(404).json({ error: 'Auth path not found' });
  } finally {
    client.release();
  }
}

/* ---------- USERS ---------- */
async function handleUsers(req, res) {
  const client = await getClientWithTimezone();
  try {
    const { method, body } = req;

    if (method === 'GET') {
        const access = (req.query?.access || '').toString();
        if (access) {
            const r = await client.query('SELECT * FROM users WHERE access = $1', [access]);
            return res.status(200).json(r.rows);
        }
        const r = await client.query('SELECT * FROM users');
        return res.status(200).json(r.rows);
    }

    if (method === 'PUT') {
      const { id, name, email, password, access } = body;
      if (!id) return res.status(400).json({ error: 'User ID is required' });
      await client.query(
        `UPDATE users
           SET name=$1, email=$2, password=$3, access=$4
         WHERE id=$5`,
        [name, email, password, access || 'staff', id]
      );
      return res.status(200).json({ message: 'User updated successfully' });
    }

    if (method === 'DELETE') {
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'User ID is required' });
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      return res.status(200).json({ message: 'User deleted successfully' });
    }

    return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
  } finally {
    client.release();
  }
}

/* ---------- ACCESS LOG ---------- */
async function handleAccessLog(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const client = await getClientWithTimezone();
  try {
    const { userId, description } = req.body;
    if (!userId || !description) return res.status(400).json({ error: 'Missing data' });

    await client.query(
      'INSERT INTO access_log (user_id, description) VALUES ($1,$2)',
      [userId, description]
    );
    return res.status(200).json({ message: 'Log created' });
  } finally {
    client.release();
  }
}
