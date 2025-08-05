import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Wrapper to get a client with Melbourne time zone
export async function getClientWithTimezone() {
  const client = await pool.connect();
  await client.query("SET TIME ZONE 'Australia/Melbourne'");
  return client;
}
