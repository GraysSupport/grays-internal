import { Pool } from 'pg';

let pool;

export default async function handler(req, res) {
  if (!pool) {
    try {
        console.log("DATABASE_URL:", process.env.DATABASE_URL);
        console.log("Connecting to DB...");
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
        console.log("Querying users...");
        const result = await pool.query('SELECT * FROM users');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Query error:", err.message);
        res.status(500).json({ error: "Query failed" });
    }
}
