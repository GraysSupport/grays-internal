// src/utils/websiteStock.js — G25 increment 2: plain-English website status for the workorder
// page (one line per item) and GS's E-Commerce popup (one line per workorder). Rows come from
// woo_stock_outbox via GET /api/workorder (superadmin / GS / marketing lead only).

const parse = (r) => {
  if (r == null) return null;
  if (typeof r === 'string') { try { return JSON.parse(r); } catch { return null; } }
  return r;
};

/** One item → { text, tone: 'ok' | 'warn' | 'muted' } */
export function websiteRowLabel(row) {
  const res = parse(row?.result) || {};
  const err = String(row?.last_error || '').trim();
  const arrow = `${res.before} → ${res.after}`;
  // G25e1: a cancelled item's add-back (kind 'increase').
  if (row?.kind === 'increase') {
    const back = res.action === 'restock' ? `, back on sale (${res.was_sold ? 'was Sold' : 'was sold out'})` : '';
    switch (row.status) {
      case 'sent': return { text: `Added back: ${arrow}${back}`, tone: 'ok' };
      case 'dry_run': return { text: `Dry run — would add ${Number(row.qty)} back (${arrow})${back} — add it back by hand`, tone: 'muted' };
      case 'failed': return { text: `Add-back failed: ${err || 'website error'} — retries daily, or press Retry`, tone: 'warn' };
      case 'needs_human': return { text: `Needs you: ${err || 'add it back by hand'}`, tone: 'warn' };
      case 'pending': return { text: 'Waiting to add back — retries daily, or press Retry', tone: 'muted' };
      case 'sending': return { text: 'Adding back…', tone: 'muted' };
      case 'cancelled': return { text: `Add-back not needed${err ? ` — ${err}` : ''}`, tone: 'muted' };
      default: return { text: String(row.status || 'Unknown'), tone: 'muted' };
    }
  }
  switch (row?.status) {
    case 'sent': {
      let text;
      if (res.action === 'none') text = `Website sale — checkout already took it (${res.before} left)`;
      else if (res.action === 'soldout_only') text = 'Already 0 — marked sold out';
      else if (res.action === 'soldout') text = `Updated: ${arrow}, marked sold out`;
      else text = `Updated: ${arrow}`;
      if (res.check) return { text: `${text} — ${err || 'check by hand'}`, tone: 'warn' };
      return { text, tone: 'ok' };
    }
    case 'dry_run':
      if (res.action === 'none') return { text: 'Dry run — website sale, nothing to change', tone: 'muted' };
      return { text: `Dry run — would set ${arrow}${res.action === 'soldout' || res.action === 'soldout_only' ? ', sold out' : ''} (update by hand)`, tone: 'muted' };
    case 'failed':
      return { text: `Failed: ${err || 'website error'} — retries daily, or press Retry`, tone: 'warn' };
    case 'needs_human':
      return { text: `Needs you: ${err || 'check by hand'}`, tone: 'warn' };
    case 'pending':
      return { text: 'Waiting to send — retries daily, or press Retry', tone: 'muted' };
    case 'sending':
      return { text: 'Sending…', tone: 'muted' };
    case 'cancelled':
      // G25e1: a single cancelled item also closes its sale — say which reason applied.
      return { text: err ? `Not sent — ${err}` : 'Not sent — workorder cancelled', tone: 'muted' };
    default:
      return { text: String(row?.status || 'Unknown'), tone: 'muted' };
  }
}

/** One workorder → { state: 'needs_you'|'retrying'|'dry_run'|'done'|'none', text, tone } */
export function websiteStockSummary(rows) {
  const live = (Array.isArray(rows) ? rows : []).filter((r) => r.status !== 'cancelled');
  if (!live.length) return { state: 'none', text: 'Not synced automatically — update by hand', tone: 'muted' };

  const human = live.filter((r) => r.status === 'needs_human' || (r.status === 'sent' && parse(r.result)?.check));
  if (human.length) {
    const first = human[0];
    const why = String(first.last_error || 'check by hand').trim();
    return { state: 'needs_you', text: `Needs you: ${first.sku} — ${why}${human.length > 1 ? ` (+${human.length - 1} more)` : ''}`, tone: 'warn' };
  }
  if (live.some((r) => ['failed', 'pending', 'sending'].includes(r.status))) {
    return { state: 'retrying', text: 'Website update not through yet — retries daily (or open and press Retry)', tone: 'warn' };
  }
  if (live.some((r) => r.status === 'dry_run')) return { state: 'dry_run', text: 'Dry run only — update the website by hand', tone: 'muted' };
  return { state: 'done', text: 'Website updated automatically', tone: 'ok' };
}

/** Show the Retry button? Only for rows where nothing could have reached the website. */
export function canRetryWebsiteStock(rows) {
  return (Array.isArray(rows) ? rows : []).some((r) =>
    r.status === 'failed' || r.status === 'pending' || (r.status === 'needs_human' && parse(r.result)?.action === 'needs_human'));
}
