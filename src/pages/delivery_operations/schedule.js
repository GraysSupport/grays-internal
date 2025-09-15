import { Fragment, useEffect, useMemo, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import DeliveryTabs from '../../components/DeliveryTabs';

const ALL_STATUSES = ['To Be Booked', 'Booked for Delivery', 'Delivery Completed'];

// Row navigation helpers (same pattern as To-Be-Booked)
const useRowNav = (navigate) => {
  const go = useCallback((wid) => {
    if (!wid) return;
    navigate(`/delivery_operations/workorder/${wid}`);
  }, [navigate]);
  return go;
};

function fmtMoney(n) {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (Number.isNaN(v)) return '—';
  return v.toLocaleString(undefined, { style: 'currency', currency: 'AUD' });
}
function formatQty(q) {
  const n = Number(q);
  if (Number.isNaN(n)) return String(q ?? '');
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function itemsTextFromWorkorderItems(items) {
  if (!Array.isArray(items) || !items.length) return '—';
  return items.map((it) => `${formatQty(it.quantity)} × ${it.product_name || it.product_id || ''}`).join(', ');
}
function ymd(dateIso) {
  if (!dateIso) return 'Unscheduled';
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return 'Unscheduled';
  return d.toISOString().slice(0, 10);
}
function niceDate(isoOrYmd) {
  const s = isoOrYmd?.length === 10 ? isoOrYmd : ymd(isoOrYmd);
  if (s === 'Unscheduled') return s;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// Stop row navigation for inner controls
const stopRowNav = {
  onClick: (e) => e.stopPropagation(),
  onMouseDown: (e) => e.stopPropagation(),
  onKeyDown: (e) => e.stopPropagation(),
};

function CompactMoneyInput({ value, onChange, onBlur, placeholder = '0.00', widthClass = 'w-20', inputRef, disabled }) {
  return (
    <div className={`inline-flex items-center rounded border bg-white ${widthClass} ${disabled ? 'opacity-60' : ''}`}>
      <span className="px-2 text-gray-500 select-none">$</span>
      <input
        ref={inputRef}
        type="number"
        step="0.01"
        className="w-full min-w-0 appearance-none border-0 px-2 py-1 text-right font-mono text-sm focus:outline-none"
        style={{ WebkitAppearance: 'none', MozAppearance: 'textfield' }}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
      />
    </div>
  );
}

export default function DeliverySchedulePage() {
  const navigate = useNavigate();
  const goWorkorder = useRowNav(navigate);

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [removalists, setRemovalists] = useState([]);
  const [search, setSearch] = useState('');
  const [savingIds, setSavingIds] = useState(new Set());
  const [savingWO, setSavingWO] = useState(new Set());

  const currentUserId = useMemo(() => {
    try {
      const raw = localStorage.getItem('user');
      const u = raw ? JSON.parse(raw) : null;
      const id = (u?.user_id ?? u?.id ?? u?.code ?? '').toString().toUpperCase().slice(0, 2);
      return id || 'NA';
    } catch { return 'NA'; }
  }, []);

  function startToast(prefix, key) {
    const id = `${prefix}-${key}-${Date.now()}`;
    toast.loading('Updating…', { id });
    return id;
  }
  function resolveToast(id, ok, msg) {
    (ok ? toast.success : toast.error)(msg, { id });
  }

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }

    let mounted = true;
    (async () => {
      setLoading(true);
      toast.loading('Loading schedule…', { id: 'sched-load' });
      try {
        const res = await fetch('/api/delivery?include_removalists=1');
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed to load deliveries');

        const deliveries = Array.isArray(data) ? data : (data.deliveries || []);
        const rems = Array.isArray(data.removalists) ? data.removalists : [];

        // Only Booked for Delivery
        const booked = deliveries.filter(d => d.delivery_status === 'Booked for Delivery');

        // Fallback like the other page
        const needWO = booked.some(d => d.items_text == null || d.outstanding_balance == null || d.items);
        let woMap = {};
        if (needWO) {
          const ids = [...new Set(booked.map(d => d.workorder_id).filter(Boolean))];
          await Promise.all(ids.map(async wid => {
            try {
              const r = await fetch(`/api/workorder?id=${encodeURIComponent(wid)}`);
              const j = await r.json();
              if (r.ok) woMap[wid] = j;
            } catch {}
          }));
        }

        const normalized = booked.map(d => {
          const wo = d.workorder_id ? woMap[d.workorder_id] : null;

          let itemsText = '—';
          if (wo?.items?.length) itemsText = itemsTextFromWorkorderItems(wo.items);
          else if (Array.isArray(d.items) && d.items.length) itemsText = itemsTextFromWorkorderItems(d.items);
          else if (typeof d.items_text === 'string') itemsText = d.items_text.replace(/\b(\d+)(?:\.0+)\b/g, '$1');

          const outstanding =
            d.outstanding_balance != null ? Number(d.outstanding_balance)
            : wo ? Number(wo.outstanding_balance || 0) : null;

          const removalistName =
            d.removalist_name ||
            rems.find((r) => Number(r.id) === Number(d.removalist_id))?.name ||
            '';

          return { ...d, items_text: itemsText, outstanding_balance: outstanding, removalist_name: removalistName };
        });

        if (!mounted) return;
        setRows(normalized);
        setRemovalists(rems);
        toast.success('Schedule loaded', { id: 'sched-load' });
      } catch (e) {
        toast.error(e.message || 'Failed to load', { id: 'sched-load' });
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [navigate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((d) =>
      [
        d.customer_name ?? '',
        d.delivery_suburb ?? '',
        d.delivery_state ?? '',
        d.items_text ?? '',
        d.invoice_id ?? '',
        d.removalist_name ?? '',
      ].join(' ').toLowerCase().includes(q)
    );
  }, [rows, search]);

  // Helper to detect "Customer Collect" by resolved carrier name
  const isCustomerCollect = useCallback((row) => {
    const resolved =
      (row.removalist_name && row.removalist_name.trim()) ||
      (row.removalist_id != null
        ? (removalists.find(r => Number(r.id) === Number(row.removalist_id))?.name || '')
        : '');
    return (resolved || '').trim().toLowerCase() === 'customer collect';
  }, [removalists]);

  // Split rows into Customer Collect vs non-CC
  const { customerCollectRows, nonCustomerCollectRows } = useMemo(() => {
    const cc = [];
    const non = [];
    for (const r of filtered) {
      (isCustomerCollect(r) ? cc : non).push(r);
    }
    // sort CC by date asc, then customer, then suburb
    cc.sort((a, b) => {
      const ad = ymd(a.delivery_date);
      const bd = ymd(b.delivery_date);
      const dcmp = ad.localeCompare(bd);
      if (dcmp !== 0) return dcmp;
      const ncmp = String(a.customer_name || '').localeCompare(String(b.customer_name || ''));
      if (ncmp !== 0) return ncmp;
      return String(a.delivery_suburb || '').localeCompare(String(b.delivery_suburb || ''));
    });
    return { customerCollectRows: cc, nonCustomerCollectRows: non };
  }, [filtered, isCustomerCollect]);

  // Group non-CC by date (yyyy-mm-dd), then sort
  const dates = useMemo(() => {
    const map = new Map();
    for (const r of nonCustomerCollectRows) {
      const key = ymd(r.delivery_date);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    return [...map.entries()]
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v]);
  }, [nonCustomerCollectRows]);

  const saveDelivery = useCallback(async (deliveryId, patch) => {
    if (!deliveryId || !patch || typeof patch !== 'object') return;
    const toastId = startToast('saveDelivery', deliveryId);
    setSavingIds(prev => new Set(prev).add(deliveryId));
    try {
      const res = await fetch(`/api/delivery?id=${encodeURIComponent(deliveryId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, user_id: currentUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Save failed');

      setRows((list) => {
        if ('delivery_status' in patch && patch.delivery_status !== 'Booked for Delivery') {
          return list.filter((r) => r.delivery_id !== deliveryId);
        }
        return list.map((r) =>
          r.delivery_id === deliveryId ? { ...r, ...patch } : r
        );
      });

      resolveToast(toastId, true, 'Saved');
    } catch (e) {
      resolveToast(toastId, false, e.message || 'Save failed');
    } finally {
      setSavingIds(prev => {
        const copy = new Set(prev);
        copy.delete(deliveryId);
        return copy;
      });
    }
  }, [currentUserId]);

  const saveWorkorderPayment = useCallback(async (workorder_id, newOutstanding) => {
    if (!workorder_id) return;
    const toastId = startToast('saveWO', workorder_id);
    setSavingWO(prev => new Set(prev).add(workorder_id));
    try {
      const res = await fetch(`/api/workorder?id=${encodeURIComponent(workorder_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outstanding_balance: newOutstanding, user_id: currentUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Payment update failed');

      setRows(list => list.map(r => (r.workorder_id === workorder_id ? { ...r, outstanding_balance: newOutstanding } : r)));
      resolveToast(toastId, true, 'Payment updated');
    } catch (e) {
      resolveToast(toastId, false, e.message || 'Payment save failed');
    } finally {
      setSavingWO(prev => {
        const copy = new Set(prev);
        copy.delete(workorder_id);
        return copy;
      });
    }
  }, [currentUserId]);

  // ===== Carrier dropdown via portal =====
  function CarrierDropdownPortal({ anchorRef, options, onPick, onClose, open }) {
    const [rect, setRect] = useState(null);
    const menuRef = useRef(null);

    useLayoutEffect(() => {
      if (!open) return;
      const update = () => {
        const r = anchorRef.current?.getBoundingClientRect();
        if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width });
      };
      update();
      const onScroll = () => update();
      const onResize = () => update();
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
      };
    }, [open, anchorRef]);

    useEffect(() => {
      if (!open) return;
      const handleClick = (e) => {
        if (!menuRef.current?.contains(e.target) && !anchorRef.current?.contains(e.target)) {
          onClose?.();
        }
      };
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }, [open, onClose, anchorRef]);

    if (!open || !rect) return null;

    return createPortal(
      <div
        ref={menuRef}
        style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 1000 }}
        className="max-h-60 overflow-auto rounded-lg border bg-white shadow-xl"
      >
        {options.length ? options.map((r) => (
          <button
            key={r.id}
            type="button"
            className="block w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-gray-50"
            onMouseDown={() => onPick(r)}
          >
            <div className="font-medium">{r.name}</div>
            <div className="text-xs text-gray-500">ID: {r.id}</div>
          </button>
        )) : (
          <div className="px-3 py-3 text-sm text-gray-500">No carriers</div>
        )}
      </div>,
      document.body
    );
  }

  const CarrierCell = ({ row }) => {
    const [searchText, setSearchText] = useState(row.removalist_name || '');
    const [open, setOpen] = useState(false);
    const inputRef = useRef(null);
    const isSaving = savingIds.has(row.delivery_id);

    // 🔁 Derive display name directly (no useMemo = no ESLint warning)
    const displayName =
      (row.removalist_name && row.removalist_name.trim())
        ? row.removalist_name
        : (row.removalist_id != null
            ? (removalists.find(r => Number(r.id) === Number(row.removalist_id))?.name || '')
            : ''
          );

    // keep input text synced with latest value when dropdown closes
    useEffect(() => {
      if (!open) setSearchText(displayName || '');
    }, [displayName, open]);

    const q = (searchText || '').toLowerCase().trim();
    const list = !q
      ? removalists.slice(0, 50)
      : removalists.filter(r => (`${r.id} ${r.name}`).toLowerCase().includes(q)).slice(0, 50);

    return (
      <div className="relative w-full" {...stopRowNav}>
        <input
          ref={inputRef}
          className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
          value={open ? searchText : (displayName || '')}
          placeholder="Search carrier…"
          onFocus={() => setOpen(true)}
          onChange={(e) => setSearchText(e.target.value)}
          disabled={isSaving}
          {...stopRowNav}
        />
        <CarrierDropdownPortal
          anchorRef={inputRef}
          options={list}
          open={open}
          onClose={() => setOpen(false)}
          onPick={async (r) => {
            setOpen(false);
            setSearchText(r.name);
            if (Number(row.removalist_id) !== Number(r.id)) {
              await saveDelivery(row.delivery_id, {
                removalist_id: Number(r.id),
                removalist_name: r.name, // optimistic patch so UI updates immediately
              });
            }
          }}
        />
      </div>
    );
  };

  const DateCell = ({ row }) => {
    const [val, setVal] = useState(() => ymd(row.delivery_date) === 'Unscheduled' ? '' : ymd(row.delivery_date));
    useEffect(() => { setVal(ymd(row.delivery_date) === 'Unscheduled' ? '' : ymd(row.delivery_date)); }, [row.delivery_date]);
    const busy = savingIds.has(row.delivery_id);
    return (
      <input
        type="date"
        className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => saveDelivery(row.delivery_id, { delivery_date: val || null })}
        disabled={busy}
        {...stopRowNav}
      />
    );
  };

  const NotesCell = ({ row }) => {
    const [val, setVal] = useState(row.notes ?? '');
    useEffect(() => { setVal(row.notes ?? ''); }, [row.notes]);
    const busy = savingIds.has(row.delivery_id) && val !== (row.notes || '');
    return (
      <div className="flex flex-col gap-1 w-full" {...stopRowNav}>
        <textarea
          className="w-full min-h-[38px] resize-y rounded border px-2 py-1 text-sm disabled:opacity-60"
          value={val}
          placeholder="Notes"
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => saveDelivery(row.delivery_id, { notes: val || null })}
          disabled={savingIds.has(row.delivery_id)}
          {...stopRowNav}
        />
        {busy && <span className="text-xs text-gray-400">Saving…</span>}
      </div>
    );
  };

  const PaymentCell = ({ row }) => {
    const [val, setVal] = useState(
      row.outstanding_balance == null ? '' : Number(row.outstanding_balance).toFixed(2)
    );
    useEffect(() => {
      setVal(row.outstanding_balance == null ? '' : Number(row.outstanding_balance).toFixed(2));
    }, [row.outstanding_balance]);

    const busy = savingWO.has(row.workorder_id);
    const isPaid = !(val === '' || Number(val) > 0);

    const label = isPaid ? (
      <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-[11px] font-semibold text-green-700 ring-1 ring-inset ring-green-200">
        Paid
      </span>
    ) : (
      <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
        Outstanding
      </span>
    );

    return (
      <div className="flex w-full flex-col items-center gap-1 text-center" {...stopRowNav}>
        <CompactMoneyInput
          widthClass="w-20"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const num = val === '' ? 0 : Number(val);
            if (Number.isNaN(num)) return;
            if (num !== Number(row.outstanding_balance || 0)) {
              saveWorkorderPayment(row.workorder_id, num);
            }
          }}
          disabled={busy}
        />
        {busy ? (
          <span className="text-xs text-gray-400">Saving…</span>
        ) : (
          <div className="w-full flex justify-center">{label}</div>
        )}
      </div>
    );
  };

  const MoneyCell = ({ row, field }) => {
    const [val, setVal] = useState(row[field] ?? '');
    useEffect(() => { setVal(row[field] ?? ''); }, [row, field]);
    const busy = savingIds.has(row.delivery_id);
    return (
      <div {...stopRowNav}>
        <CompactMoneyInput
          widthClass="w-20"
          value={val ?? ''}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            const num = val === '' ? null : Number(val);
            const orig = row[field] == null ? null : Number(row[field]);
            if (num !== orig) saveDelivery(row.delivery_id, { [field]: num });
          }}
          disabled={busy}
        />
      </div>
    );
  };

  // Status: all 3 options; can only move to Delivery Completed if fully paid
  const StatusCell = ({ row }) => (
    <select
      className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
      value={row.delivery_status}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'Delivery Completed') {
          const obal = Number(row.outstanding_balance || 0);
          if (Number.isFinite(obal) && obal > 0) {
            toast.error('Cannot complete: outstanding balance must be fully paid');
            return;
          }
        }
        if (v !== row.delivery_status) {
          saveDelivery(row.delivery_id, { delivery_status: v });
        }
      }}
      disabled={savingIds.has(row.delivery_id)}
      {...stopRowNav}
    >
      {ALL_STATUSES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );

  // Renders a single date block; rows are CLICKABLE like To-Be-Booked
  const DateBlock = ({ dateKey, rowsForDate }) => {
    const sorted = [...rowsForDate].sort((a, b) => {
      const an = (a.removalist_name || '').localeCompare(b.removalist_name || '');
      if (an !== 0) return an;
      return String(a.customer_name || '').localeCompare(b.customer_name || '');
    });

    let lastCarrier = null;

    return (
      <section className="rounded-xl border bg-white">
        <div className="p-3 text-center text-lg font-semibold">{niceDate(dateKey)}</div>
        <div className="overflow-x-auto">
          <table className="min-w-full table-fixed">
            <thead className="bg-gray-100">
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                <th className="px-3 py-2 w-40">Name</th>
                <th className="px-3 py-2 w-32">Suburb</th>
                <th className="px-3 py-2 w-16">State</th>
                <th className="px-3 py-2 w-[36rem]">Items</th>
                <th className="px-3 py-2 w-64">Carrier</th>
                <th className="px-3 py-2 w-16 text-center">Payment</th>
                <th className="px-3 py-2 w-40">Delivery Date</th>
                <th className="px-3 py-2 w-72">Notes</th>
                <th className="px-3 py-2 w-20">Delivery Charged</th>
                <th className="px-3 py-2 w-20">Delivery Quoted</th>
                <th className="px-3 py-2 w-24">Margin</th>
                <th className="px-3 py-2 w-56">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-sm">Loading…</td></tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-sm">No deliveries.</td></tr>
              )}
              {!loading && sorted.map((row, idx) => {
                const margin =
                  (row.delivery_charged == null ? 0 : Number(row.delivery_charged)) -
                  (row.delivery_quoted == null ? 0 : Number(row.delivery_quoted));

                const carrierChanged = (row.removalist_name || '—') !== lastCarrier;
                lastCarrier = row.removalist_name || '—';

                return (
                  <Fragment key={row.delivery_id}>
                    {carrierChanged && (
                      <tr className="bg-gray-50/80">
                        <td colSpan={12} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
                          Carrier: {lastCarrier}
                        </td>
                      </tr>
                    )}
                    <tr
                      className={`${idx % 2 ? 'bg-gray-50' : 'bg-white'} cursor-pointer hover:bg-gray-100 align-top`}
                      tabIndex={0}
                      onClick={() => goWorkorder(row.workorder_id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') goWorkorder(row.workorder_id);
                      }}
                    >
                      <td className="px-3 py-2 text-sm truncate">{row.customer_name || '—'}</td>
                      <td className="px-3 py-2 text-sm">{row.delivery_suburb || '—'}</td>
                      <td className="px-3 py-2 text-sm">{row.delivery_state || '—'}</td>
                      <td className="px-3 py-2 text-sm whitespace-pre-wrap break-words leading-6">{row.items_text || '—'}</td>
                      <td className="px-3 py-2 text-sm"><CarrierCell row={row} /></td>
                      <td className="px-3 py-2 text-sm text-center"><PaymentCell row={row} /></td>
                      <td className="px-3 py-2 text-sm"><DateCell row={row} /></td>
                      <td className="px-3 py-2 text-sm"><NotesCell row={row} /></td>
                      <td className="px-3 py-2 text-sm"><MoneyCell row={row} field="delivery_charged" /></td>
                      <td className="px-3 py-2 text-sm"><MoneyCell row={row} field="delivery_quoted" /></td>
                      <td className="px-3 py-2 text-sm">{fmtMoney(margin)}</td>
                      <td className="px-3 py-2 text-sm"><StatusCell row={row} /></td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    );
  };
  
  // Special Customer Collect block (always on top)
  const CustomerCollectBlock = ({ rowsCC }) => {
    const sorted = rowsCC; // already sorted in useMemo above
    return (
      <section className="rounded-xl border bg-white">
        <div className="p-3 text-center text-lg font-semibold">Customer Collect (All Dates)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full table-fixed">
            <thead className="bg-gray-100">
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                <th className="px-3 py-2 w-40">Name</th>
                <th className="px-3 py-2 w-32">Suburb</th>
                <th className="px-3 py-2 w-16">State</th>
                <th className="px-3 py-2 w-[36rem]">Items</th>
                <th className="px-3 py-2 w-64">Carrier</th>
                <th className="px-3 py-2 w-16 text-center">Payment</th>
                <th className="px-3 py-2 w-40">Delivery Date</th>
                <th className="px-3 py-2 w-72">Notes</th>
                <th className="px-3 py-2 w-20">Delivery Charged</th>
                <th className="px-3 py-2 w-20">Delivery Quoted</th>
                <th className="px-3 py-2 w-24">Margin</th>
                <th className="px-3 py-2 w-56">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-sm">Loading…</td></tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-sm">No Customer Collect deliveries.</td></tr>
              )}
              {!loading && sorted.map((row, idx) => {
                const margin =
                  (row.delivery_charged == null ? 0 : Number(row.delivery_charged)) -
                  (row.delivery_quoted == null ? 0 : Number(row.delivery_quoted));
                return (
                  <tr
                    key={row.delivery_id}
                    className={`${idx % 2 ? 'bg-gray-50' : 'bg-white'} cursor-pointer hover:bg-gray-100 align-top`}
                    tabIndex={0}
                    onClick={() => goWorkorder(row.workorder_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') goWorkorder(row.workorder_id);
                    }}
                  >
                    <td className="px-3 py-2 text-sm truncate">{row.customer_name || '—'}</td>
                    <td className="px-3 py-2 text-sm">{row.delivery_suburb || '—'}</td>
                    <td className="px-3 py-2 text-sm">{row.delivery_state || '—'}</td>
                    <td className="px-3 py-2 text-sm whitespace-pre-wrap break-words leading-6">{row.items_text || '—'}</td>
                    <td className="px-3 py-2 text-sm"><CarrierCell row={row} /></td>
                    <td className="px-3 py-2 text-sm text-center"><PaymentCell row={row} /></td>
                    <td className="px-3 py-2 text-sm"><DateCell row={row} /></td>
                    <td className="px-3 py-2 text-sm"><NotesCell row={row} /></td>
                    <td className="px-3 py-2 text-sm"><MoneyCell row={row} field="delivery_charged" /></td>
                    <td className="px-3 py-2 text-sm"><MoneyCell row={row} field="delivery_quoted" /></td>
                    <td className="px-3 py-2 text-sm">{fmtMoney(margin)}</td>
                    <td className="px-3 py-2 text-sm"><StatusCell row={row} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex items-center justify-center">
          <h1 className="text-2xl font-semibold tracking-tight">Delivery Operations</h1>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-6 py-6 px-4 flex-1">
        <main className="col-span-12">
          <div className="rounded-xl border bg-white">
            <div className="border-b p-4 grid gap-3 grid-cols-1 sm:grid-cols-3 items-center">
              <div className="w-full sm:max-w-xs">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search deliveries, items, carriers…"
                  className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>
              <div className="hidden sm:flex justify-center">
                <h2 className="text-lg font-semibold">Delivery Schedule</h2>
              </div>
              <div className="sm:hidden">
                <h2 className="text-lg font-semibold text-center">Delivery Schedule</h2>
              </div>
              <div />
            </div>

            <div className="space-y-8 p-4">
              {customerCollectRows.length > 0 && (
                <CustomerCollectBlock rowsCC={customerCollectRows} />
              )}

              {dates.length === 0 && !loading && customerCollectRows.length === 0 && (
                <div className="text-center text-sm text-gray-600">No “Booked for Delivery” jobs.</div>
              )}

              {dates.map(([dateKey, rowsForDate]) => (
                <DateBlock key={dateKey} dateKey={dateKey} rowsForDate={rowsForDate} />
              ))}
            </div>
          </div>
        </main>
      </div>

      <DeliveryTabs />
    </div>
  );
}
