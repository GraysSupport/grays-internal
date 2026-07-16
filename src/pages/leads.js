// src/pages/leads.js — Lead funnel Kanban (feature F5).
//
// The sales pipeline over the F5 backend (lib/handlers/leads.js → /api/leads),
// itself over the leads + lead_stage_log tables from F0's migration 0001 (§4.3).
// Columns are New → Contacted → Quoted → Won / Lost ('Payment Received' was merged
// into 'Won'). Moving a card PUTs /api/leads/:id/stage (which appends a stage-log
// row); moving to Lost prompts for a structured reason (dropdown + "Other" note) so
// losses are quantifiable. Moving to Quoted opens the F7a "raise quote" modal to record
// the MYOB invoice number (POST /api/leads/:id/quote). The board is GLOBAL (all reps'
// leads) with a My/All filter, and each card shows its owner. A "+ New lead" form makes
// the funnel demonstrable, and clicking a card opens the linked Podium conversation.
//
// Gated to sales/superadmin (display-only here; /api/leads re-checks server-side and
// runs on the login JWT). No message bodies are touched — leads are CRM metadata.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import { authHeaders, getToken, getRoles, hasAnyRole, getStoredUser } from '../utils/auth';
import { parseMaybeJson } from '../utils/http';

const LEADS_ROLES = ['sales', 'superadmin'];

// Funnel stages (Payment Received merged into Won — migration 0002).
const STAGES = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'];

// Structured Lost-reason categories (keep in sync with lib/handlers/leads.js LOST_REASONS).
const LOST_REASONS = [
  'Price / too expensive',
  'Went with a competitor',
  'Lead time / stock too long',
  'Changed mind / no longer needed',
  'No response (went cold)',
  'Budget / finance',
  'Other',
];

// Per-column accent (header). Mirrors the inbox STAGE_CLS badge colours.
const COLUMN_CLS = {
  New: 'bg-gray-100 text-gray-700',
  Contacted: 'bg-blue-100 text-blue-800',
  Quoted: 'bg-amber-100 text-amber-800',
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
  const [ownerScope, setOwnerScope] = useState('all'); // 'all' | 'mine'
  const myId = getStoredUser()?.id || null;

  // Create form
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ product_interest: '', value_est: '', source_channel: '', notes: '' });

  // Lost-reason modal (structured: a category + an optional note; "Other" needs a note)
  const [lostFor, setLostFor] = useState(null); // the lead being marked Lost | null
  const [lostCategory, setLostCategory] = useState('');
  const [lostNote, setLostNote] = useState('');

  // Raise-quote modal (F7a): capture the MYOB invoice number (+ optional order total),
  // then POST /api/leads/:id/quote which records it and moves the lead → Quoted.
  const [quoteFor, setQuoteFor] = useState(null); // the lead being quoted | null
  const [quoteInvoice, setQuoteInvoice] = useState('');
  const [quoteTotal, setQuoteTotal] = useState('');
  const [quoting, setQuoting] = useState(false);

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

  const submitStage = useCallback(async (leadId, toStage, lost) => {
    setSavingId(leadId);
    try {
      const payload = { to_stage: toStage };
      if (lost) {
        payload.lost_reason_category = lost.category;
        if (lost.note) payload.lost_reason = lost.note;
      }
      const res = await fetch(`/api/leads/${leadId}/stage`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { navigate('/'); return false; }
      const data = await parseMaybeJson(res);
      if (res.status === 400 && (data?.code === 'LOST_REASON_REQUIRED' || data?.code === 'LOST_NOTE_REQUIRED')) {
        toast.error(data?.error || 'A reason is required');
        return false;
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
      setLostCategory('');
      setLostNote('');
      setLostFor(lead);
      return;
    }
    if (toStage === 'Quoted') {
      // F7a — moving to Quoted raises a Quote/Invoice: capture the MYOB invoice number.
      openQuote(lead);
      return;
    }
    await submitStage(lead.lead_id, toStage);
  };

  // Open the raise-quote modal, pre-filling any invoice/total already on the lead
  // (so a re-quote edits rather than blanks).
  const openQuote = (lead) => {
    setQuoteInvoice(lead.quote_invoice_id || '');
    setQuoteTotal(lead.order_total == null ? '' : String(lead.order_total));
    setQuoteFor(lead);
  };

  const submitQuote = async () => {
    if (!quoteFor) return;
    const invoice = quoteInvoice.trim();
    if (!invoice) { toast.error('Enter the MYOB invoice number'); return; }
    setQuoting(true);
    try {
      const payload = { quote_invoice_id: invoice };
      if (quoteTotal !== '') payload.order_total = Number(quoteTotal);
      const res = await fetch(`/api/leads/${quoteFor.lead_id}/quote`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not raise the quote'); return; }
      upsertLead(data);
      toast.success(`Quote raised (invoice ${invoice})`);
      setQuoteFor(null);
      setQuoteInvoice('');
      setQuoteTotal('');
    } catch {
      toast.error('Server error raising the quote');
    } finally {
      setQuoting(false);
    }
  };

  const confirmLost = async () => {
    if (!lostFor) return;
    if (!lostCategory) { toast.error('Please choose a reason'); return; }
    if (lostCategory === 'Other' && !lostNote.trim()) { toast.error('Please add a note for "Other"'); return; }
    const ok = await submitStage(lostFor.lead_id, 'Lost', { category: lostCategory, note: lostNote.trim() });
    if (ok) { setLostFor(null); setLostCategory(''); setLostNote(''); }
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

  // Open the lead's linked Podium conversation in the Inbox (deep-link).
  const openChat = (lead) => {
    if (!lead?.podium_conversation_id) return;
    navigate(`/inbox?conversation=${encodeURIComponent(lead.podium_conversation_id)}`);
  };

  if (!authorized) return null;

  const visibleLeads = ownerScope === 'mine' && myId
    ? leads.filter((l) => l.assigned_to === myId)
    : leads;
  const byStage = (stage) => visibleLeads.filter((l) => l.stage === stage);

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>

      <div className="min-h-screen bg-gray-100 pt-16 pb-6 px-3 md:px-6">
        <div className="max-w-[90rem] mx-auto">
          <div className="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="text-2xl font-bold">Lead Funnel</h1>
            <div className="flex items-center gap-2">
              {/* Global board — filter to your own leads or show everyone's */}
              <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
                <button
                  type="button"
                  onClick={() => setOwnerScope('all')}
                  className={ownerScope === 'all' ? 'px-3 py-1.5 bg-blue-500 text-white' : 'px-3 py-1.5 bg-white text-gray-700 hover:bg-gray-50'}
                >
                  All leads
                </button>
                <button
                  type="button"
                  onClick={() => setOwnerScope('mine')}
                  className={ownerScope === 'mine' ? 'px-3 py-1.5 bg-blue-500 text-white' : 'px-3 py-1.5 bg-white text-gray-700 hover:bg-gray-50'}
                >
                  My leads
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowNew(true)}
                className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600"
              >
                + New lead
              </button>
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-gray-500">Loading leads…</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
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
                          onOpenChat={openChat}
                          onEditQuote={openQuote}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-xs text-gray-400 mt-4">
            This is the whole team's funnel — use “My leads” to see only yours. Every stage
            change is recorded to the lead's history; click a card to open its chat.
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

      {/* Lost-reason modal — a structured category (quantifiable) + an optional note.
          "Other" requires the note. */}
      {lostFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-5 space-y-3">
            <h2 className="text-lg font-bold">Mark lead Lost</h2>
            <p className="text-sm text-gray-600">
              Why was this lead lost? The reason is recorded so we can see what's costing us leads.
            </p>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Reason *</label>
              <select
                value={lostCategory}
                onChange={(e) => setLostCategory(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                <option value="">Choose a reason…</option>
                {LOST_REASONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                Note {lostCategory === 'Other' ? '*' : '(optional)'}
              </label>
              <textarea
                value={lostNote}
                onChange={(e) => setLostNote(e.target.value)}
                rows={3}
                placeholder={lostCategory === 'Other' ? 'Please describe the reason' : 'Any extra detail'}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setLostFor(null); setLostCategory(''); setLostNote(''); }}
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

      {/* Raise-quote modal (F7a) — record the MYOB invoice number the rep raised (+ an
          optional order total). MYOB is stubbed (FEATURE_MYOB=false) so this is manual
          for now; when the MYOB phase lands the number is filled automatically. */}
      {quoteFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-5 space-y-3">
            <h2 className="text-lg font-bold">Raise quote / invoice</h2>
            <p className="text-sm text-gray-600">
              Raise the invoice in MYOB, then record its number here. The lead moves to
              <span className="font-semibold"> Quoted</span> and the number carries through to
              the workorder when logistics confirm payment.
            </p>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">MYOB invoice number *</label>
              <input
                type="text"
                value={quoteInvoice}
                onChange={(e) => setQuoteInvoice(e.target.value)}
                placeholder="e.g. 20431"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Order total (AUD, optional)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={quoteTotal}
                onChange={(e) => setQuoteTotal(e.target.value)}
                placeholder="e.g. 3590"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setQuoteFor(null); setQuoteInvoice(''); setQuoteTotal(''); }}
                className="px-4 py-2 rounded text-sm border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitQuote}
                disabled={quoting}
                className="px-4 py-2 rounded text-sm bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {quoting ? 'Saving…' : 'Raise quote'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// A single lead card: click the body to open its chat; a stage mover in the footer.
function LeadCard({ lead, saving, onChangeStage, onOpenChat, onEditQuote }) {
  const title = lead.customer_name || lead.product_interest || `Lead #${lead.lead_id}`;
  const est = money(lead.value_est);
  const channel = lead.source_channel ? (CHANNELS[String(lead.source_channel).toLowerCase()] || lead.source_channel) : null;
  const hasChat = !!lead.podium_conversation_id;
  const lostText = lead.lost_reason_category
    ? [lead.lost_reason_category, lead.lost_reason].filter(Boolean).join(' — ')
    : lead.lost_reason;

  return (
    <div className="rounded-lg border border-gray-200 p-2.5 bg-white">
      {/* Body — clickable to open the linked conversation in the Inbox */}
      <button
        type="button"
        onClick={() => hasChat && onOpenChat && onOpenChat(lead)}
        className={`w-full text-left ${hasChat ? 'cursor-pointer group' : 'cursor-default'}`}
        title={hasChat ? 'Open chat' : undefined}
      >
        <div className="flex items-center justify-between gap-1">
          <span className={`font-medium text-sm text-gray-900 truncate ${hasChat ? 'group-hover:text-blue-700' : ''}`}>{title}</span>
          {hasChat && <span className="text-[11px] text-blue-600 shrink-0 opacity-0 group-hover:opacity-100">chat →</span>}
        </div>
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
        </div>
      </button>

      {/* Owner (global board — always show who it's assigned to) */}
      <div className="text-[11px] text-gray-500 mt-1">
        {lead.assigned_name
          ? <>Owner: <span className="font-medium text-gray-700">{lead.assigned_name}</span></>
          : <span className="text-gray-400">Unassigned</span>}
      </div>

      {lead.stage === 'Lost' && lostText && (
        <div className="text-[11px] text-red-600 mt-1 truncate" title={lostText}>
          Lost: {lostText}
        </div>
      )}

      {/* F7a — a Quoted lead shows its MYOB invoice number, with a quick "edit" to
          re-record it. */}
      {lead.stage === 'Quoted' && (
        <div className="text-[11px] text-amber-700 mt-1 flex items-center gap-1">
          {lead.quote_invoice_id
            ? <span className="truncate">Invoice #{lead.quote_invoice_id}</span>
            : <span className="text-gray-400">No invoice recorded</span>}
          {onEditQuote && (
            <button
              type="button"
              onClick={() => onEditQuote(lead)}
              className="text-amber-600 hover:text-amber-800 underline shrink-0"
            >
              edit
            </button>
          )}
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
