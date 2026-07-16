// lib/handlers/integrations.js — Integration observability (feature F10).
//
// `integration_sync_log` is the audit trail every Podium integration writes to: the F2
// webhook receiver dedupes inbound events on it, and the F8 automations (waitlist
// back-in-stock, delivery-booked, review-request) claim + record every outbound send
// there. Until now nothing SURFACED it — a failed customer SMS was invisible unless you
// opened a SQL console. This is the superadmin-facing read of that table (execution-plan
// §F10), plus the health summary that answers the only question ops actually has:
// "is anything failing?"
//
// Routed through the api/[...path].js catch-all as an `integrations` case (NO new file
// under api/ — Vercel Hobby function cap). Front-end calls the QUERY form
// (`?resource=sync-log`) because Vercel platform-404s multi-segment paths into the
// catch-all (F6/F7a/F7b all hit this); the path form is accepted too.
//
// Read-only. Gated to superadmin via the login JWT (getAuthUser + hasAnyRole) — the
// server is the authority, the nav link is only cosmetic.
//
// P1: this READS the audit log, which by construction holds envelope metadata only —
// ids, SKUs, event types. No message body was ever written there (F2/F8 guarantee it),
// so surfacing `payload` cannot leak chat content.

import { getClientWithTimezone } from '../db.js';
import { getAuthUser, hasAnyRole } from '../rbac.js';

const ALLOWED_ROLES = ['superadmin'];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** Clamp the caller's limit: junk → default, absurd → MAX (never an unbounded scan). */
export function resolveLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// sub = the path segments AFTER "integrations" (e.g. ['sync-log']).
// deps.getClient lets the offline smoke inject a fake pg client (default = real pool).
export default async function handler(req, res, sub = [], deps = {}) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the superadmin role to view integrations' });
  }

  const seg = Array.isArray(sub) ? sub[0] : undefined;
  const resource = (seg || req.query?.resource || '').toString();

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed for this integrations route' });
  }
  if (resource !== 'sync-log') {
    return res.status(404).json({ error: 'Unknown integrations resource' });
  }

  const { source, status, event_type: eventType, q } = req.query || {};

  // Build the filter once; both the list and the summary run over the SAME predicate, so
  // the tiles always describe the rows on screen rather than the whole table.
  const where = [];
  const params = [];
  if (source) { params.push(String(source)); where.push(`source = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  if (eventType) { params.push(String(eventType)); where.push(`event_type = $${params.length}`); }
  if (q) {
    // Reference/error free-text. Bound as a parameter — never interpolated.
    params.push(`%${String(q)}%`);
    where.push(`(reference_id ILIKE $${params.length} OR error ILIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();
  try {
    // Health tiles. Ops only ever needs "how many are broken" — a failed row means a
    // customer did NOT get their text (F8 is at-most-once, so nothing retries it).
    const summaryRes = await client.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'sent')    AS sent,
              count(*) FILTER (WHERE status = 'failed')  AS failed,
              count(*) FILTER (WHERE status = 'pending') AS pending,
              count(*) FILTER (WHERE status = 'skipped') AS skipped
         FROM integration_sync_log
         ${whereSql}`,
      params
    );
    const s = summaryRes.rows[0] || {};
    const summary = {
      total: Number(s.total || 0),
      sent: Number(s.sent || 0),
      failed: Number(s.failed || 0),
      pending: Number(s.pending || 0),
      skipped: Number(s.skipped || 0),
    };

    const limit = resolveLimit(req.query?.limit);
    const rowsRes = await client.query(
      `SELECT id, source, direction, event_type, reference_id, status, payload, error, created_at
         FROM integration_sync_log
         ${whereSql}
        ORDER BY id DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    return res.status(200).json({ rows: rowsRes.rows, summary, limit });
  } catch (err) {
    // integration_sync_log absent (a DB that hasn't run the F0 migration) — degrade to an
    // empty page rather than 500 the ops screen.
    if (err?.code === '42P01') {
      return res.status(200).json({
        rows: [],
        summary: { total: 0, sent: 0, failed: 0, pending: 0, skipped: 0 },
        limit: resolveLimit(req.query?.limit),
        unavailable: true,
      });
    }
    console.error('Integrations API error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
