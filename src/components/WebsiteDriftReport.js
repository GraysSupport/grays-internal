// src/components/WebsiteDriftReport.js — G25c: superadmin "Website drift" tab on the Products page.
// Shows the latest weekly report (written by the daily job on Mondays) and a "Check now" button
// that runs the same comparison live. READ-ONLY: it lists differences for a human to review;
// nothing here changes the website (no "Set website to portal" in this increment).

import { useEffect, useState } from 'react';
import { DRIFT_STATE_LABEL, melbourneTime } from '../utils/websiteStockColumn';

function DriftTable({ data }) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const c = data?.counts || {};
  return (
    <div>
      <p className="mb-2 text-sm text-gray-700">
        Checked {melbourneTime(data?.checkedAt || data?.createdAt)} — {c.checked ?? 0} products,{' '}
        <strong>{c.mismatches ?? 0}</strong> with different stock, <strong>{c.notOnWebsite ?? 0}</strong> in stock but not on the website
        {c.unknown ? `, ${c.unknown} couldn't be read` : ''}.
        {data?.source === 'mock' && <span className="ml-1 text-gray-700">(Sample website data — not the real website.)</span>}
      </p>
      {Array.isArray(data?.errors) && data.errors.length > 0 && (
        <p className="mb-2 text-sm text-amber-800">Part of the website couldn't be read: {data.errors[0]}</p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-gray-700">No differences — the website matches the portal.</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="Website drift" className="w-full border text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="border px-4 py-2">SKU</th>
                <th className="border px-4 py-2">Name</th>
                <th className="border px-4 py-2">Portal stock</th>
                <th className="border px-4 py-2">Website stock</th>
                <th className="border px-4 py-2">Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.sku}-${i}`}>
                  <td className="border px-4 py-2">{r.sku}</td>
                  <td className="border px-4 py-2">{r.name || ''}</td>
                  <td className="border px-4 py-2">{r.portal}</td>
                  <td className="border px-4 py-2">{r.website == null ? '—' : r.website}</td>
                  <td className="border px-4 py-2">{DRIFT_STATE_LABEL[r.state] || r.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function WebsiteDriftReport() {
  const [report, setReport] = useState(undefined); // undefined = loading, null = none yet
  const [live, setLive] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const res = await fetch('/api/website-stock?resource=report');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load the weekly report');
        if (!gone) setReport(data.report || null);
      } catch (err) {
        if (!gone) { setReport(null); setError(err.message); }
      }
    })();
    return () => { gone = true; };
  }, []);

  const checkNow = async () => {
    setChecking(true);
    setError('');
    try {
      const res = await fetch('/api/website-stock?resource=drift');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not check the website');
      if (data.available === false) throw new Error(data.reason || 'The website connection is not set up here');
      setLive(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mb-3 text-sm text-gray-700">
        Products where the portal and the website disagree. The weekly report runs every Monday morning; "Check now"
        reads the website again. Read only — fix differences by hand on the website or in the portal.
      </p>
      <button
        type="button"
        onClick={checkNow}
        disabled={checking}
        className="mb-4 rounded bg-[#B50B1D] px-4 py-2 text-white hover:bg-[#930917] disabled:opacity-50"
      >
        {checking ? 'Checking…' : 'Check now'}
      </button>
      {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
      {live ? (
        <DriftTable data={live} />
      ) : report === undefined ? (
        <p className="text-sm text-gray-700">Loading the weekly report…</p>
      ) : report === null ? (
        <p className="text-sm text-gray-700">No weekly report yet — the first one runs on Monday morning. Press "Check now" to compare today.</p>
      ) : (
        <DriftTable data={report} />
      )}
    </div>
  );
}
