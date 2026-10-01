import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders, getRoles, hasAnyRole } from '../utils/auth';

// G7 (Nick, 28 Sep 2026) — one shared notes panel at the top of the To-Be-Booked tab for
// "when drivers are coming in next". Everyone on the tab reads it; logistics / admin /
// superadmin edit it. Backed by GET/PUT /api/delivery?resource=board-notes
// (lib/deliveryBoardNotes.js) — the server is the real authority on who may save.
//
// The read is token-less like the rest of this tab (the 1h login token expires mid-shift);
// only saving needs it. Saves carry the version that was opened. If someone else saved in the
// meantime the server answers 409 with their note, and nothing is overwritten until the user
// chooses — "Overwrite with mine" then saves on the version they were SHOWN, so a third
// person's save is caught as well.
//
// Renders NOTHING when the notes table isn't there yet (prod before the 0007 migration) or
// the read fails — the deliveries list below must never be blocked by this panel.

// Mirror BOARD_NOTES_EDIT_ROLES / BOARD_NOTE_MAX_LENGTH in lib/deliveryBoardNotes.js
// (pinned by scripts/ops-board-notes-smoke.mjs).
const EDIT_ROLES = ['logistics', 'admin', 'superadmin'];
const MAX_LENGTH = 2000;
const BRAND_RED = '#B50B1D';
const ENDPOINT = '/api/delivery?resource=board-notes';

const WHEN = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});
function formatWhen(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? WHEN.format(d) : '';
}
const editedBy = (n) => n?.updated_by_name || n?.updated_by || 'someone';

function saveErrorFor(status, data) {
  if (status === 401) return 'Couldn’t save — your sign-in has expired. Copy your text, sign in again, then save.';
  if (status === 403) return 'Couldn’t save — you don’t have permission to edit these notes.';
  return `Couldn’t save — ${data?.error || 'please try again'}. Your text is still here.`;
}

export default function DeliveryBoardNotes() {
  const [note, setNote] = useState(null); // null = not loaded / unavailable → render nothing
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(''); // '' | 'saved'
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null); // the other person's note, when a save was refused
  const editingRef = useRef(false);
  const canEdit = hasAnyRole(getRoles(), EDIT_ROLES);

  useEffect(() => { editingRef.current = editing; }, [editing]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const res = await fetch(ENDPOINT);
        if (!res.ok) return;
        const data = await res.json();
        // Never swap the note under someone who is typing — their save will detect a newer one.
        if (mounted && data?.available && !editingRef.current) setNote(data);
      } catch {
        // Unreachable notes are not worth an error on a page whose job is the list below.
      }
    };
    load();
    // A tab left open all day would otherwise show this morning's notes.
    window.addEventListener('focus', load);
    return () => {
      mounted = false;
      window.removeEventListener('focus', load);
    };
  }, []);

  const startEdit = () => {
    setDraft(note.body || '');
    setStatus('');
    setError('');
    setConflict(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setConflict(null);
    setError('');
    setEditing(false);
  };

  const save = useCallback(async () => {
    if (draft.length > MAX_LENGTH) {
      setError(`Couldn’t save — notes are limited to ${MAX_LENGTH} characters (this is ${draft.length}).`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        // After a conflict the user has SEEN the other person's note, so that is now the base.
        body: JSON.stringify({ body: draft, base_version: (conflict || note).version }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.current) {
        setConflict(data.current);
        return;
      }
      if (!res.ok) {
        setError(saveErrorFor(res.status, data));
        return;
      }
      setNote(data);
      setConflict(null);
      setEditing(false);
      setStatus('saved');
    } catch {
      setError('Couldn’t save — check your connection and try again. Your text is still here.');
    } finally {
      setSaving(false);
    }
  }, [draft, note, conflict]);

  const useTheirs = () => {
    setNote(conflict);
    setConflict(null);
    setError('');
    setEditing(false);
  };

  if (!note) return null;

  return (
    <section aria-label="Driver notes" className="mb-6 rounded-xl border bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <div>
          <h2 className="text-lg font-semibold">Driver notes</h2>
          <p className="text-sm text-gray-600">When drivers are coming in next — shared with everyone on this tab.</p>
        </div>
        <div className="flex items-center gap-3">
          <span role="status" className="text-sm font-medium text-green-700">
            {status === 'saved' && !editing ? 'Saved' : ''}
          </span>
          {canEdit && !editing && (
            <button
              type="button"
              onClick={startEdit}
              className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300"
            >
              Edit notes
            </button>
          )}
        </div>
      </div>

      <div className="p-4">
        {!editing && (
          <>
            {note.body
              ? <p className="whitespace-pre-wrap break-words text-sm text-gray-900">{note.body}</p>
              : <p className="text-sm text-gray-600">No notes yet.{canEdit ? ' Use “Edit notes” to add when drivers are coming in.' : ''}</p>}
            {note.updated_at && (
              <p className="mt-3 text-xs text-gray-600">
                Last edited by {editedBy(note)} · {formatWhen(note.updated_at)}
              </p>
            )}
          </>
        )}

        {editing && (
          <div>
            <label htmlFor="delivery-board-notes" className="sr-only">Notes text</label>
            <textarea
              id="delivery-board-notes"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MAX_LENGTH}
              rows={5}
              disabled={saving}
              placeholder="e.g. Nelson — Thu 2 Oct AM; Cobbs — next Tues"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-300"
            />
            <div className="mt-1 text-right text-xs text-gray-600">{draft.length} / {MAX_LENGTH}</div>

            {conflict && (
              <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">
                  {editedBy(conflict)} saved these notes after you opened them
                  {conflict.updated_at ? ` (${formatWhen(conflict.updated_at)})` : ''}. Nothing has been overwritten.
                </p>
                <p className="mt-2 font-medium">Their version:</p>
                <p className="mt-1 whitespace-pre-wrap break-words rounded border border-amber-200 bg-white p-2 text-gray-900">{conflict.body || '(empty)'}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={useTheirs} disabled={saving} className="rounded-lg border bg-white px-3 py-2 font-medium hover:bg-gray-50">
                    Use their version
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="rounded-lg px-3 py-2 font-medium text-white hover:opacity-90 disabled:opacity-60"
                    style={{ backgroundColor: BRAND_RED }}
                  >
                    Overwrite with mine
                  </button>
                  <button type="button" onClick={cancelEdit} disabled={saving} className="rounded-lg border bg-white px-3 py-2 font-medium hover:bg-gray-50">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {error && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{error}</p>}

            {!conflict && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
                  style={{ backgroundColor: BRAND_RED }}
                >
                  {saving ? 'Saving…' : 'Save notes'}
                </button>
                <button type="button" onClick={cancelEdit} disabled={saving} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
