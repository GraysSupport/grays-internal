import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { getRoles, hasAnyRole } from '../utils/auth';
import { currentUserIsWorkshop, identityHeaders } from '../utils/workshopAccess';
import { endExpiredSession } from '../utils/session';

// G23 (owner, 30 Oct 2026): cancel / reopen a workorder. The server decides (lib/workorderCancel.js):
// cancelling cancels every item, returns its stock and frees its lots; reopening puts the items
// back. Only superadmin / admin / logistics / sales see the buttons — the same roles the server allows.

const CANCEL_ROLES = ['superadmin', 'admin', 'logistics', 'sales'];
const PRIMARY = 'rounded bg-[#B50B1D] px-4 py-2 text-white hover:bg-[#8f0917] disabled:opacity-50';
const SECONDARY = 'rounded border border-gray-300 bg-white px-4 py-2 text-gray-900 hover:bg-gray-50 disabled:opacity-50';

const COPY = {
  cancel: {
    title: 'Cancel this workorder?',
    body: [
      'Every item on it is cancelled and its stock is returned.',
      'Lots assigned to its items go back to In Stock.',
      'It leaves current operations, the workshop list and sales figures. You can reopen it later.',
    ],
    confirm: 'Yes, cancel workorder',
    keep: 'Keep workorder',
    send: { status: 'Cancelled' },
    done: 'Workorder cancelled',
  },
  reopen: {
    title: 'Reopen this workorder?',
    body: [
      'Its items go back to where they were and their stock is taken again.',
      'Lots are not re-assigned — scan or assign them again if needed.',
    ],
    confirm: 'Yes, reopen workorder',
    keep: 'Keep it cancelled',
    send: { status: 'Work Ordered', reopen: true }, // the server reopens only on this explicit flag
    done: 'Workorder reopened',
  },
};

function ConfirmDialog({ kind, saving, error, onConfirm, onClose }) {
  const c = COPY[kind];
  const keepRef = useRef(null);
  useEffect(() => {
    keepRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="wo-cancel-title">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
        <h2 id="wo-cancel-title" className="text-lg font-bold text-gray-900">{c.title}</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">
          {c.body.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {error && <p role="alert" className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={keepRef} type="button" onClick={onClose} disabled={saving} className={SECONDARY}>{c.keep}</button>
          <button type="button" onClick={onConfirm} disabled={saving} className={PRIMARY}>{saving ? 'Saving…' : c.confirm}</button>
        </div>
      </div>
    </div>
  );
}

export default function WorkorderCancel({ workorderId, status, onChanged }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(null); // 'cancel' | 'reopen'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const canManage = hasAnyRole(getRoles(), CANCEL_ROLES) && !currentUserIsWorkshop();
  const cancelled = String(status) === 'Cancelled';
  const open_ = String(status) === 'Work Ordered'; // a Completed workorder is set back to Work Ordered first

  const close = () => { setOpen(null); setError(null); };
  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workorder?id=${encodeURIComponent(workorderId)}`, {
        method: 'PUT',
        headers: identityHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(COPY[open].send),
      });
      if (res.status === 401) { endExpiredSession(navigate); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save');
      toast.success(COPY[open].done);
      setOpen(null);
      onChanged(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {cancelled && (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-gray-400 bg-gray-100 p-3 text-sm text-gray-900">
          <span><span className="font-semibold">This workorder is cancelled.</span> Its items were cancelled, their stock returned and their lots put back in stock.</span>
          {canManage && <button type="button" onClick={() => setOpen('reopen')} className={SECONDARY}>Reopen workorder</button>}
        </div>
      )}
      {open_ && canManage && (
        <div className="mb-4 flex justify-end">
          <button type="button" onClick={() => setOpen('cancel')} className={SECONDARY}>Cancel workorder</button>
        </div>
      )}
      {open && <ConfirmDialog kind={open} saving={saving} error={error} onConfirm={confirm} onClose={close} />}
    </>
  );
}
