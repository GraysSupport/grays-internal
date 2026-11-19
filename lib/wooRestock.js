// lib/wooRestock.js — G25e1 (owner's back-in-stock rules, 19 Nov 2026): a cancelled workorder
// item puts its quantity back on the website, live, at the moment of the cancel.
// Plan: feature-plan-stock-sync-2026-11-06.md § G25e / G25e1 (defaults E-D1–E-D4).
//
// Only what the website actually LOST is given back (E-D1) — decided from that item's own sale
// row in woo_stock_outbox (the decrease):
//   sent (decrease / soldout)        → queue an add-back (kind 'increase', reverses_id = the sale)
//   sent, needed a check by hand     → flag GS ("add it back by hand")
//   sent as a website sale (none /
//   soldout_only), or salesperson WB → not pushed: WooCommerce restocks on its own cancel /
//                                       refund (E-D2) — log says so
//   dry_run                          → add-back queued as a dry run: "would add N back" (GS did
//                                       the sale by hand in the dry-run week)
//   pending / failed                 → nothing reached the website: the sale row is closed off
//   needs_human (lookup refused)     → nothing reached the website: closed off
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

  if (!(await outboxHasKind(client))) {
    for (const it of list) {
      await log(client, woId, `Back-in-stock: ${it.sku} ×${it.qty} cancelled — update the website by hand (database update 0016 not applied yet, so nothing is added back automatically)`);
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
  const websiteOrder = async (it) => {
    await log(client, woId, `Website stock for ${it.sku}: website order — cancel/refund it in WooCommerce and its stock returns there (nothing sent from the portal)`);
  };

  for (const it of list) {
    // E-D2: a website order (salesperson WB) — WooCommerce restocks on its own cancel/refund.
    if (skipSalespeople(env).has(String(salesperson ?? '').trim().toUpperCase())) { await websiteOrder(it); continue; }

    // This item's sale: the oldest-matching, not-yet-given-back decrease for this SKU.
    // Live rows first, an exact quantity match first, then the newest.
    const cand = await client.query(
      `/* g25e:decrease-candidate */ SELECT o.id, o.qty, o.status, o.result FROM woo_stock_outbox o
        WHERE o.workorder_id = $1 AND o.sku = $2 AND o.kind = 'decrease'
          AND NOT EXISTS (SELECT 1 FROM woo_stock_outbox i WHERE i.reverses_id = o.id AND i.status <> 'cancelled')
        ORDER BY (o.status = 'cancelled') ASC, (o.qty = $3) DESC, o.id DESC
        LIMIT 1 FOR UPDATE`,
      [woId, it.sku, it.qty]
    );
    const sale = cand.rows?.[0];

    if (!sale) {
      // Rows exist but every one is already given back → nothing left to add.
      const any = await client.query(`/* g25e:any-row */ SELECT id FROM woo_stock_outbox WHERE workorder_id = $1 AND sku = $2 LIMIT 1`, [woId, it.sku]);
      if (any.rowCount) continue;
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
          // A lookup refused it (SKU not on the website, etc.) — nothing was sent.
          await closeRow(client, sale.id, 'Item cancelled — this sale was never sent to the website', { alsoNeedsHuman: true });
          await log(client, woId, `Website stock for ${it.sku}: nothing to add back — the website was never reduced for this item`);
        } else {
          await flag(it, 'the website update for this sale may or may not have gone through — check the stock and add it back by hand', sale.id);
        }
        break;
      case 'sending':
        await flag(it, 'the website update for this sale was still in progress — check the stock and add it back by hand', sale.id);
        break;
      case 'dry_run':
        if (res.action === 'none' || res.action === 'soldout_only') { await websiteOrder(it); break; }
        await insertRow(client, { workorderId: woId, sku: it.sku, qty: it.qty, kind: 'increase', reversesId: sale.id, result: { reverses_status: 'dry_run' } });
        queued += 1;
        break;
      case 'sent':
        if (res.action === 'none' || res.action === 'soldout_only') { await websiteOrder(it); break; }
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
