import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import DeliveryTabs from '../../components/DeliveryTabs';

const ALL_STATUSES = ['To Be Booked', 'Booked for Delivery', 'Delivery Completed'];
const PAGE_SIZE = 50;

// Row navigation helpers
const useRowNav = (navigate) => {
  const go = useCallback((wid) => {
    if (!wid) return;
    navigate(`/delivery_operations/workorder/${wid}`);
  }, [navigate]);
  return go;
};

// stop row click when using inputs
const stopRowNav = {
  onClick: (e) => e.stopPropagation(),
  onMouseDown: (e) => e.stopPropagation(),
  onKeyDown: (e) => e.stopPropagation(),
};

const CARRIER_COLOR_RULES = [
  { like: 'moving soon', color: '#F4B084' },
  { like: 'dtl', color: '#BDD7EE' },
  { like: 'coastal', color: '#FDCDFE' }, // Coastal Breeze
  { like: 'bnl', color: '#92D050' },
  { like: 'bass strait', color: '#FEFF43' },
  { like: 'rjd', color: '#FFFF00' },     // fixed hex: #FFFF00
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
];

// Resolve a background color based on LIKE/substring match
function carrierColor(name) {
  const s = (name || '').toLowerCase();
  const rule = CARRIER_COLOR_RULES.find(r => s.includes(r.like));
  return rule?.color || null;
}

// fmt helpers
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
// For sorting (YYYY-MM-DD)
function ymd(dateIso) {
  if (!dateIso) return '';
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// For display (DD-Mon)
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Replace space with hyphen: "01-Sept"
  return d
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    .replace(' ', '-');
}

/** --- Reusable compact $ input (same feel as schedule page) --- */
function CompactMoneyInput({ value, onChange, onBlur, placeholder = '0.00', widthClass = 'w-20', disabled }) {
  return (
    <div className={`inline-flex items-center rounded border bg-white ${widthClass} ${disabled ? 'opacity-60' : ''}`}>
      <span className="px-2 text-gray-500 select-none">$</span>
      <input
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

/** Money cell wrapper to PATCH on blur */
function MoneyCell({ row, field, savingIds, saveDelivery }) {
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
}

export default function CompletedDeliveriesPage() {
  const navigate = useNavigate();
  const goWorkorder = useRowNav(navigate);

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [savingIds, setSavingIds] = useState(new Set());
  const [page, setPage] = useState(1);

  // current user id (2-char)
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

  // toasts
  function startToast(prefix, key) {
    const id = `${prefix}-${key}-${Date.now()}`;
    toast.loading('Updating…', { id });
    return id;
  }
  function resolveToast(id, ok, msg) {
    (ok ? toast.success : toast.error)(msg, { id });
  }

  // LOAD
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }

    let mounted = true;
    (async () => {
      setLoading(true);
      toast.loading('Loading deliveries…', { id: 'completed-load' });
      try {
        const dRes = await fetch('/api/delivery?include_removalists=1');
        const dData = await dRes.json();
        if (!dRes.ok) throw new Error(dData?.error || 'Failed to load deliveries');

        const rowsRaw = Array.isArray(dData) ? dData : (dData.deliveries || []);
        const rems = Array.isArray(dData.removalists) ? dData.removalists : [];

        // Only "Delivery Completed"
        const completed = rowsRaw.filter((d) => String(d.delivery_status || '') === 'Delivery Completed');

        // Enrich if items_text/outstanding missing
        const needFallback = completed.some((d) => d.items_text == null || d.outstanding_balance == null || d.items);
        let woMap = {};
        if (needFallback) {
          const woIds = [...new Set(completed.map((d) => d.workorder_id).filter(Boolean))];
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

        const rows = completed.map((d) => {
          const wo = d.workorder_id ? woMap[d.workorder_id] : null;

          let itemsText = '—';
          if (wo?.items?.length) {
            itemsText = itemsTextFromWorkorderItems(wo.items);
          } else if (Array.isArray(d.items) && d.items.length) {
            itemsText = itemsTextFromWorkorderItems(d.items);
          } else if (typeof d.items_text === 'string') {
            itemsText = d.items_text.replace(/\b(\d+)(?:\.0+)\b/g, '$1');
          }

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
        // Sort newest first: by delivery_date desc then delivery_id desc
        rows.sort((a, b) => {
          const ad = ymd(a.delivery_date) || '';
          const bd = ymd(b.delivery_date) || '';
          if (ad !== bd) return bd.localeCompare(ad);
          return Number(b.delivery_id) - Number(a.delivery_id);
        });

        setRows(rows);
        toast.success('Deliveries loaded', { id: 'completed-load' });
      } catch (e) {
        toast.error(e.message || 'Failed to load', { id: 'completed-load' });
      } finally {
        if (mounted) setLoading(false);
      }
    })();

  return () => { mounted = false; };
  }, [navigate]);

  // SEARCH then paginate
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((d) =>
      [
        d.invoice_id ?? '',
        d.customer_name ?? '',
        d.delivery_suburb ?? '',
        d.delivery_state ?? '',
        d.items_text ?? '',
        d.removalist_name ?? '',
        d.notes ?? '',
      ].join(' ').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totalPages = Math.max(1, Math.ceil(searched.length / PAGE_SIZE));
  const pageSafe = Math.min(Math.max(1, page), totalPages);
  const paged = useMemo(() => {
    const start = (pageSafe - 1) * PAGE_SIZE;
    return searched.slice(start, start + PAGE_SIZE);
  }, [searched, pageSafe]);

  // SAVE helpers
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

      // If status was changed away from "Delivery Completed", remove row from this page
      if ('delivery_status' in patch && patch.delivery_status !== 'Delivery Completed') {
        setRows((list) => list.filter((r) => r.delivery_id !== deliveryId));
      } else {
        setRows((list) =>
          list.map((row) => (row.delivery_id === deliveryId ? { ...row, ...patch } : row))
        );
      }

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

  // === Readonly cells ===
  const PaymentBadge = ({ outstanding }) => {
    const isPaid = !(outstanding == null || Number(outstanding) > 0);
    return isPaid ? (
      <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-[11px] font-semibold text-green-700 ring-1 ring-inset ring-green-200">
        Paid
      </span>
    ) : (
      <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
        Outstanding
      </span>
    );
  };

  // Editable: Notes + Status
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
        />
        {busy && <span className="text-xs text-gray-400">Saving…</span>}
      </div>
    );
  };

  const StatusCell = ({ row }) => (
    <select
      className="w-full rounded border px-2 py-1 text-sm disabled:opacity-60"
      value={row.delivery_status}
      onChange={(e) => {
        const v = e.target.value;
        // Validation: only allow completing when fully paid
        if (v === 'Delivery Completed') {
          const obal = Number(row.outstanding_balance || 0);
          if (Number.isFinite(obal) && obal > 0) {
            toast.error('Cannot set to "Delivery Completed" until the balance is fully paid');
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

  // Pagination control (Prev / numbers / … / Next)
  const Pagination = () => {
    if (totalPages <= 1) return null;

    const goto = (p) => setPage(Math.min(Math.max(1, p), totalPages));

    const nums = [];
    const show = (n) => nums.push(n);
    const addGap = () => nums.push('…');

    // pages to show: 1, 2, current-1, current, current+1, last-1, last (deduped/ordered)
    const set = new Set([1, 2, pageSafe - 1, pageSafe, pageSafe + 1, totalPages - 1, totalPages]
      .filter((n) => n >= 1 && n <= totalPages)
      .sort((a, b) => a - b));

    let last = 0;
    for (const n of set) {
      if (last && n > last + 1) addGap();
      show(n);
      last = n;
    }

    return (
      <div className="flex items-center justify-end gap-1 p-3 text-sm">
        <button
          className="rounded px-2 py-1 border disabled:opacity-40"
          onClick={() => goto(pageSafe - 1)}
          disabled={pageSafe <= 1}
        >
          ← Previous
        </button>
        {nums.map((n, i) =>
          n === '…' ? (
            <span key={`gap-${i}`} className="px-2 text-gray-400">…</span>
          ) : (
            <button
              key={n}
              onClick={() => goto(n)}
              className={`h-8 min-w-8 rounded px-2 border ${n === pageSafe ? 'bg-gray-900 text-white' : 'hover:bg-gray-50'}`}
            >
              {n}
            </button>
          )
        )}
        <button
          className="rounded px-2 py-1 border disabled:opacity-40"
          onClick={() => goto(pageSafe + 1)}
          disabled={pageSafe >= totalPages}
        >
          Next →
        </button>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex items-center justify-center">
          <h1 className="text-2xl font-semibold tracking-tight">Delivery Operations</h1>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-6 py-6 px-4 flex-1">
        {/* Main */}
        <main className="col-span-12">
          <div className="rounded-xl border bg-white">
            {/* Toolbar */}
            <div className="border-b p-4 grid gap-3 grid-cols-1 sm:grid-cols-3 items-center">
              <div className="w-full sm:max-w-xs">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setPage(1);
                    setSearch(e.target.value);
                  }}
                  placeholder="Search"
                  className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>
              <div className="hidden sm:flex justify-center">
                <h2 className="text-lg font-semibold">Deliveries Completed</h2>
              </div>
              <div className="sm:hidden">
                <h2 className="text-lg font-semibold text-center">Deliveries Completed</h2>
              </div>
              <div />
            </div>

            {/* Table */}
            <div className="p-4">
              <div className="overflow-x-auto rounded-lg border">
                <table className="min-w-full table-fixed">
                  <thead className="bg-gray-100">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                      <th className="px-3 py-2 w-28">Invoice</th>
                      <th className="px-3 py-2 w-44">Name</th>
                      <th className="px-3 py-2 w-32">Suburb</th>
                      <th className="px-3 py-2 w-16">State</th>
                      <th className="px-3 py-2 w-[32rem]">Items</th>
                      <th className="px-3 py-2 w-56">Carrier</th>
                      <th className="px-3 py-2 w-20 text-center">Payment</th>
                      <th className="px-3 py-2 w-36">Delivery Date</th>{/* read-only */}
                      <th className="px-3 py-2 w-72">Notes</th>
                      <th className="px-3 py-2 w-24">Delivery Charged</th>
                      <th className="px-3 py-2 w-24">Delivery Quoted</th>
                      <th className="px-3 py-2 w-24">Margin</th>
                      <th className="px-3 py-2 w-56">Status</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-gray-100">
                    {loading && (
                      <tr><td colSpan={13} className="px-3 py-6 text-center text-sm">Loading…</td></tr>
                    )}
                    {!loading && paged.length === 0 && (
                      <tr><td colSpan={13} className="px-3 py-6 text-center text-sm">No deliveries.</td></tr>
                    )}

                    {paged.map((row, idx) => {
                      const margin =
                        (row.delivery_charged == null ? 0 : Number(row.delivery_charged)) -
                        (row.delivery_quoted == null ? 0 : Number(row.delivery_quoted));
                      const rowCls = idx % 2 ? 'bg-gray-50' : 'bg-white';
                      return (
                        <tr
                          key={row.delivery_id}
                          className={`${rowCls} cursor-pointer hover:bg-gray-100 align-top`}
                          tabIndex={0}
                          onClick={() => goWorkorder(row.workorder_id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') goWorkorder(row.workorder_id);
                          }}
                        >
                          <td className="px-3 py-2 text-sm">{row.invoice_id ?? '—'}</td>
                          <td className="px-3 py-2 text-sm truncate">{row.customer_name || '—'}</td>
                          <td className="px-3 py-2 text-sm">{row.delivery_suburb || '—'}</td>
                          <td className="px-3 py-2 text-sm">{row.delivery_state || '—'}</td>
                          <td className="px-3 py-2 text-sm whitespace-pre-wrap break-words leading-6">
                            {row.items_text || '—'}
                          </td>
                          <td className="px-3 py-2 text-sm">
                            {(row.removalist_name && row.removalist_name.trim()) ? (
                              (() => {
                                const bg = carrierColor(row.removalist_name);
                                return (
                                  <span
                                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset"
                                    style={bg ? { backgroundColor: bg, borderColor: 'rgba(0,0,0,0.08)' } : undefined}
                                    title={row.removalist_name}
                                  >
                                    {row.removalist_name}
                                  </span>
                                );
                              })()
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2 text-sm text-center"><PaymentBadge outstanding={row.outstanding_balance} /></td>
                          <td className="px-3 py-2 text-sm">{formatDate(row.delivery_date) || '—'}</td>
                          <td className="px-3 py-2 text-sm" {...stopRowNav}><NotesCell row={row} /></td>

                          {/* ✅ EDITABLE: Delivery Charged */}
                          <td className="px-3 py-2 text-sm" {...stopRowNav}>
                            <MoneyCell
                              row={row}
                              field="delivery_charged"
                              savingIds={savingIds}
                              saveDelivery={saveDelivery}
                            />
                          </td>

                          {/* ✅ EDITABLE: Delivery Quoted */}
                          <td className="px-3 py-2 text-sm" {...stopRowNav}>
                            <MoneyCell
                              row={row}
                              field="delivery_quoted"
                              savingIds={savingIds}
                              saveDelivery={saveDelivery}
                            />
                          </td>

                          <td className="px-3 py-2 text-sm">{fmtMoney(margin)}</td>
                          <td className="px-3 py-2 text-sm" {...stopRowNav}><StatusCell row={row} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <Pagination />
            </div>
          </div>
        </main>
      </div>

      <DeliveryTabs />
    </div>
  );
}
