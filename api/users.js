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
        const result = await pool.query('SELECT * FROM users');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Query error:", err.message);
        res.status(500).json({ error: "Query failed" });
    }
}
