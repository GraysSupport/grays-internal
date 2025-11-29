import { useEffect, useMemo, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import DeliveryTabs from '../../components/DeliveryTabs';

const EDITABLE_STATUSES = ['To Be Booked', 'Booked for Delivery'];
const ORDERED_STATES = ['VIC', 'NSW', 'QLD', 'ACT', 'WA', 'SA', 'TAS', 'NT'];

// Row navigation helpers
const useRowNav = (navigate) => {
  const go = useCallback((wid) => {
    if (!wid) return;
    navigate(`/delivery_operations/workorder/${wid}`);
  }, [navigate]);
  return go;
};

const CARRIER_COLOR_RULES = [
  { like: 'moving soon', color: '#F4B084' },
  { like: 'dtl', color: '#BDD7EE' },
  { like: 'coastal', color: '#FDCDFE' }, // Coastal Breeze
  { like: 'bnl', color: '#92D050' },
  { like: 'bass strait', color: '#FEFF43' },
  { like: 'rjd', color: '#FFFF00' },
  { like: 'iron armour', color: '#CCCCFF' },
  { like: 'chris watkins', color: '#6767ff' },
  { like: 'ej shaws', color: '#ff5555' },
  { like: 'a grade', color: '#e9ff63' },
  { like: 'slingshot', color: '#92d050' },
  { like: 'sa removals', color: '#66ccff' },
  { like: 'first transport', color: '#99ffcc' },
  { like: 'big post', color: '#99ffcc' },
  { like: 'allied', color: '#99ffcc' },
  { like: 'customer collect', color: '#9ec2e3' },
  { like: 'eastside', color: '#9efe9c' },
  { like: 'thompson', color: '#ff9999' },
  { like: 'brs', color: '#d0cece' },
  { like: 'grays', color: '#bfd6ebff' },
];

function carrierColor(name) {
  const s = (name || '').toLowerCase();
  const rule = CARRIER_COLOR_RULES.find(r => s.includes(r.like));
  return rule?.color || null;
}

function shouldBlockRowNav(e) {
  if (!e) return false;
  if (e.defaultPrevented) return true;
  const t = e.target;
  if (t.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"], .no-row-nav')) {
    return true;
  }
  const sel = window.getSelection?.();
  if (sel && sel.toString().length > 0) return true;
  return false;
}

const stopRowNav = {
  onClick: (e) => e.stopPropagation(),
  onMouseDown: (e) => e.stopPropagation(),
  onKeyDown: (e) => e.stopPropagation(),
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
  return items
    .map((it) => {
      const qty = formatQty(it.quantity);
      const name = it.product_name || it.product_id || '';
      const cond = it.condition || '';
      return `${qty} × ${name}${cond ? ` (${cond})` : ''}`;
    })
    .join(', ');
}


/* ======= DATE HELPERS (TZ-SAFE) ======= */
function asYMD(x) {
  if (!x) return '';
  if (typeof x === 'string') {
    const m = x.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const d = new Date(x);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
/* ===================================== */

/** $-prefixed number input */
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

export default function ToBeBookedDeliveriesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const urlParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const stateParam = (urlParams.get('state') || '').toUpperCase(); // <-- NEW: deep-link state filter

  const goWorkorder = useRowNav(navigate);

  const [loading, setLoading] = useState(true);
  const [deliveries, setDeliveries] = useState([]);
  const [removalists, setRemovalists] = useState([]);
  const [search, setSearch] = useState('');
  const [savingIds, setSavingIds] = useState(new Set());
  const [savingWO, setSavingWO] = useState(new Set());

  const currentUserId = useMemo(() => {
    try {
      const raw = localStorage.getItem('user');
      const u = raw ? JSON.parse(raw) : null;
      const id = (u?.user_id ?? u?.id ?? u?.code ?? '').toString().toUpperCase();
      const trimmed = id.slice(0, 2);
      return trimmed && trimmed.length === 2 ? trimmed : 'NA';
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

  // Load deliveries + carriers
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }

    let mounted = true;
    const load = async () => {
      setLoading(true);
      toast.loading('Loading deliveries…', { id: 'deliv-load' });
      try {
        const dRes = await fetch('/api/delivery?include_removalists=1');
        const dData = await dRes.json();
        if (!dRes.ok) throw new Error(dData?.error || 'Failed to load deliveries');

        const rowsRaw = Array.isArray(dData) ? dData : (dData.deliveries || []);
        const rems = Array.isArray(dData.removalists) ? dData.removalists : [];

        const raw = rowsRaw.filter((d) => String(d.delivery_status || '') === 'To Be Booked');

        // Enrich if items_text/outstanding missing
        const needFallback = raw.some((d) => d.items_text == null || d.outstanding_balance == null || d.items);
        let woMap = {};
        if (needFallback) {
          const woIds = [...new Set(raw.map((d) => d.workorder_id).filter(Boolean))];
          await Promise.all(
            woIds.map(async (wid) => {
              try {
                const wRes = await fetch(`/api/workorder?id=${encodeURIComponent(wid)}`);
                const wData = await wRes.json();
                if (wRes.ok) woMap[wid] = wData;
              } catch {}
            })
          );
        }

        const rows = raw.map((d) => {
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

          const dateYMD = asYMD(d.delivery_date);

          return {
            ...d,
            delivery_date: dateYMD,
            items_text: itemsText,
            outstanding_balance: outstanding,
            removalist_name: removalistName,
          };
        });

        if (!mounted) return;
        setDeliveries(rows);
        setRemovalists(rems);
        toast.success('Deliveries loaded', { id: 'deliv-load' });
      } catch (e) {
        toast.error(e.message || 'Failed to load', { id: 'deliv-load' });
      } finally {
        if (mounted) setLoading(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [navigate]);

  // Text search
  const filtered = useMemo(() => {
    let list = deliveries;
    // URL state filter first (if present)
    if (stateParam) {
      list = list.filter((d) => (d.delivery_state || '').toUpperCase() === stateParam);
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((d) =>
      [
        d.customer_name ?? '',
        d.delivery_suburb ?? '',
        d.delivery_state ?? '',
        d.items_text ?? '',
        d.invoice_id ?? '',
      ].join(' ').toLowerCase().includes(q)
    );
  }, [deliveries, search, stateParam]);

  // Group by state
  const groupByState = useMemo(() => {
    const groups = new Map();
    for (const d of filtered) {
      const st = (d.delivery_state || 'Other').toUpperCase();
      if (!groups.has(st)) groups.set(st, []);
      groups.get(st).push(d);
    }
    return groups;
  }, [filtered]);

  const AVAILABLE_STATES = useMemo(() => [...groupByState.keys()], [groupByState]);
  const OTHER_STATES = useMemo(
    () => AVAILABLE_STATES.filter((s) => !ORDERED_STATES.includes(s)),
    [AVAILABLE_STATES]
  );

  const stateLabel = useCallback((code) => {
    switch (code) {
      case 'VIC': return 'Victoria';
      case 'NSW': return 'New South Wales';
      case 'QLD': return 'Queensland';
      case 'ACT': return 'Australian Capital Territory';
      case 'TAS': return 'Tasmania';
      case 'WA':  return 'Western Australia';
      case 'SA':  return 'South Australia';
      case 'NT':  return 'Northern Territory';
      default:    return code || 'Other States';
    }
  }, []);

  // Save helpers
  const saveDelivery = useCallback(async (deliveryId, patch) => {
    if (!deliveryId || !patch || typeof patch !== 'object') return;
    const toastId = startToast('saveDelivery', deliveryId);
    setSavingIds((prev) => new Set(prev).add(deliveryId));
    try {
      const res = await fetch(`/api/delivery?id=${encodeURIComponent(deliveryId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, user_id: currentUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Save failed');

      setDeliveries((list) => {
        if ('delivery_status' in patch && patch.delivery_status !== 'To Be Booked') {
          return list.filter((r) => r.delivery_id !== deliveryId);
        }
        return list.map((row) =>
          row.delivery_id === deliveryId
            ? { ...row, ...patch, delivery_date: asYMD(patch.delivery_date ?? row.delivery_date) }
            : row
        );
      });
      resolveToast(toastId, true, 'Saved');
    } catch (e) {
      resolveToast(toastId, false, e.message || 'Save failed');
    } finally {
      setSavingIds((prev) => {
        const copy = new Set(prev);
        copy.delete(deliveryId);
        return copy;
      });
    }
  }, [currentUserId]);

  const saveWorkorderPayment = useCallback(async (workorder_id, newOutstanding) => {
    if (!workorder_id) return;
    const toastId = startToast('saveWO', workorder_id);
    setSavingWO((prev) => new Set(prev).add(workorder_id));
    try {
      const res = await fetch(`/api/workorder?id=${encodeURIComponent(workorder_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outstanding_balance: newOutstanding, user_id: currentUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Payment update failed');

      setDeliveries((list) =>
        list.map((row) =>
          row.workorder_id === workorder_id ? { ...row, outstanding_balance: newOutstanding } : row
        )
      );
      resolveToast(toastId, true, 'Payment updated');
    } catch (e) {
      resolveToast(toastId, false, e.message || 'Payment save failed');
    } finally {
      setSavingWO((prev) => {
        const copy = new Set(prev);
        copy.delete(workorder_id);
        return copy;
      });
    }
  }, [currentUserId]);

  // Dropdown via portal
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
        {options.length ? options.map((r) => {
          const bg = carrierColor(r.name);
          return (
            <button
              key={r.id}
              type="button"
              className="block w-full cursor-pointer px-3 py-2 text-left text-sm"
              style={bg ? { backgroundColor: bg } : undefined}
              onMouseDown={() => onPick(r)}
            >
              <div className="font-medium">{r.name}</div>
              <div className="text-xs text-gray-500">ID: {r.id}</div>
            </button>
          );
        }) : (
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

    const displayName =
      (row.removalist_name && row.removalist_name.trim())
        ? row.removalist_name
        : (row.removalist_id != null
            ? (removalists.find(r => Number(r.id) === Number(row.removalist_id))?.name || '')
            : ''
          );

    const colorHex = carrierColor(displayName);
    const inputStyle = colorHex ? { backgroundColor: colorHex } : undefined;

    useEffect(() => { if (!open) setSearchText(displayName || ''); }, [displayName, open]);

    const q = (searchText || '').toLowerCase().trim();
    const list = !q
      ? removalists.slice(0, 50)
      : removalists.filter((r) => (`${r.id} ${r.name}`).toLowerCase().includes(q)).slice(0, 50);

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
          style={inputStyle}
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
                removalist_name: r.name,
              });
            }
          }}
        />
      </div>
    );
  };

  const DateCell = ({ row }) => {
    const [val, setVal] = useState(() => asYMD(row.delivery_date));
    useEffect(() => { setVal(asYMD(row.delivery_date)); }, [row.delivery_date]);
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
        {busy ? <span className="text-xs text-gray-400">Saving…</span> : <div className="w-full flex justify-center">{label}</div>}
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

  const StatusCell = ({ row }) => {
    const isCustomerCollect = Number(row.removalist_id) === 15;
    return (
      <select
        className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
        value={row.delivery_status}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'Booked for Delivery') {
            if (!row.removalist_id) { toast.error('Set Carrier before booking for delivery'); return; }
            if (!row.delivery_date && !isCustomerCollect) {
              toast.error('Set Delivery Date before booking for delivery');
              return;
            }
          }
          if (v !== row.delivery_status) saveDelivery(row.delivery_id, { delivery_status: v });
        }}
        disabled={savingIds.has(row.delivery_id)}
        {...stopRowNav}
      >
        {EDITABLE_STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
      </select>
    );
  };

  // Section renderer
  const renderSection = (code) => {
    const rows = (groupByState.get(code) || []).map(r => ({ ...r, delivery_date: asYMD(r.delivery_date) }));
    return (
      <section key={code} className="rounded-xl border bg-white">
        <div className="p-3 flex items-center justify-between">
          <div className="text-lg font-semibold">{stateLabel(code)}</div>
          <div className="text-sm text-gray-500">Jobs: {rows.length}</div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full table-fixed">
            <thead className="bg-gray-100">
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                <th className="px-3 py-2 w-28">Invoice</th>
                <th className="px-3 py-2 w-40">Name</th>
                <th className="px-3 py-2 w-32">Suburb</th>
                <th className="px-3 py-2 w-[40rem]">Items</th>
                <th className="px-3 py-2 w-80">Carrier</th>
                <th className="px-3 py-2 w-16 text-center">Payment</th>
                <th className="px-3 py-2 w-40">Delivery Date</th>
                <th className="px-3 py-2 w-72">Notes</th>
                <th className="px-3 py-2 w-20">Delivery Charged</th>
                <th className="px-3 py-2 w-20">Delivery Quoted</th>
                <th className="px-3 py-2 w-24">Margin</th>
                <th className="px-3 py-2 w-64">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && <tr><td colSpan={12} className="px-3 py-6 text-center text-sm">Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={12} className="px-3 py-6 text-center text-sm">No deliveries.</td></tr>}
              {rows.map((row, idx) => {
                const margin =
                  (row.delivery_charged == null ? 0 : Number(row.delivery_charged)) -
                  (row.delivery_quoted == null ? 0 : Number(row.delivery_quoted));
                const rowCls = idx % 2 ? 'bg-gray-50' : 'bg-white';
                return (
                  <tr
                    key={row.delivery_id}
                    className={`${rowCls} cursor-pointer hover:bg-gray-100 align-top`}
                    tabIndex={0}
                    onClick={(e) => { if (!shouldBlockRowNav(e)) goWorkorder(row.workorder_id); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') goWorkorder(row.workorder_id); }}
                  >
                    <td className="px-3 py-2 text-sm font-mono">{row.invoice_id || '—'}</td>
                    <td className="px-3 py-2 text-sm truncate">{row.customer_name || '—'}</td>
                    <td className="px-3 py-2 text-sm">{row.delivery_suburb || '—'}</td>
                    <td className="px-3 py-2 text-sm whitespace-pre-wrap break-words leading-6">
                      {row.items_text || '—'}
                    </td>
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

  // Which sections to render?
  const orderedToShow = stateParam
    ? ORDERED_STATES.filter((s) => AVAILABLE_STATES.includes(s) && s === stateParam)
    : ORDERED_STATES.filter((s) => AVAILABLE_STATES.includes(s));

  const otherToShow = stateParam
    ? OTHER_STATES.filter((s) => s === stateParam)
    : [...OTHER_STATES].sort();

  const nothingForState = stateParam && !AVAILABLE_STATES.includes(stateParam);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Delivery Operations</h1>

          <div className="flex items-center gap-3">
            {stateParam && (
              <span className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-sm text-blue-700 ring-1 ring-inset ring-blue-200">
                State: {stateParam}
                <button
                  className="text-blue-700 hover:underline"
                  onClick={() => navigate('/delivery_operations/to-be-booked')}
                >
                  clear
                </button>
              </span>
            )}
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search deliveries or items…"
              className="w-56 rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
            />
          </div>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-6 py-6 px-4 flex-1">
        <main className="col-span-12">
          <div className="rounded-xl border bg-white">
            <div className="border-b p-4">
              <h2 className="text-lg font-semibold text-center sm:text-left">Deliveries to be Booked</h2>
              {stateParam && nothingForState && (
                <div className="mt-2 text-sm text-red-600">
                  No “To Be Booked” deliveries in {stateParam}.
                </div>
              )}
            </div>

            <div className="space-y-6 p-4">
              {orderedToShow.map((code) => renderSection(code))}
              {otherToShow.map((code) => (
                <div key={code} className="mt-6">{renderSection(code)}</div>
              ))}

              {!loading && AVAILABLE_STATES.length === 0 && (
                <div className="text-center text-sm text-gray-600 py-8">
                  No “To Be Booked” deliveries.
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      <DeliveryTabs />
    </div>
  );
}
