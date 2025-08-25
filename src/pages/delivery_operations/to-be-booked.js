import { useEffect, useMemo, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

const EDITABLE_STATUSES = ['To Be Booked', 'Booked for Delivery', 'Delivery Completed'];
const ORDERED_STATES = ['VIC', 'NSW', 'QLD', 'ACT', 'WA', 'SA', 'TAS'];

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

/** Simple $-prefixed number input, right-aligned */
function CompactMoneyInput({
  value,
  onChange,
  onBlur,
  placeholder = '0.00',
  widthClass = 'w-20',
  inputRef,
  disabled,
}) {
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

  const [loading, setLoading] = useState(true);
  const [deliveries, setDeliveries] = useState([]);
  const [removalists, setRemovalists] = useState([]);
  const [search, setSearch] = useState('');
  const [savingIds, setSavingIds] = useState(new Set());
  const [savingWO, setSavingWO] = useState(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false); // collapsed by default for more room

  // --- current user id (2-chars) from localStorage ---
  const currentUserId = useMemo(() => {
    try {
      const raw = localStorage.getItem('user');
      const u = raw ? JSON.parse(raw) : null;
      const id = (u?.user_id ?? u?.id ?? u?.code ?? '').toString().toUpperCase();
      const trimmed = id.slice(0, 2);
      return trimmed && trimmed.length === 2 ? trimmed : 'NA';
    } catch {
      return 'NA';
    }
  }, []);

  // toast helpers
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
        const needFallback = raw.some((d) => d.items_text == null || d.outstanding_balance == null);
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
          const itemsText = d.items_text ?? (wo ? itemsTextFromWorkorderItems(wo.items || []) : '—');
          const outstanding =
            d.outstanding_balance != null ? Number(d.outstanding_balance)
            : wo ? Number(wo.outstanding_balance || 0) : null;
          const removalistName =
            d.removalist_name ||
            rems.find((r) => Number(r.id) === Number(d.removalist_id))?.name ||
            '';

          return {
            ...d,
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return deliveries;
    return deliveries.filter((d) =>
      [
        d.customer_name ?? '',
        d.delivery_suburb ?? '',
        d.delivery_state ?? '',
        d.items_text ?? '',
        d.invoice_id ?? '',
      ].join(' ').toLowerCase().includes(q)
    );
  }, [deliveries, search]);

  const groupByState = useMemo(() => {
    const groups = new Map();
    for (const d of filtered) {
      const st = d.delivery_state || 'Other';
      if (!groups.has(st)) groups.set(st, []);
      groups.get(st).push(d);
    }
    return groups;
  }, [filtered]);

  const OTHER_STATES = useMemo(
    () => [...groupByState.keys()].filter((s) => !ORDERED_STATES.includes(s)),
    [groupByState]
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
      default:    return code || 'Other States';
    }
  }, []);

  // Save helpers (with toasts) — always send 2-char user_id
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

      setDeliveries((list) =>
        list.map((row) => (row.delivery_id === deliveryId ? { ...row, ...patch } : row))
      );
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

  // ===== Carrier dropdown via portal (escapes table overflow) =====
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
        if (
          !menuRef.current?.contains(e.target) &&
          !anchorRef.current?.contains(e.target)
        ) {
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

  // ===== Cell components =====
  const CarrierCell = ({ row }) => {
    const [searchText, setSearchText] = useState(row.removalist_name || '');
    const [open, setOpen] = useState(false);
    const inputRef = useRef(null);
    const isSaving = savingIds.has(row.delivery_id);

    const q = (searchText || '').toLowerCase().trim();
    const list = !q
      ? removalists.slice(0, 50)
      : removalists.filter((r) => (`${r.id} ${r.name}`).toLowerCase().includes(q)).slice(0, 50);

    return (
      <div className="relative w-full">
        <input
          ref={inputRef}
          className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
          value={open ? searchText : (row.removalist_name || '')}
          placeholder="Search carrier…"
          onFocus={() => setOpen(true)}
          onChange={(e) => setSearchText(e.target.value)}
          disabled={isSaving}
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
              await saveDelivery(row.delivery_id, { removalist_id: Number(r.id) });
            }
          }}
        />
      </div>
    );
  };

  // New: Date cell (HTML5 date picker)
  const DateCell = ({ row }) => {
    const [val, setVal] = useState(() => {
      // normalize to yyyy-mm-dd if present
      if (!row.delivery_date) return '';
      const d = new Date(row.delivery_date);
      if (Number.isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 10);
    });

    useEffect(() => {
      if (!row.delivery_date) { setVal(''); return; }
      const d = new Date(row.delivery_date);
      setVal(Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10));
    }, [row.delivery_date]);

    const busy = savingIds.has(row.delivery_id);
    return (
      <input
        type="date"
        className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => saveDelivery(row.delivery_id, { delivery_date: val || null })}
        disabled={busy}
      />
    );
  };

  const NotesCell = ({ row }) => {
    const [val, setVal] = useState(row.notes ?? '');
    useEffect(() => { setVal(row.notes ?? ''); }, [row.notes]);
    const busy = savingIds.has(row.delivery_id) && val !== (row.notes || '');
    return (
      <div className="flex flex-col gap-1 w-full">
        <textarea
          className="w-full min-h-[38px] resize-y rounded border px-2 py-1 text-sm disabled:opacity-60"
          value={val}
          placeholder="Notes"
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => saveDelivery(row.delivery_id, { notes: val || null })}
          disabled={savingIds.has(row.delivery_id)}
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
      <div className="flex w-full flex-col items-center gap-1 text-center">
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
    );
  };

  const StatusCell = ({ row }) => (
    <select
      className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
      value={row.delivery_status}
      onChange={(e) => {
        const v = e.target.value;
        if (v !== row.delivery_status) saveDelivery(row.delivery_id, { delivery_status: v });
      }}
      disabled={savingIds.has(row.delivery_id)}
    >
      {EDITABLE_STATUSES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );

  // ===== Section renderer (State column removed; Date column added) =====
  const renderSection = (code) => {
    const rows = groupByState.get(code) || [];
    return (
      <section key={code} className="rounded-xl border bg-white">
        <div className="p-3 text-center text-lg font-semibold">{stateLabel(code)}</div>
        <div className="overflow-x-auto">
          <table className="min-w-full table-fixed">
            <thead className="bg-gray-100">
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
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
                {/* expanded status */}
                <th className="px-3 py-2 w-64">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-sm">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-sm">No deliveries.</td></tr>
              )}
              {rows.map((row, idx) => {
                const margin =
                  (row.delivery_charged == null ? 0 : Number(row.delivery_charged)) -
                  (row.delivery_quoted == null ? 0 : Number(row.delivery_quoted));
                const rowCls = idx % 2 ? 'bg-gray-50' : 'bg-white';
                return (
                  <tr key={row.delivery_id} className={`${rowCls} hover:bg-gray-50 align-top`}>
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

  const renderOther = () =>
    [...OTHER_STATES].sort().map((code) => (
      <div key={code} className="mt-6">{renderSection(code)}</div>
    ));

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setSidebarOpen((s) => !s)}
            className="rounded-lg border px-3 py-2 hover:bg-gray-50"
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            {/* Hamburger icon */}
            <div className="space-y-1">
              <span className="block h-0.5 w-5 bg-gray-700"></span>
              <span className="block h-0.5 w-5 bg-gray-700"></span>
              <span className="block h-0.5 w-5 bg-gray-700"></span>
            </div>
          </button>
          <h1 className="text-2xl font-semibold tracking-tight flex-1 text-center">
            Delivery Operations
          </h1>
          <div className="w-[40px]" /> {/* spacer */}
        </div>
      </header>

      <div className="grid grid-cols-12 gap-6 py-6 px-4">
        {/* Sidebar (collapsible) */}
        {sidebarOpen && (
          <aside className="col-span-12 sm:col-span-3 lg:col-span-2">
            <div className="sticky top-6 rounded-xl border bg-white p-4">
              <div className="mb-4 font-semibold">Current</div>
              <nav className="space-y-1">
                <Link to="/delivery_operations" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Current Operations
                </Link>
                <span className="block rounded-md bg-gray-100 px-3 py-2 text-sm font-medium">
                  To Be Booked
                </span>
                <Link to="/delivery_operations/schedule" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Delivery Schedule
                </Link>
              </nav>
              <div className="my-4 h-px bg-gray-200" />
              <div className="mb-2 font-semibold">Completed</div>
              <nav className="space-y-1">
                <Link to="/delivery_operations/completed-operations" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Operations Completed
                </Link>
                <Link to="/delivery_operations/completed-deliveries" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Deliveries Completed
                </Link>
              </nav>
              <div className="my-4 h-px bg-gray-200" />
              <Link
                to="/dashboard"
                className="block rounded-md px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
              >
                Exit
              </Link>
            </div>
          </aside>
        )}

        {/* Main */}
        <main className={sidebarOpen ? 'col-span-12 sm:col-span-9 lg:col-span-10' : 'col-span-12'}>
          <div className="rounded-xl border bg-white">
            <div className="border-b p-4 grid gap-3 grid-cols-1 sm:grid-cols-3 items-center">
              <div className="w-full sm:max-w-xs">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search deliveries or items…"
                  className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>
              <div className="hidden sm:flex justify-center">
                <h2 className="text-lg font-semibold">Deliveries to be Booked</h2>
              </div>
              <div className="sm:hidden">
                <h2 className="text-lg font-semibold text-center">Deliveries to be Booked</h2>
              </div>
              <div />
            </div>

            <div className="space-y-6 p-4">
              {ORDERED_STATES.map((code) => renderSection(code))}
              {renderOther()}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
