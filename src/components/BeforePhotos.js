// G27 (owner, 10 Nov 2026) — "Before refurbishment" photos and videos: the machine as it
// arrived, before it is taken apart. Evidence for before/after, and a reference for technicians
// on how it was assembled. Saved in SharePoint next to the item's dispatch evidence.
//
// Two kinds of subject:
//   lotId           — per lot (In Stock lots in an "In-stock lots" area until tagged as sold;
//                     the server moves the folder when the lot is assigned / released)
//   workorderItemId — old stock WITHOUT lot numbers (owner, 10 Nov 2026): per workorder item
//
// Reuses the G18 evidence panel (chunked resumable uploads, saved-upload queue, thumbnails,
// superadmin delete) through an adapter. Used on the workorder lot row + item (button + pop-up),
// the Lot Tracker (inline, upload) and the Tech Checklist (inline, read-only).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authHeaders } from '../utils/auth';
import { beforePhotosLabel } from '../utils/beforePhotos';
import { EvidenceDialogButton, EvidencePanel } from './DispatchEvidencePanel';

/** { lot_id } or { workorder_items_id } — what every before-photo request names. */
const refOf = ({ lotId, workorderItemId }) => (lotId != null
  ? { lot_id: Number(lotId) }
  : { workorder_items_id: Number(workorderItemId) });

export function beforeAdapter(subject) {
  const ref = refOf(subject);
  const isLot = ref.lot_id != null;
  return {
    id: isLot ? `lot:${ref.lot_id}` : `item:${ref.workorder_items_id}`,
    kind: 'before',
    resources: { list: 'before-list', session: 'before-upload-session', file: 'before-file', view: 'before-view' },
    listQuery: Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, String(v)])),
    items: (d) => {
      if (d.lot) return [{ key: d.lot.lot_id, label: `Lot ${d.lot.lot_number}`, files: d.files || [], folder_url: d.folder_url || null }];
      if (d.item) return [{ key: d.item.workorder_items_id, label: d.item.label, files: d.files || [], folder_url: d.folder_url || null }];
      return [];
    },
    target: () => ref,
    owns: (p) => p.kind === 'before' && (isLot
      ? Number(p.lot_id) === ref.lot_id
      : p.lot_id == null && Number(p.workorder_items_id) === ref.workorder_items_id),
    title: 'Before refurbishment',
    hint: 'Photos and videos of the machine before it is taken apart — how it is assembled and its condition. Up to 300 MB per file.',
    notSetUp: "Before photos aren't set up yet.",
    empty: isLot ? 'Lot not found.' : 'This item does not take before photos.',
  };
}

export function BeforePhotosPanel({ lotId, workorderItemId, ...rest }) {
  const adapter = useMemo(() => beforeAdapter({ lotId, workorderItemId }), [lotId, workorderItemId]);
  return <EvidencePanel adapter={adapter} {...rest} />;
}

/**
 * "Before photos (n)" → pop-up. Hidden while not set up / not migrated. `onlyIfAny`: hide it
 * unless photos already exist; `readOnly`: view only (an item whose every unit now has a lot keeps
 * showing its old item-level photos, but new ones go on the lots).
 */
export function BeforePhotosButton({ lotId, workorderItemId, name, onChanged, className, onlyIfAny = false, readOnly = false }) {
  const [info, setInfo] = useState(null);
  const alive = useRef(true);
  const ref = refOf({ lotId, workorderItemId });
  const query = new URLSearchParams({ resource: 'before-list', ...Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, String(v)])), count_only: '1' }).toString();
  const reload = useCallback(async () => {
    try {
      // count_only: just the number — no folder move, no thumbnails (one call per row).
      const r = await fetch(`/api/evidence?${query}`, { headers: authHeaders() });
      const j = await r.json().catch(() => null);
      if (alive.current && r.ok) setInfo(j);
    } catch { /* the pop-up says why when it is opened */ }
  }, [query]);
  useEffect(() => {
    alive.current = true;
    reload();
    return () => { alive.current = false; };
  }, [reload]);

  if (!info?.configured || !info?.available) return null;
  const count = info.files?.length || 0;
  if (onlyIfAny && !count) return null;
  const changed = () => { reload(); onChanged?.(); };
  const label = beforePhotosLabel(count);
  const what = name || (lotId != null ? `lot ${lotId}` : `item ${workorderItemId}`);
  return (
    <EvidenceDialogButton
      label={label}
      className={className || 'inline-flex min-h-[44px] items-center gap-1 rounded border px-3 text-xs text-gray-700 hover:bg-gray-50'}
      buttonLabel={`${label} — ${what}`}
      dialogLabel={`Before refurbishment — ${what}`}
      title={`Before refurbishment — ${what}`}
      renderPanel={(setBusy) => <BeforePhotosPanel lotId={lotId} workorderItemId={workorderItemId} onBusyChange={setBusy} onChanged={changed} readOnly={readOnly} inDialog />}
    />
  );
}
