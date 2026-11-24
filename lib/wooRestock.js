// lib/wooRestock.js — G25e1 (owner's back-in-stock rules, 19 Nov 2026): a cancelled workorder
// item puts its quantity back on the website, live, at the moment of the cancel.
// Plan: feature-plan-stock-sync-2026-11-06.md § G25e / G25e1 (defaults E-D1–E-D4).
//
// Only what the website actually LOST is given back (E-D1) — decided from that item's own sale
// row in woo_stock_outbox (the decrease):
//   sent (decrease / soldout)        → queue an add-back (kind 'increase', reverses_id = the sale)
//   sent, needed a check by hand     → flag GS ("add it back by hand")
//   website order (salesperson WB, or → given back too (owner, 25 Nov 2026 — replaces E-D2): the
//   a sale recorded as none /            website order itself took the stock, so the add-back is
//   soldout_only)                        queued whatever the portal's own row says (sent, dry run,
//                                        pending, closed or no row), marked result.website_order
//                                        so a dry-run sale row never holds it as a dry run.
//                                        Uncertain rows (needs_human / sending) still flag GS.
//   dry_run                          → add-back queued as a dry run: "would add N back" (GS did
//                                       the sale by hand in the dry-run week)
//   pending / failed                 → nothing reached the website: the sale row is closed off
//   needs_human (lookup refused,
//   typo guard, gave up)             → closed off, and GS flagged: they were told to reduce it
//                                       by hand, so they add it back by hand
//   needs_human (unknown) / sending  → flag GS, never automatic
//   no row at all (E-D1b)            → E-Commerce ticked (GS reduced it by hand) → add back;
//                                       not ticked → flag GS
// A flagged add-back is an outbox row with status needs_human and result.action 'manual' (the
// Retry button never re-opens it), plus a workorder log line, and the E-Commerce flag is
// unticked so GS's popup shows it.
//
// Reopen (E-D4): retakeWebsiteStock() takes an add-back again exactly once — a sent add-back
// gets one new decrease (reverses_id = the add-back); one not sent yet is simply closed.
//
// Everything here runs INSIDE the workorder transaction; the after-commit sync
// (lib/wooStock.js syncWorkorderWebsiteStock) does the website calls. Without migration 0016
// (woo_stock_outbox.kind) nothing is added back — GS is flagged in the log instead.

import { isWooStockSyncEnabled, skipSalespeople, outboxHasKind } from './wooStock.js';

async function outboxReady(client) {
  const r = await client.query(`SELECT to_regclass('public.woo_stock_outbox') AS t`);
  return Boolean(r.rows?.[0]?.t);
}

async function log(client, workorderId, notes) {
  await client.query(
    `INSERT INTO workorder_logs (workorder_id, event_type, user_id, notes_log) VALUES ($1, $2, $3, $4)`,
    [workorderId, 'WEBSITE_STOCK_SYNC', 'WB', notes]
  );
}

const parse = (r) => {
  if (r == null) return null;
  if (typeof r === 'string') { try { return JSON.parse(r); } catch { return null; } }
  return r;
};

const stockItems = (items) => (Array.isArray(items) ? items : [])
  .filter((it) => it && !it.is_custom && it.product_id && Number(it.quantity) > 0)
  .map((it) => ({ sku: String(it.product_id), qty: Number(it.quantity) }));

async function insertRow(client, { workorderId, sku, qty, kind, reversesId = null, status = 'pending', result = null, error = null }) {
  await client.query(
    `/* g25e:insert */ INSERT INTO woo_stock_outbox (workorder_id, sku, qty, kind, reverses_id, status, result, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [workorderId, sku, qty, kind, reversesId, status, result == null ? null : JSON.stringify(result), error]
  );
}

async function closeRow(client, id, reason, { alsoNeedsHuman = false } = {}) {
  const r = await client.query(
    alsoNeedsHuman
      ? `/* g25e:close-row */ UPDATE woo_stock_outbox SET status = 'cancelled', last_error = $2 WHERE id = $1 AND status IN ('pending', 'failed', 'needs_human')`
      : `/* g25e:close-row */ UPDATE woo_stock_outbox SET status = 'cancelled', last_error = $2 WHERE id = $1 AND status IN ('pending', 'failed')`,
    [id, reason]
  );
  return r.rowCount || 0;
}

/**
 * INSIDE the transaction that cancels items (item → Canceled, delete_item_ids, whole-workorder
 * cancel). `items`: the cancelled items [{ product_id, quantity, is_custom }].
 * @returns {Promise<number>} add-backs queued for the after-commit sync
 */
export async function queueWebsiteAddBack(client, { workorderId, items, salesperson, ecommerce }, { env = process.env } = {}) {
  if (!isWooStockSyncEnabled(env)) return 0;
  const list = stockItems(items);
  if (!list.length) return 0;
  if (!(await outboxReady(client))) return 0;
  const woId = Number(workorderId);

  const isWebsiteOrder = skipSalespeople(env).has(String(salesperson ?? '').trim().toUpperCase());
  const websiteSale = (res) => res.action === 'none' || res.action === 'soldout_only';

  if (!(await outboxHasKind(client))) {
    // Before migration 0016 nothing is added back automatically. The hand instruction still
    // depends on what this item's sale did on the website (review #4): a sale that never went
    // out needs nothing — except a website order, whose stock the website itself took (owner,
    // 25 Nov 2026), so GS adds that back by hand too.
    for (const it of list) {
      const r = await client.query(
        `/* g25e:legacy-sale */ SELECT id, status, result FROM woo_stock_outbox WHERE workorder_id = $1 AND sku = $2 ORDER BY id DESC LIMIT 1`,
        [woId, it.sku]
      );
      const sale = r.rows?.[0];
      const res = parse(sale?.result) || {};
      const webOrder = isWebsiteOrder || websiteSale(res);
      // The website was never reduced — unless it was a website order, which took the stock itself.
      if (!webOrder && sale && ['pending', 'failed', 'cancelled'].includes(sale.status)) continue;
      await log(client, woId, `Back-in-stock: ${it.sku} ×${it.qty} cancelled — add it back on the website by hand (database update 0016 not applied yet, so nothing is added back automatically)`);
    }
    return 0;
  }

  let queued = 0;
  let flagged = false;
  const flag = async (it, reason, reversesId = null) => {
    await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'increase', reversesId, status: 'needs_human', result: { action: 'manual' }, error: reason });
    await log(client, woId, `Website stock NOT added back for ${it.sku} ×${it.qty}: ${reason}`);
    flagged = true;
  };
  // A website order's stock was taken by the website itself — give it back (owner, 25 Nov 2026).
  const giveBackWebsiteOrder = async (it, sale) => {
    if (sale && ['pending', 'failed'].includes(sale.status)) {
      await closeRow(client, sale.id, 'Website order cancelled before the portal recorded it — nothing sent');
    }
    await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'increase', reversesId: sale?.id ?? null, result: { website_order: true } });
    queued += 1;
  };

  for (const it of list) {
    // This item's sale: the newest not-yet-given-back decrease for this SKU (live rows first,
    // an exact quantity match first). Rows have no workorder_items_id, so matching is per SKU.
    // Live rows first, an exact quantity match first, then the newest.
    const cand = await client.query(
      `/* g25e:decrease-candidate */ SELECT o.id, o.qty, o.status, o.result, o.reverses_id FROM woo_stock_outbox o
        WHERE o.workorder_id = $1 AND o.sku = $2 AND o.kind = 'decrease'
          AND NOT EXISTS (SELECT 1 FROM woo_stock_outbox i WHERE i.reverses_id = o.id AND i.status <> 'cancelled')
        ORDER BY (o.status = 'cancelled') ASC, (o.qty = $3) DESC, o.id DESC
        LIMIT 1 FOR UPDATE`,
      [woId, it.sku, it.qty]
    );
    const sale = cand.rows?.[0];

    if (!sale) {
      // A SALE exists but every one is already given back → nothing left to add. (Only sales
      // count: an earlier add-back or flag closed by a restore says nothing — review #2.)
      const any = await client.query(`/* g25e:any-row */ SELECT id FROM woo_stock_outbox WHERE workorder_id = $1 AND sku = $2 AND kind = 'decrease' LIMIT 1`, [woId, it.sku]);
      if (any.rowCount) continue;
      if (isWebsiteOrder) { await giveBackWebsiteOrder(it, null); continue; }
      // E-D1b: workorder from before G25 went live.
      if (ecommerce === true) {
        await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'increase' });
        queued += 1;
      } else {
        await flag(it, "no website record for this sale and the E-Commerce flag isn't ticked — update the website by hand");
      }
      continue;
    }

    const res = parse(sale.result) || {};
    // A website order is decided by what the SALE row recorded (review 25 Nov #3): once the
    // website answered, its action says it (none / soldout_only); the salesperson now only decides
    // for a row the website never answered. A retake (reverses_id set — the portal's own decrease
    // after a reopen) is never a website sale: it takes the normal path (review 25 Nov #1).
    const uncertain = sale.status === 'needs_human' || sale.status === 'sending';
    const isSale = sale.reverses_id == null;
    const answered = res.action != null;
    const webOrder = isSale && !uncertain && (answered ? websiteSale(res) : isWebsiteOrder);
    if (webOrder) { await giveBackWebsiteOrder(it, sale); continue; }
    switch (sale.status) {
      case 'cancelled':
        break; // never reached the website — nothing to add
      case 'pending':
      case 'failed':
        await closeRow(client, sale.id, 'Item cancelled before the website was updated — nothing sent');
        await log(client, woId, `Website stock for ${it.sku}: nothing to add back — the website was never reduced for this item`);
        break;
      case 'needs_human':
        if (res.action === 'needs_human') {
          // Nothing was sent automatically (lookup refused / typo guard / gave up) — but GS was
          // told to reduce the website by hand, so GS is told to add it back too (E-D1, review #3).
          await closeRow(client, sale.id, 'Item cancelled — this sale was never sent to the website automatically', { alsoNeedsHuman: true });
          await flag(it, 'this sale was handed to you to do by hand — if you reduced the website for it, add it back by hand', sale.id);
        } else {
          await flag(it, 'the website update for this sale may or may not have gone through — check the stock and add it back by hand', sale.id);
        }
        break;
      case 'sending':
        await flag(it, 'the website update for this sale was still in progress — check the stock and add it back by hand', sale.id);
        break;
      case 'dry_run':
        await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'increase', reversesId: sale.id, result: { reverses_status: 'dry_run' } });
        queued += 1;
        break;
      case 'sent':
        if (res.check) { await flag(it, 'the sale needed a check by hand (the website showed less than was sold) — add it back by hand', sale.id); break; }
        await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'increase', reversesId: sale.id });
        queued += 1;
        break;
      default:
        await flag(it, `unexpected website status "${sale.status}" — check by hand`, sale.id);
    }
  }

  if (flagged) {
    await client.query(`/* g25e:untick */ UPDATE workorder SET ecommerce = FALSE WHERE workorder_id = $1 AND ecommerce IS TRUE`, [woId]);
  }
  return queued;
}

/**
 * E-D4 — INSIDE the transaction that brings cancelled items back (workorder reopen, or an item
 * set back from Canceled). Each restored item's add-back is taken again exactly once.
 * Sales closed off by the cancel are re-queued separately by reopenWebsiteStockRows()
 * (whole workorder) or here with `reopenClosedSale` (single item).
 * @returns {Promise<number>} rows queued for the after-commit sync
 */
export async function retakeWebsiteStock(client, { workorderId, items }, { env = process.env, reopenClosedSale = false } = {}) {
  if (!isWooStockSyncEnabled(env)) return 0;
  const list = stockItems(items);
  if (!list.length) return 0;
  if (!(await outboxReady(client))) return 0;
  if (!(await outboxHasKind(client))) return 0;
  const woId = Number(workorderId);
  let queued = 0;

  for (const it of list) {
    const cand = await client.query(
      `/* g25e:increase-candidate */ SELECT i.id, i.qty, i.status, i.result FROM woo_stock_outbox i
        WHERE i.workorder_id = $1 AND i.sku = $2 AND i.kind = 'increase' AND i.status <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM woo_stock_outbox d WHERE d.reverses_id = i.id AND d.status <> 'cancelled')
        ORDER BY (i.qty = $3) DESC, i.id DESC
        LIMIT 1 FOR UPDATE`,
      [woId, it.sku, it.qty]
    );
    const add = cand.rows?.[0];
    if (!add) {
      if (reopenClosedSale) {
        const r = await client.query(
          `/* g25e:reopen-sale */ UPDATE woo_stock_outbox SET status = 'pending', last_error = NULL
            WHERE id = (SELECT id FROM woo_stock_outbox WHERE workorder_id = $1 AND sku = $2 AND kind = 'decrease' AND status = 'cancelled'
                         ORDER BY id DESC LIMIT 1)
            RETURNING id`,
          [woId, it.sku]
        );
        queued += r.rowCount || 0;
      }
      continue;
    }
    const res = parse(add.result) || {};
    if (add.status === 'pending' || add.status === 'failed') {
      // Never reached the website — the original sale still stands.
      await closeRow(client, add.id, 'Item back on the workorder before the add-back was sent — nothing sent');
      await log(client, woId, `Website stock for ${it.sku}: add-back cancelled — the item is back on the workorder (the website still shows the sale)`);
    } else if (add.status === 'sent' || add.status === 'dry_run') {
      await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'decrease', reversesId: add.id });
      queued += 1;
    } else if (add.status === 'needs_human' && (res.action === 'manual' || res.action === 'needs_human')) {
      // Nothing was added automatically; if GS already added it back by hand they take it off again.
      await closeRow(client, add.id, 'Item back on the workorder — no add-back needed any more', { alsoNeedsHuman: true });
      await log(client, woId, `Website stock for ${it.sku}: the item is back on the workorder — if you already added it back on the website by hand, take it off again`);
    } else {
      await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'decrease', reversesId: add.id, status: 'needs_human', result: { action: 'manual' }, error: 'Item back on the workorder after an add-back that may or may not have gone through — check the website stock by hand' });
      await log(client, woId, `Website stock for ${it.sku}: the item is back on the workorder but its add-back was uncertain — check the website stock by hand`);
      await client.query(`/* g25e:untick */ UPDATE workorder SET ecommerce = FALSE WHERE workorder_id = $1 AND ecommerce IS TRUE`, [woId]);
    }
  }
  return queued;
}
