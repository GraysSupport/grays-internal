// lib/cronAuth.js — the CRON_SECRET check shared by the scheduled API paths
// (/api/website-stock-cron, /api/website-stock-drift). Vercel Cron sends
// `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET env var is set.
// No secret configured → refused (never open to the internet).

import { timingSafeEqual } from 'node:crypto';

function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @returns {{ok:true} | {ok:false, status:number, error:string, allow?:string[]}} */
export function cronGate(req, env = process.env) {
  const secret = String(env?.CRON_SECRET || '');
  if (!secret) return { ok: false, status: 503, error: 'CRON_SECRET is not set' };
  if (String(req.method || '').toUpperCase() !== 'GET') return { ok: false, status: 405, error: 'Method Not Allowed', allow: ['GET'] };
  if (!sameSecret(String(req.headers?.authorization || ''), `Bearer ${secret}`)) return { ok: false, status: 401, error: 'Unauthorized' };
  return { ok: true };
}
