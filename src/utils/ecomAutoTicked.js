// src/utils/ecomAutoTicked.js — GS one-time popup helpers (owner, 26 Nov 2026).
// Server side: lib/ecomAutoTicked.js (GS only, from the signed login token).
import { identityHeaders } from './workshopAccess';

/** The workorder page clears the popup entry when GS opens a workorder that is still waiting. */
export function shouldMarkEcomAutoSeen(wo, isGS) {
  return Boolean(isGS && wo && wo.ecommerce_auto_ticked_at && !wo.ecommerce_auto_seen_at);
}

/** Best-effort: true when the server accepted it. Never throws. */
export async function markEcomAutoSeen(workorderId) {
  try {
    const r = await fetch(`/api/workorder?id=${encodeURIComponent(workorderId)}&resource=ecommerce-auto-seen`, {
      method: 'POST',
      headers: identityHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
    });
    return r.ok;
  } catch {
    return false;
  }
}

export function formatSoldItems(items) {
  if (!Array.isArray(items) || !items.length) return '—';
  return items.map((it) => `${Number(it.quantity) || it.quantity} × ${it.product_name || it.product_id || ''}`).join(', ');
}

export function formatTickedAt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
