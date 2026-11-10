// G27 (owner, 10 Nov 2026) — "Before refurbishment" photos and videos per lot: the machine as it
// arrived, before it is taken apart. Evidence for before/after, and a reference for technicians
// on how it was assembled. Saved in SharePoint next to the item's dispatch evidence (In Stock
// lots in an "In-stock lots" area until tagged as sold — the server moves the folder).
//
// Reuses the G18 evidence panel (chunked resumable uploads, saved-upload queue, thumbnails,
// superadmin delete) through an adapter. Used on the workorder lot row (button + pop-up), the
// Lot Tracker (inline, upload) and the Tech Checklist (inline, read-only).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authHeaders } from '../utils/auth';
import { beforePhotosLabel } from '../utils/beforePhotos';
import { EvidenceDialogButton, EvidencePanel } from './DispatchEvidencePanel';

export function beforeAdapter(lotId) {
  const id = Number(lotId);
  return {
    id: `lot:${id}`,
    kind: 'before',
    resources: { list: 'before-list', session: 'before-upload-session', file: 'before-file' },
    listQuery: { lot_id: String(id) },
    items: (d) => (d.lot ? [{ key: d.lot.lot_id, label: `Lot ${d.lot.lot_number}`, files: d.files || [], folder_url: d.folder_url || null }] : []),
    target: () => ({ lot_id: id }),
    owns: (p) => p.kind === 'before' && Number(p.lot_id) === id,
    title: 'Before refurbishment',
    hint: 'Photos and videos of the machine before it is taken apart — how it is assembled and its condition. Up to 300 MB per file.',
    notSetUp: "Before photos aren't set up yet.",
    empty: 'Lot not found.',
  };
}

export function BeforePhotosPanel({ lotId, ...rest }) {
  const adapter = useMemo(() => beforeAdapter(lotId), [lotId]);
  return <EvidencePanel adapter={adapter} {...rest} />;
}

/** Workorder lot row: "Before photos (n)" → pop-up. Hidden while not set up / not migrated. */
export function BeforePhotosButton({ lotId, lotNumber, onChanged, className }) {
  const [info, setInfo] = useState(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try {
      // count_only: just the number — no folder move, no thumbnails (one call per lot row).
      const r = await fetch(`/api/evidence?${new URLSearchParams({ resource: 'before-list', lot_id: String(lotId), count_only: '1' })}`, { headers: authHeaders() });
      const j = await r.json().catch(() => null);
      if (alive.current && r.ok) setInfo(j);
    } catch { /* the pop-up says why when it is opened */ }
  }, [lotId]);
  useEffect(() => {
    alive.current = true;
    reload();
    return () => { alive.current = false; };
  }, [reload]);

  if (!info?.configured || !info?.available) return null;
  const changed = () => { reload(); onChanged?.(); };
  const label = beforePhotosLabel(info.files?.length);
  return (
    <EvidenceDialogButton
      label={label}
      className={className || 'inline-flex min-h-[44px] items-center gap-1 rounded border px-3 text-xs text-gray-700 hover:bg-gray-50'}
      buttonLabel={`${label} — lot ${lotNumber}`}
      dialogLabel={`Before refurbishment — lot ${lotNumber}`}
      title={`Before refurbishment — lot ${lotNumber}`}
      renderPanel={(setBusy) => <BeforePhotosPanel lotId={lotId} onBusyChange={setBusy} onChanged={changed} inDialog />}
    />
  );
}
