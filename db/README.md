# Database migrations

Plain-SQL, forward + rollback migrations for the Grays Internal portal, run by a
tiny Node runner (`db/migrate.js`, pg + ESM — same style as `lib/db.js`).

## Layout

```
db/
  migrate.js                    runner (up / status / down)
  migrations/
    0001_podium.sql             forward migration
    0001_podium_down.sql        paired rollback
```

Each forward migration is **additive and idempotent** (`IF NOT EXISTS`, `DO`-guarded
`CREATE TYPE`) and ships with a paired `_down.sql`. Applied versions are tracked in a
`schema_migrations` table, so re-running is a safe no-op.

## Running

Set `DATABASE_URL` to the **Neon dev/preview branch** — never the production/default
branch. The runner reads it from the environment (a local `.env` works via dotenv).

```bash
npm run migrate           # apply all pending migrations
npm run migrate:status    # show applied vs pending
npm run migrate:down 0001_podium   # roll back one migration
```

## Conventions

- Number migrations `NNNN_<slug>.sql`; add a matching `NNNN_<slug>_down.sql`.
- Additive only; never drop/alter existing columns destructively in a forward file.
- New Podium API routes live under `api/podium/` (and `api/leads.js`), not the
  `api/[...path].js` catch-all.
- No chat message bodies are ever stored (P1): `integration_sync_log.payload` holds
  envelope metadata only.
