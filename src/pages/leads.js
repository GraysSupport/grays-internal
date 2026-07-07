// src/pages/leads.js — Lead funnel Kanban (feature F5).
//
// The sales pipeline over the F5 backend (lib/handlers/leads.js → /api/leads),
// itself over the leads + lead_stage_log tables from F0's migration 0001 (§4.3).
// Columns are the canonical stages New → Contacted → Quoted → Payment Received →
// Won / Lost. Moving a card PUTs /api/leads/:id/stage (which appends a stage-log
// row); moving to Lost requires a reason (prompted in a small modal). A "+ New lead"
// form makes the funnel demonstrable on a fresh DB.
//
// Gated to sales/superadmin (display-only here; /api/leads re-checks server-side and
// runs on the login JWT). No message bodies are touched — leads are CRM metadata.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import { authHeaders, getToken, getRoles, hasAnyRole } from '../utils/auth';
import { parseMaybeJson } from '../utils/http';

const LEADS_ROLES = ['sales', 'superadmin'];

// Canonical funnel stages (mirrors execution-plan §1c / the lead_stage enum).
const STAGES = ['New', 'Contacted', 'Quoted', 'Payment Received', 'Won', 'Lost'];

// Per-column accent (header). Mirrors the inbox STAGE_CLS badge colours.
const COLUMN_CLS = {
  New: 'bg-gray-100 text-gray-700',
  Contacted: 'bg-blue-100 text-blue-800',
  Quoted: 'bg-amber-100 text-amber-800',
  'Payment Received': 'bg-purple-100 text-purple-800',
  Won: 'bg-green-100 text-green-800',
  Lost: 'bg-red-100 text-red-700',
};

const CHANNELS = {
  phone: 'SMS', sms: 'SMS', email: 'Email', facebook: 'Facebook',
  instagram: 'Instagram', google: 'Google', webchat: 'Webchat', whatsapp: 'WhatsApp',
};

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
}

export default function Leads() {
  const navigate = useNavigate();

  const [authorized, setAuthorized] = useState(false);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);

  // Create form
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ product_interest: '', value_est: '', source_channel: '', notes: '' });

  // Lost-reason modal
  const [lostFor, setLostFor] = useState(null); // { lead_id } | null
  const [lostReason, setLostReason] = useState('');

  useEffect(() => {
    if (!getToken()) { navigate('/'); return; }
    if (!hasAnyRole(getRoles(), LEADS_ROLES)) {
      toast.error('The lead funnel is for sales users');
      navigate('/dashboard');
      return;
    }
    setAuthorized(true);
  }, [navigate]);

  const loadLeads = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/leads', { headers: authHeaders() });
      if (res.status === 401) { navigate('/'); return; }
      if (res.status === 403) { toast.error('The lead funnel is for sales users'); navigate('/dashboard'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not load leads'); return; }
      setLeads(Array.isArray(data) ? data : []);
    } catch {
      toast.error('Server error loading leads');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (authorized) loadLeads();
  }, [authorized, loadLeads]);

  // Replace a lead in state after a server round-trip returns the updated row.
  const upsertLead = (row) => {
    if (!row?.lead_id) return;
    setLeads((prev) => {
      const idx = prev.findIndex((l) => l.lead_id === row.lead_id);
      if (idx === -1) return [row, ...prev];
      const next = prev.slice();
      next[idx] = row;
      return next;
    });
  };

  const submitStage = useCallback(async (leadId, toStage, reason) => {
    setSavingId(leadId);
    try {
      const payload = { to_stage: toStage };
      if (reason) payload.lost_reason = reason;
      const res = await fetch(`/api/leads/${leadId}/stage`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { navigate('/'); return false; }
      const data = await parseMaybeJson(res);
      if (res.status === 400 && data?.code === 'LOST_REASON_REQUIRED') {
        return false; // caller opens the lost-reason modal
      }
      if (!res.ok) { toast.error(data?.error || 'Could not move the lead'); return false; }
      upsertLead(data);
      toast.success(`Moved to ${toStage}`);
      return true;
    } catch {
      toast.error('Server error moving the lead');
      return false;
    } finally {
      setSavingId(null);
    }
  }, [navigate]);

  const onChangeStage = async (lead, toStage) => {
    if (!toStage || toStage === lead.stage) return;
    if (toStage === 'Lost') {
      setLostReason('');
      setLostFor(lead);
      return;
    }
    await submitStage(lead.lead_id, toStage);
  };

  const confirmLost = async () => {
    if (!lostFor) return;
    const reason = lostReason.trim();
    if (!reason) { toast.error('Please give a reason'); return; }
    const ok = await submitStage(lostFor.lead_id, 'Lost', reason);
    if (ok) { setLostFor(null); setLostReason(''); }
  };

  const createLead = async (e) => {
    e.preventDefault();
    const productInterest = form.product_interest.trim();
    if (!productInterest) { toast.error('Product interest is required'); return; }
    setCreating(true);
    try {
      const payload = {
        product_interest: productInterest,
        value_est: form.value_est === '' ? undefined : Number(form.value_est),
        source_channel: form.source_channel || undefined,
        notes: form.notes.trim() || undefined,
      };
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not create the lead'); return; }
      upsertLead(data);
      setForm({ product_interest: '', value_est: '', source_channel: '', notes: '' });
      setShowNew(false);
      toast.success('Lead created');
    } catch {
      toast.error('Server error creating the lead');
    } finally {
      setCreating(false);
    }
  };

  if (!authorized) return null;

  const byStage = (stage) => leads.filter((l) => l.stage === stage);

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>

      <div className="min-h-screen bg-gray-100 pt-16 pb-6 px-3 md:px-6">
        <div className="max-w-[90rem] mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold">Lead Funnel</h1>
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600"
            >
              + New lead
            </button>
          </div>

          {loading ? (
            <div className="text-sm text-gray-500">Loading leads…</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
              {STAGES.map((stage) => {
                const cards = byStage(stage);
                return (
                  <div key={stage} className="bg-white rounded-lg shadow-sm flex flex-col min-h-[8rem]">
                    <div className={`flex items-center justify-between px-3 py-2 rounded-t-lg ${COLUMN_CLS[stage] || 'bg-gray-100 text-gray-700'}`}>
                      <span className="font-semibold text-sm">{stage}</span>
                      <span className="text-xs font-semibold">{cards.length}</span>
                    </div>
                    <div className="flex-1 p-2 space-y-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 12rem)' }}>
                      {cards.length === 0 && (
                        <div className="text-xs text-gray-400 px-1 py-2">No leads.</div>
                      )}
                      {cards.map((lead) => (
                        <LeadCard
                          key={lead.lead_id}
                          lead={lead}
                          saving={savingId === lead.lead_id}
                          onChangeStage={onChangeStage}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-xs text-gray-400 mt-4">
            Every stage change is recorded to the lead's history. Leads are created here or
            automatically from an inbound Podium message (P12).
          </p>
        </div>
      </div>

      {/* New lead modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={createLead} className="bg-white rounded-lg shadow-lg w-full max-w-md p-5 space-y-3">
            <h2 className="text-lg font-bold">New lead</h2>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Product interest *</label>
              <input
                type="text"
                value={form.product_interest}
                onChange={(e) => setForm((f) => ({ ...f, product_interest: e.target.value }))}
                placeholder="e.g. Adjustable dumbbell set"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Est. value (AUD)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={form.value_est}
                  onChange={(e) => setForm((f) => ({ ...f, value_est: e.target.value }))}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Source</label>
                <select
                  value={form.source_channel}
                  onChange={(e) => setForm((f) => ({ ...f, source_channel: e.target.value }))}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">—</option>
                  <option value="phone">SMS</option>
                  <option value="email">Email</option>
                  <option value="facebook">Facebook</option>
                  <option value="instagram">Instagram</option>
                  <option value="google">Google</option>
                  <option value="webchat">Webchat</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowNew(false)}
                className="px-4 py-2 rounded text-sm border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 rounded text-sm bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create lead'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lost-reason modal */}
      {lostFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-5 space-y-3">
            <h2 className="text-lg font-bold">Mark lead Lost</h2>
            <p className="text-sm text-gray-600">
              Why was this lead lost? A reason is required and kept in the lead's history.
            </p>
            <textarea
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              rows={3}
              placeholder="e.g. Bought elsewhere / out of budget / no response"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-400"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setLostFor(null); setLostReason(''); }}
                className="px-4 py-2 rounded text-sm border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmLost}
                disabled={savingId === lostFor.lead_id}
                className="px-4 py-2 rounded text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                Mark Lost
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// A single lead card with a stage mover.
function LeadCard({ lead, saving, onChangeStage }) {
  const title = lead.customer_name || lead.product_interest || `Lead #${lead.lead_id}`;
  const est = money(lead.value_est);
  const channel = lead.source_channel ? (CHANNELS[String(lead.source_channel).toLowerCase()] || lead.source_channel) : null;

  return (
    <div className="rounded-lg border border-gray-200 p-2.5 bg-white">
      <div className="font-medium text-sm text-gray-900 truncate">{title}</div>
      {lead.customer_name && lead.product_interest && (
        <div className="text-xs text-gray-500 truncate">{lead.product_interest}</div>
      )}
      <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
        {channel && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{channel}</span>
        )}
        {est && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800">{est}</span>
        )}
        {lead.assigned_name && (
          <span className="text-[11px] text-gray-500">{lead.assigned_name}</span>
        )}
      </div>
      {lead.stage === 'Lost' && lead.lost_reason && (
        <div className="text-[11px] text-red-600 mt-1 truncate" title={lead.lost_reason}>
          Lost: {lead.lost_reason}
        </div>
      )}
      <div className="mt-2">
        <select
          value={lead.stage}
          disabled={saving}
          onChange={(e) => onChangeStage(lead, e.target.value)}
          className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
          aria-label={`Move lead ${lead.lead_id} to another stage`}
        >
          {STAGES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
