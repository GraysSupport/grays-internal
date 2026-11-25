// lib/wooStockRetry.js — G25 increment 2 (owner, 17 Nov 2026): the "Retry website update"
// button, the daily retry job (Vercel Cron) and the website-status rows the workorder page and
// GS's E-Commerce popup show. Increment 1 is lib/wooStock.js.
//
// What may be sent again — and what never is:
//   pending / failed            → yes (nothing reached the website, or it clearly refused)
//   needs_human, result.action = 'needs_human'
//                               → Retry button only: a lookup said "SKU not on the website",
//                                 "doesn't track stock", etc. Nothing was sent, so once GS fixes
//                                 the website product, Retry is safe.
//   needs_human, result NULL    → NEVER: the update may already be on the website (timeout after
//                                 the request, or stuck mid-send). GS checks it by hand.
//   dry_run                     → NEVER: GS did those by hand during the dry-run week.
//   sent / cancelled            → done.

import { isWooStockSyncEnabled, syncWorkorderWebsiteStock, outboxHasClaimedAt, outboxHasKind } from './wooStock.js';
import { cronGate } from './cronAuth.js';
import { isDriftDay, runWeeklyDriftReport, REPORT_DEADLINE_MS } from './websiteStockView.js';
import { syncCollectionWebsiteStock, outboxHasCollection } from './wooCollection.js'; // G25e2

export const RETRY_MAX_ATTEMPTS = 5;        // daily job gives up after this many refusals
export const STUCK_SENDING_MINUTES = 60;    // a row 'sending' this long never finished
export const FRESH_ROW_MINUTES = 10;        // the save itself is still handling these
export const DEFAULT_JOB_BUDGET_MS = 45000; // vercel.json gives the API function 60 s
export const MONDAY_RETRY_BUDGET_MS = 20000; // Mondays: leave the weekly drift report ~30 s
export const ROW_RESERVE_MS = 11000;        // worst case for one row already started
const CANCELLED = 'Cancelled';              // lib/workorderCancel.js CANCELLED

async function outboxReady(client) {
  const r = await client.query(`SELECT to_regclass('public.woo_stock_outbox') AS t`);
  return Boolean(r.rows?.[0]?.t);
}

async function log(client, workorderId, notes) {
  try {
    await client.query(
      `INSERT INTO workorder_logs (workorder_id, event_type, user_id, notes_log) VALUES ($1, $2, $3, $4)`,
      [workorderId, 'WEBSITE_STOCK_SYNC', 'WB', notes]
    );
  } catch (err) { console.error('woo stock retry: log failed', err?.message); }
}

/** Outbox rows for the given workorders → Map(workorder_id → rows). Empty before migration 0014. */
export async function getWebsiteStockRows(client, workorderIds) {
  const ids = [...new Set((workorderIds || []).map(Number).filter(Number.isInteger))];
  const out = new Map();
  if (!ids.length) return out;
  if (!(await outboxReady(client))) return out;
  // G25e1: with migration 0016 each row also says whether it is a sale or a cancelled item's add-back.
  const hasKind = await outboxHasKind(client);
  const { rows } = await client.query(
    `SELECT workorder_id, id, sku, qty, status, attempts, last_error, result, created_at, sent_at${hasKind ? ', kind, reverses_id' : ''}
       FROM woo_stock_outbox WHERE workorder_id = ANY($1::int[]) ORDER BY id`,
    [ids]
  );
  for (const r of rows) {
    const k = Number(r.workorder_id);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/**
 * A cancelled workorder was reopened: website updates the daily job closed off ('cancelled')
 * are due again. Call INSIDE the reopen transaction; sync after the commit. Rows for items that
 * stay removed are closed again by the sync's live-item check. Returns how many were reopened.
 */
export async function reopenWebsiteStockRows(client, workorderId, { env = process.env } = {}) {
  if (!isWooStockSyncEnabled(env)) return 0;
  if (!(await outboxReady(client))) return 0;
  // G25e1: only SALES come back here — a closed add-back must never be revived (the reopen
  // takes sent add-backs again through lib/wooRestock.js retakeWebsiteStock instead).
  const hasKind = await outboxHasKind(client);
  const r = await client.query(
    hasKind
      ? `UPDATE woo_stock_outbox SET status = 'pending', last_error = NULL WHERE workorder_id = $1 AND status = 'cancelled' AND kind = 'decrease'`
      : `UPDATE woo_stock_outbox SET status = 'pending', last_error = NULL WHERE workorder_id = $1 AND status = 'cancelled'`,
    [workorderId]
  );
  return r.rowCount || 0;
}

/**
 * "Retry website update" (GS / superadmin / marketing lead — the caller checks who).
 * @returns {{ok:true, summary?, reopened:number, nothingToRetry?:true} | {ok:false, status:number, error:string}}
 */
export async function retryWorkorderWebsiteStock(client, workorderId, { env = process.env, actorId = '', sync } = {}) {
  if (!isWooStockSyncEnabled(env)) return { ok: false, status: 409, error: 'Website stock sync is switched off' };
  if (!(await outboxReady(client))) return { ok: false, status: 409, error: 'Website stock sync is not set up on this database yet' };

  const wo = await client.query(`SELECT status::text AS status FROM workorder WHERE workorder_id = $1`, [workorderId]);
  if (!wo.rowCount) return { ok: false, status: 404, error: 'Workorder not found' };
  if (wo.rows[0].status === CANCELLED) {
    // G25e1: a cancelled workorder may still have add-backs (cancelled items) to send.
    const hasKind = await outboxHasKind(client);
    // Counts add-backs Retry can send: unsent ones, and ones a lookup / the typo guard handed to
    // a human (nothing was sent, so the reopen below makes them sendable again).
    const adds = hasKind
      ? await client.query(
        `/* g25e:open-adds */ SELECT COUNT(*)::int AS n FROM woo_stock_outbox
          WHERE workorder_id = $1 AND kind = 'increase'
            AND (status IN ('pending', 'failed') OR (status = 'needs_human' AND result->>'action' = 'needs_human'))`,
        [workorderId]
      )
      : null;
    if (!Number(adds?.rows?.[0]?.n)) return { ok: false, status: 409, error: 'This workorder is cancelled — there is nothing to take off the website' };
  }

  // Lookups that needed a human sent nothing, so they are safe to try again.
  const reopened = await client.query(
    `UPDATE woo_stock_outbox SET status = 'failed'
      WHERE workorder_id = $1 AND status = 'needs_human' AND result->>'action' = 'needs_human'
      RETURNING id, sku`,
    [workorderId]
  );
  const open = await client.query(
    `SELECT COUNT(*)::int AS n FROM woo_stock_outbox WHERE workorder_id = $1 AND status IN ('pending', 'failed')`,
    [workorderId]
  );
  if (!Number(open.rows?.[0]?.n)) return { ok: true, reopened: 0, nothingToRetry: true };

  await log(client, workorderId, `Retry website update requested by ${String(actorId || '?').toUpperCase()}`);
  const run = sync || ((c, id) => syncWorkorderWebsiteStock(c, id, { env }));
  const summary = await run(client, Number(workorderId));
  return { ok: true, reopened: reopened.rowCount || 0, summary };
}

/**
 * The daily job (Vercel Cron → /api/website-stock-cron). Best-effort, never throws.
 * Housekeeping first (stuck rows, cancelled workorders, repeated refusals), then a normal sync
 * for every workorder that still has unsent rows, oldest first, inside the time budget.
 */
export async function runWebsiteStockRetryJob(client, {
  env = process.env, sync, syncCollection, budgetMs = Number(env?.WOO_RETRY_BUDGET_MS) || DEFAULT_JOB_BUDGET_MS,
  maxAttempts = RETRY_MAX_ATTEMPTS, limit = 50,
} = {}) {
  const deadline = Date.now() + budgetMs;
  const s = { skipped: false, workorders: 0, collections: 0, sent: 0, dryRun: 0, failed: 0, needsHuman: 0, ticked: 0, stuck: 0, cancelled: 0, gaveUp: 0, errors: 0, leftForTomorrow: false };
  if (!isWooStockSyncEnabled(env)) return { ...s, skipped: true };
  try {
    if (!(await outboxReady(client))) return { ...s, skipped: true };

    // 1. Claimed but never finished — the website may or may not have changed.
    //    G25d: measured from the claim (claimed_at, migration 0015), so a days-old row that is
    //    being sent right now isn't reported as stuck. Rows claimed before 0015 (claimed_at NULL)
    //    and databases without the column fall back to created_at — the old rule.
    const hasClaimedAt = await outboxHasClaimedAt(client); // once per run, handed to every sync
    const hasKind = await outboxHasKind(client); // G25e1: sales vs cancelled items' add-backs
    const stuck = await client.query(
      hasClaimedAt
        ? `UPDATE woo_stock_outbox SET status = 'needs_human', result = NULL, last_error = $1
            WHERE status = 'sending' AND COALESCE(claimed_at, created_at) < NOW() - make_interval(mins => $2)
            RETURNING id, workorder_id, sku`
        : `UPDATE woo_stock_outbox SET status = 'needs_human', result = NULL, last_error = $1
            WHERE status = 'sending' AND created_at < NOW() - make_interval(mins => $2)
            RETURNING id, workorder_id, sku`,
      ["The website update didn't finish — check the stock by hand", STUCK_SENDING_MINUTES]
    );
    // G25e2: collection rows have no workorder — their status line on the collection page says it.
    for (const r of stuck.rows) if (r.workorder_id != null) await log(client, r.workorder_id, `Website stock for ${r.sku}: the update didn't finish, so it may or may not be on the website — check the stock by hand`);
    s.stuck = stuck.rowCount || 0;

    // 2a. Workorder deleted (no FK on the outbox): nothing was sold. No log — the workorder is gone.
    const orphans = await client.query(
      `UPDATE woo_stock_outbox o SET status = 'cancelled', last_error = $1
        WHERE o.status IN ('pending', 'failed') AND o.workorder_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM workorder w WHERE w.workorder_id = o.workorder_id)
        RETURNING o.id, o.workorder_id, o.sku`,
      ['Workorder deleted before the website was updated — nothing sent']
    );
    s.cancelled += orphans.rowCount || 0;

    // 2a'. G25e2: collection deleted — its waiting rows are never sent (review #1).
    if (await outboxHasCollection(client)) {
      const collOrphans = await client.query(
        `/* g25e2:orphans */ UPDATE woo_stock_outbox o SET status = 'cancelled', last_error = $1
          WHERE o.status IN ('pending', 'failed') AND o.collection_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.id = o.collection_id)
          RETURNING o.id`,
        ['Collection deleted before the website was updated — nothing sent']
      );
      s.cancelled += collOrphans.rowCount || 0;
    }

    // 2b. Cancelled before the website was updated: nothing to take off.
    //     G25e1: only SALES — a cancelled workorder's add-backs still have to go out.
    const cancelled = await client.query(
      hasKind
        ? `/* g25e:close-cancelled-wo */ UPDATE woo_stock_outbox o SET status = 'cancelled', last_error = $1
             FROM workorder w
            WHERE w.workorder_id = o.workorder_id AND w.status::text = $2 AND o.status IN ('pending', 'failed') AND o.kind = 'decrease'
            RETURNING o.id, o.workorder_id, o.sku`
        : `UPDATE woo_stock_outbox o SET status = 'cancelled', last_error = $1
         FROM workorder w
        WHERE w.workorder_id = o.workorder_id AND w.status::text = $2 AND o.status IN ('pending', 'failed')
        RETURNING o.id, o.workorder_id, o.sku`,
      ['Workorder cancelled before the website was updated — nothing sent', CANCELLED]
    );
    for (const r of cancelled.rows) await log(client, r.workorder_id, `Website stock for ${r.sku}: not sent — the workorder was cancelled first`);
    s.cancelled += cancelled.rowCount || 0;

    // 3. The website keeps refusing → stop retrying, hand to GS (still re-openable by Retry:
    //    a refusal means nothing was applied).
    const gaveUp = await client.query(
      `UPDATE woo_stock_outbox SET status = 'needs_human', result = $3::jsonb,
              last_error = CASE WHEN last_error LIKE 'Gave up after%' THEN last_error ELSE $1 || COALESCE(last_error, '') END
        WHERE status = 'failed' AND attempts >= $2
        RETURNING id, workorder_id, sku`,
      [`Gave up after ${maxAttempts} tries: `, maxAttempts, JSON.stringify({ action: 'needs_human', gave_up: true })]
    );
    for (const r of gaveUp.rows) if (r.workorder_id != null) await log(client, r.workorder_id, `Website stock NOT updated for ${r.sku}: the website refused it ${maxAttempts} times — update by hand (or fix it and press Retry)`);
    s.gaveUp = gaveUp.rowCount || 0;

    // 4. Everything still unsent, oldest first. Rows saved in the last few minutes belong to
    //    the save that created them.
    //    G25e1: a cancelled workorder's add-backs are due too.
    const due = await client.query(
      hasKind
        ? `/* g25e:due */ SELECT o.workorder_id FROM woo_stock_outbox o
             JOIN workorder w ON w.workorder_id = o.workorder_id
            WHERE o.status IN ('pending', 'failed') AND (w.status::text <> $3 OR o.kind = 'increase')
              AND o.created_at < NOW() - make_interval(mins => $1)
            GROUP BY o.workorder_id ORDER BY MIN(o.id) LIMIT $2`
        : `SELECT o.workorder_id FROM woo_stock_outbox o
         JOIN workorder w ON w.workorder_id = o.workorder_id
        WHERE o.status IN ('pending', 'failed') AND w.status::text <> $3
          AND o.created_at < NOW() - make_interval(mins => $1)
        GROUP BY o.workorder_id ORDER BY MIN(o.id) LIMIT $2`,
      [FRESH_ROW_MINUTES, limit, CANCELLED]
    );
    const run = sync || ((c, id, opts) => syncWorkorderWebsiteStock(c, id, { env, ...opts }));
    for (const { workorder_id: id } of due.rows) {
      // A row already started can take up to ~10 s (lookup + update, 5 s timeout each), so a
      // new one only starts with that much time in hand — the function is never cut off mid-send.
      const left = deadline - Date.now();
      if (left < ROW_RESERVE_MS + 1000) { s.leftForTomorrow = true; break; }
      s.workorders += 1;
      try {
        const r = (await run(client, Number(id), { budgetMs: left - ROW_RESERVE_MS, hasClaimedAt })) || {};
        s.sent += r.sent || 0; s.dryRun += r.dryRun || 0; s.failed += r.failed || 0; s.needsHuman += r.needsHuman || 0;
        if (r.ticked) s.ticked += 1;
      } catch (err) {
        s.errors += 1;
        console.error('woo stock retry: workorder failed', id, err?.message);
      }
    }

    // 5. G25e2: collections sent with "Apply Stock to Website" that still have rows waiting.
    if (!s.leftForTomorrow && (await outboxHasCollection(client))) {
      const dueColl = await client.query(
        `/* g25e2:due-collections */ SELECT collection_id FROM woo_stock_outbox
          WHERE collection_id IS NOT NULL AND status IN ('pending', 'failed')
            AND created_at < NOW() - make_interval(mins => $1)
          GROUP BY collection_id ORDER BY MIN(id) LIMIT $2`,
        [FRESH_ROW_MINUTES, limit]
      );
      const runColl = syncCollection || ((c, cid, opts) => syncCollectionWebsiteStock(c, cid, { env, ...opts }));
      for (const { collection_id: cid } of dueColl.rows) {
        const left = deadline - Date.now();
        if (left < ROW_RESERVE_MS + 1000) { s.leftForTomorrow = true; break; }
        s.collections += 1;
        try {
          const r = (await runColl(client, Number(cid), { budgetMs: left - ROW_RESERVE_MS })) || {};
          s.sent += (r.sent || 0) + (r.drafts || 0); s.dryRun += r.dryRun || 0; s.failed += r.failed || 0; s.needsHuman += r.needsHuman || 0;
        } catch (err) {
          s.errors += 1;
          console.error('woo stock retry: collection failed', cid, err?.message);
        }
      }
    }
  } catch (err) {
    s.errors += 1;
    console.error('woo stock retry job failed:', err?.message || err);
  }
  return s;
}

/**
 * GET /api/website-stock-cron — the daily job. CRON_SECRET-checked (lib/cronAuth.js).
 * G25c: on Mondays (Melbourne) it also writes the weekly website drift report — read-only
 * toward the website — AFTER the retries, inside what is left of the 60 s function.
 * (One cron instead of two: Vercel Hobby cron allowance not confirmed, owner decision default.)
 */
export async function handleWebsiteStockCron(req, res, {
  getClient, env = process.env, run = runWebsiteStockRetryJob,
  now = new Date(), driftReport = runWeeklyDriftReport,
} = {}) {
  const gate = cronGate(req, env);
  if (!gate.ok) {
    if (gate.allow) res.setHeader('Allow', gate.allow);
    return res.status(gate.status).json({ error: gate.error });
  }
  // The clock starts on entry, before the database connection (review 25 Nov 2026).
  const started = Date.now();
  const client = await getClient();
  try {
    // Stock writes first; the optional report gets what is left of the 60 s function (it stops
    // starting website reads near the deadline → stored as 'partial'). 25 Nov 2026: on Mondays the
    // retries are capped (leftovers go next day) so the report has time to read the website — with
    // the full 45 s it was left ~10 s and 765 of 965 products went unread.
    const fullBudget = Number(env?.WOO_RETRY_BUDGET_MS) || DEFAULT_JOB_BUDGET_MS;
    const driftDay = isDriftDay(now);
    const result = await run(client, { env, budgetMs: driftDay ? Math.min(fullBudget, MONDAY_RETRY_BUDGET_MS) : fullBudget });
    console.log('woo stock retry job:', JSON.stringify(result));
    let drift;
    if (driftDay) {
      drift = await driftReport(client, { env, deadline: started + REPORT_DEADLINE_MS });
      console.log('website drift report:', JSON.stringify(drift));
    }
    return res.status(200).json({ ok: true, ...result, ...(drift ? { drift } : {}) });
  } finally {
    client.release();
  }
}
