// src/components/CollectionModal.js
import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

const AU_STATES = ['VIC','NSW','QLD','ACT','WA','SA','TAS','NT'];
const STATUSES = ['To Be Booked','Confirmed','Completed'];

export default function CollectionModal({ open, onClose, onSaved, initial }) {
  const isEdit = Boolean(initial?.id);

  const [form, setForm] = useState({
    name: '',
    suburb: '',
    state: '',
    description: '',
    removalist_id: '',
    collection_date: '',
    notes: '',
    status: 'To Be Booked',
  });

  const [removalists, setRemovalists] = useState([]);
  const [carrierQuery, setCarrierQuery] = useState('');
  const [carrierOpen, setCarrierOpen] = useState(false);
  const carrierBoxRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);

  // Stable id for listbox (for aria-controls)
  const listboxId = useMemo(
    () => `carrier-list-${Math.random().toString(36).slice(2)}`,
    []
  );

  // Prefill when editing or opening
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setForm({
        name: initial.name || '',
        suburb: initial.suburb || '',
        state: initial.state || '',
        description: initial.description || '',
        removalist_id: initial.removalist_id || '',
        collection_date: initial.collection_date ? String(initial.collection_date).slice(0, 10) : '',
        notes: initial.notes || '',
        status: initial.status || 'To Be Booked',
      });
      setCarrierQuery(initial.removalist_name || '');
    } else {
      setForm({
        name: '',
        suburb: '',
        state: '',
        description: '',
        removalist_id: '',
        collection_date: '',
        notes: '',
        status: 'To Be Booked',
      });
      setCarrierQuery('');
    }
    setCarrierOpen(false);
  }, [open, initial]);

  // Load carriers (from same API)
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await fetch('/api/collections?resource=carriers');
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed to load carriers');
        setRemovalists(data || []);
      } catch (e) {
        toast.error(e.message || 'Failed to load carriers');
      }
    })();
  }, [open]);

  // Close dropdown on outside click or Esc (global)
  useEffect(() => {
    if (!carrierOpen) return;
    const onDocMouseDown = (e) => {
      if (carrierBoxRef.current && !carrierBoxRef.current.contains(e.target)) {
        setCarrierOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setCarrierOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [carrierOpen]);

  const filteredRemovalists = useMemo(() => {
    const q = carrierQuery.trim().toLowerCase();
    if (!q) return removalists;
    return removalists.filter((r) =>
      [r.name, r.phone, r.email].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }, [carrierQuery, removalists]);

  const canSubmit = useMemo(() => {
    if (!form.name) return false;
    if (form.status === 'Completed' && (!form.collection_date || !form.removalist_id)) return false;
    return true;
  }, [form]);

  const save = async () => {
    if (!canSubmit) {
      toast.error('Please complete required fields.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        removalist_id: form.removalist_id ? Number(form.removalist_id) : null,
      };

      const res = await fetch(isEdit ? `/api/collections?id=${initial.id}` : '/api/collections', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Save failed');

      toast.success(isEdit ? 'Collection updated' : 'Collection created');
      onSaved?.(data);
      onClose?.();
    } catch (e) {
      toast.error(e.message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* dialog */}
      <div className="relative z-10 w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{isEdit ? 'Edit Collection' : 'Create Collection'}</h3>
          <button onClick={onClose} className="rounded-md p-2 hover:bg-gray-100">✕</button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium">Name *</label>
            <input
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-sm font-medium">Suburb</label>
            <input
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={form.suburb}
              onChange={(e) => setForm((f) => ({ ...f, suburb: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-sm font-medium">State</label>
            <select
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={form.state}
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
            >
              <option value="">—</option>
              {AU_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium">Collection Date</label>
            <input
              type="date"
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={form.collection_date}
              onChange={(e) => setForm((f) => ({ ...f, collection_date: e.target.value }))}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium">Description</label>
            <textarea
              rows={2}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          {/* Searchable carrier (combobox) */}
          <div className="sm:col-span-2" ref={carrierBoxRef}>
            <label className="block text-sm font-medium">Carrier</label>
            <div className="relative">
              <input
                className="mt-1 w-full rounded-lg border px-3 py-2"
                placeholder="Search carriers…"
                value={carrierQuery}
                onFocus={() => setCarrierOpen(true)}
                onChange={(e) => { setCarrierQuery(e.target.value); setCarrierOpen(true); }}
                role="combobox"
                aria-autocomplete="list"
                aria-haspopup="listbox"
                aria-expanded={carrierOpen}
                aria-controls={listboxId}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setCarrierOpen(false);
                  if (e.key === 'ArrowDown') setCarrierOpen(true);
                  if (e.key === 'Enter') {
                    // Select first result if available
                    const first = filteredRemovalists[0];
                    if (first) {
                      setForm((f) => ({ ...f, removalist_id: first.id }));
                      setCarrierQuery(first.name || `#${first.id}`);
                      setCarrierOpen(false);
                    }
                  }
                }}
              />
              {carrierOpen && (
                <div
                  id={listboxId}
                  role="listbox"
                  className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border bg-white shadow-lg"
                >
                  {filteredRemovalists.map((r) => {
                    const selected = String(form.removalist_id) === String(r.id);
                    return (
                      <div
                        key={r.id}
                        role="option"
                        aria-selected={selected}
                        tabIndex={-1}
                        className={`px-3 py-2 cursor-pointer hover:bg-gray-50 ${selected ? 'bg-gray-100' : ''}`}
                        onMouseDown={(e) => {
                          // Use mousedown to avoid blur-before-click
                          e.preventDefault();
                          setForm((f) => ({ ...f, removalist_id: r.id }));
                          setCarrierQuery(r.name || `#${r.id}`);
                          setCarrierOpen(false);
                        }}
                      >
                        <div className="text-sm font-medium">{r.name || `#${r.id}`}</div>
                        {(r.phone || r.email) && (
                          <div className="text-xs text-gray-600">
                            {[r.phone, r.email].filter(Boolean).join(' • ')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!filteredRemovalists.length && (
                    <div className="px-3 py-2 text-sm text-gray-500">No matches</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">Status</label>
            <select
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {form.status === 'Completed' && (!form.collection_date || !form.removalist_id) && (
              <p className="mt-1 text-xs text-red-600">
                To mark Completed, choose a collection date and a carrier.
              </p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium">Notes</label>
            <textarea
              rows={2}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button className="rounded-lg border px-4 py-2" onClick={onClose}>Cancel</button>
          <button
            disabled={submitting || !canSubmit}
            onClick={save}
            className="rounded-lg bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {submitting ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}
