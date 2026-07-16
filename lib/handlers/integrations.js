// lib/handlers/integrations.js — Integration observability (feature F10).
//
// `integration_sync_log` is the audit trail every Podium integration writes to. Until now
// nothing SURFACED it — a failed customer SMS was invisible unless you opened a SQL
// console. This is the superadmin-facing read of that table (execution-plan §F10), plus
// the health summary that answers the only question ops actually has: "is anything
// failing?"
//
// Writers, and their status vocabularies (they differ by direction — the summary counts
// BOTH, or the tiles wouldn't add up to the total):
//   • F2 webhook receiver — INBOUND, dedupes on the Podium event uid:
//       'received' (insert default) → 'processed' | 'failed'
//   • F8a waitlist back-in-stock — OUTBOUND: 'pending' → 'sent' | 'failed' | 'skipped'
//   • F8b delivery-booked (`delivery.booked`) and F8c review-request
//     (`workorder.review_request`) use the same outbound pattern — both are on OPEN PRs
//     (#72, #73) and land here once merged; today only F8a and the webhook write.
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

/** Escape LIKE metacharacters so user text matches literally (paired with ESCAPE '\'). */
export function escapeLike(s) {
  return String(s).replace(/([\\%_])/g, '\\$1');
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

  // The BASE predicate (everything except status) drives the SUMMARY; the list adds the
  // status filter on top. Keeping status out of the summary is deliberate: the tiles are
  // also the filter buttons, so if status narrowed them too, clicking "Failed" would zero
  // out every other tile and destroy the health picture the user opened the page for.
  const baseWhere = [];
  const baseParams = [];
  if (source) { baseParams.push(String(source)); baseWhere.push(`source = $${baseParams.length}`); }
  if (eventType) { baseParams.push(String(eventType)); baseWhere.push(`event_type = $${baseParams.length}`); }
  if (q) {
    // Reference/error free-text. Bound as a parameter — never interpolated. `%` and `_`
    // are escaped so a literal underscore in a reference (they're full of them, e.g.
    // waitlist_back_in_stock:12) matches itself instead of any character.
    baseParams.push(`%${escapeLike(String(q))}%`);
    baseWhere.push(`(reference_id ILIKE $${baseParams.length} ESCAPE '\\' OR error ILIKE $${baseParams.length} ESCAPE '\\')`);
  }
  const baseWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';

  // The LIST predicate = base + status.
  const listWhere = [...baseWhere];
  const listParams = [...baseParams];
  if (status) { listParams.push(String(status)); listWhere.push(`status = $${listParams.length}`); }
  const listWhereSql = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : '';

  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();
  try {
    // Health tiles. Ops only ever needs "how many are broken" — a failed row means a
    // customer did NOT get their text (F8 is at-most-once, so nothing retries it).
    //
    // Both directions are counted, because both write here with DIFFERENT vocabularies:
    //   outbound (F8 automations): pending → sent | failed | skipped
    //   inbound  (F2 webhook):     received → processed | failed
    // Counting only the outbound four would leave every inbound row inside `total` but
    // in no bucket, so the tiles wouldn't add up to Total. `other` catches any status a
    // future writer invents, so Total always reconciles.
    const summaryRes = await client.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'sent')      AS sent,
              count(*) FILTER (WHERE status = 'failed')    AS failed,
              count(*) FILTER (WHERE status = 'pending')   AS pending,
              count(*) FILTER (WHERE status = 'skipped')   AS skipped,
              count(*) FILTER (WHERE status = 'received')  AS received,
              count(*) FILTER (WHERE status = 'processed') AS processed
         FROM integration_sync_log
         ${baseWhereSql}`,
      baseParams
    );
    const s = summaryRes.rows[0] || {};
    const summary = {
      total: Number(s.total || 0),
      sent: Number(s.sent || 0),
      failed: Number(s.failed || 0),
      pending: Number(s.pending || 0),
      skipped: Number(s.skipped || 0),
      received: Number(s.received || 0),
      processed: Number(s.processed || 0),
    };
    summary.other = Math.max(0, summary.total - (summary.sent + summary.failed + summary.pending
      + summary.skipped + summary.received + summary.processed));

    const limit = resolveLimit(req.query?.limit);
    const rowsRes = await client.query(
      `SELECT id, source, direction, event_type, reference_id, status, payload, error, created_at
         FROM integration_sync_log
         ${listWhereSql}
        ORDER BY id DESC
        LIMIT $${listParams.length + 1}`,
      [...listParams, limit]
    );

    // `matching` = how many rows the LIST filter actually matches (the summary is
    // status-agnostic, so it can't answer this). The page needs it to say "showing the
    // most recent 100 of 1,234" rather than silently truncating.
    const matchingRes = await client.query(
      `SELECT count(*) AS n FROM integration_sync_log ${listWhereSql}`,
      listParams
    );
    const matching = Number(matchingRes.rows[0]?.n || 0);

    return res.status(200).json({ rows: rowsRes.rows, summary, limit, matching });
  } catch (err) {
    // integration_sync_log absent (a DB that hasn't run the F0 migration) — degrade to an
    // empty page rather than 500 the ops screen.
    if (err?.code === '42P01') {
      return res.status(200).json({
        rows: [],
        summary: { total: 0, sent: 0, failed: 0, pending: 0, skipped: 0, received: 0, processed: 0, other: 0 },
        limit: resolveLimit(req.query?.limit),
        matching: 0,
        unavailable: true,
      });
    }
    console.error('Integrations API error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
