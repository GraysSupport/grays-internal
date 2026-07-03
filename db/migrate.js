#!/usr/bin/env node
/**
 * Tiny forward/rollback SQL migration runner for the Grays Internal portal.
 *
 * Usage:
 *   node db/migrate.js up            # apply all pending *.sql (excluding *_down.sql)
 *   node db/migrate.js status        # list applied vs pending
 *   node db/migrate.js down <ver>    # run <ver>_down.sql and un-record it (e.g. 0001_podium)
 *
 * Reads DATABASE_URL from the environment (dotenv-friendly via a local .env).
 * IMPORTANT: point DATABASE_URL at the Neon dev/preview branch — NEVER the
 * production/default branch. Each migration runs inside a transaction and its
 * version is recorded in schema_migrations, so re-runs are safe no-ops.
 *
 * Matches the repo's pg + ESM style (see lib/db.js).
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const versionOf = (file) => file.replace(/\.sql$/, '');

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_down.sql'))
    .sort();
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function appliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

async function runInTx(client, sql, after) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    if (after) await after();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function up(pool) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await appliedVersions(client);
    const pending = migrationFiles().filter((f) => !done.has(versionOf(f)));
    if (pending.length === 0) {
      console.log('Nothing to apply — schema up to date.');
      return;
    }
    for (const file of pending) {
      const version = versionOf(file);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Applying ${file} ...`);
      await runInTx(client, sql, () =>
        client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version])
      );
      console.log(`  ✓ ${version}`);
    }
  } finally {
    client.release();
  }
}

async function down(pool, version) {
  if (!version) throw new Error('Usage: node db/migrate.js down <version>   e.g. 0001_podium');
  const sql = readFileSync(join(MIGRATIONS_DIR, `${version}_down.sql`), 'utf8');
  const client = await pool.connect();
  try {
    await ensureTable(client);
    console.log(`Rolling back ${version}_down.sql ...`);
    await runInTx(client, sql, () =>
      client.query('DELETE FROM schema_migrations WHERE version = $1', [version])
    );
    console.log(`  ✓ rolled back ${version}`);
  } finally {
    client.release();
  }
}

async function status(pool) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await appliedVersions(client);
    for (const file of migrationFiles()) {
      const version = versionOf(file);
      console.log(`${done.has(version) ? '[applied]' : '[pending]'} ${version}`);
    }
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at the Neon dev/preview branch, never production.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'down') await down(pool, arg);
    else if (cmd === 'status') await status(pool);
    else await up(pool); // default: `up`
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
