import { Pool } from 'pg';

let pool;

export default async function handler(req, res) {
  if (!pool) {
    try {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
    } catch (err) {
      console.error("DB connection error:", err.message);
      return res.status(500).json({ error: "Database init failed" });
    }
  }

  try {
    const { method } = req;

    if (method === 'GET') {
      // Fetch all users
      const result = await pool.query('SELECT * FROM users');
      return res.status(200).json(result.rows);
    }

    if (method === 'PUT') {
      // Update user (expects: id, name, email, password, access)
      const { id, name, email, password, access } = req.body;
      if (!id) return res.status(400).json({ error: 'User ID is required' });

      await pool.query(
        `UPDATE users
         SET name = $1,
             email = $2,
             password = $3,
             access = $4
         WHERE id = $5`,
        [name, email, password, access || 'staff', id]
      );

      return res.status(200).json({ message: 'User updated successfully' });
    }

    if (method === 'DELETE') {
      // Delete user (expects: id)
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'User ID is required' });

      await pool.query('DELETE FROM users WHERE id = $1', [id]);
      return res.status(200).json({ message: 'User deleted successfully' });
    }

    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    return res.status(405).end(`Method ${method} Not Allowed`);
  } catch (err) {
    console.error("Handler error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
}