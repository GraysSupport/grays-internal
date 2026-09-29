import { useEffect, useRef, useState } from 'react';

/**
 * StopOrderList — an ordered list of delivery stops that can be reordered.
 *
 * Built for G8 (temporary delivery run) and meant to be reused by G9 (drag-to-reorder on the
 * booked schedule), so it knows nothing about where the order is kept: it renders `items`,
 * and reports a move as `onMove(fromIndex, toIndex)`. The parent decides what a move means
 * (G8: update the browser draft; G9: persist run_order, and refuse cross-group drops).
 *
 * Two ways to reorder, on purpose:
 *   - click-hold-drag a row (HTML5 drag and drop) for mouse users;
 *   - Move up / Move down buttons, which also work by keyboard and on a tablet, where HTML5
 *     drag events don't fire from touch.
 *
 * Props:
 *   items        array to render, in order
 *   getKey       item => stable key
 *   getLabel     item => short name used in the button labels ("Move <label> up")
 *   renderItem   (item, index) => row content
 *   onMove       (from, to) => void
 *   onRemove     optional (item, index) => void — shows a Remove button
 *   canDrop      optional (from, to) => boolean — reject a move (G9: other carrier/day).
 *                Honoured by drag AND by the Move up/down buttons, so the keyboard can't
 *                bypass it. Moves only happen within this one list; G9 renders one list per
 *                carrier+day group, which is what makes cross-group drops impossible.
 *   ariaLabel    accessible name for the list
 *   emptyText    shown when there are no items
 */
export default function StopOrderList({
  items,
  getKey,
  getLabel,
  renderItem,
  onMove,
  onRemove,
  canDrop = () => true,
  ariaLabel,
  emptyText = 'No stops yet.',
}) {
  const [dragFrom, setDragFrom] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  // Keyboard reordering: React moves the clicked row's <li>, which drops focus to <body>
  // (and a button that becomes disabled at the top/bottom loses it too). Remember which stop
  // moved and put focus back on it after the re-render.
  const buttonRefs = useRef(new Map());
  const [refocus, setRefocus] = useState(null); // { key, dir }

  useEffect(() => {
    if (!refocus) return;
    const btns = buttonRefs.current.get(refocus.key);
    if (btns) {
      const other = refocus.dir === 'up' ? 'down' : 'up';
      const target = btns[refocus.dir] && !btns[refocus.dir].disabled ? btns[refocus.dir] : btns[other];
      target?.focus();
    }
    setRefocus(null);
  }, [refocus]);

  const endDrag = () => { setDragFrom(null); setOverIndex(null); };

  const moveBy = (item, index, dir) => {
    const to = dir === 'up' ? index - 1 : index + 1;
    if (to < 0 || to >= items.length || !canDrop(index, to)) return;
    onMove(index, to);
    setAnnouncement(`${getLabel(item)} moved to stop ${to + 1} of ${items.length}`);
    setRefocus({ key: getKey(item), dir });
  };

  const setBtnRef = (key, dir) => (el) => {
    const entry = buttonRefs.current.get(key) || {};
    entry[dir] = el;
    buttonRefs.current.set(key, entry);
  };

  return (
    <>
    <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
    <ol aria-label={ariaLabel} className="divide-y rounded-lg border bg-white">
      {items.length === 0 && (
        <li className="px-3 py-4 text-sm text-gray-600">{emptyText}</li>
      )}
      {items.map((item, index) => {
        const label = getLabel(item);
        const isOver = overIndex === index && dragFrom !== null && dragFrom !== index;
        const rejected = isOver && !canDrop(dragFrom, index);
        return (
          <li
            key={getKey(item)}
            draggable
            onDragStart={(e) => {
              setDragFrom(index);
              try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)); } catch { /* jsdom */ }
            }}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              setOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dragFrom !== index && canDrop(dragFrom, index)) {
                onMove(dragFrom, index);
                setAnnouncement(`${getLabel(items[dragFrom])} moved to stop ${index + 1} of ${items.length}`);
              }
              endDrag();
            }}
            onDragEnd={endDrag}
            className={[
              'flex items-start gap-3 px-3 py-2',
              dragFrom === index ? 'opacity-50' : '',
              isOver && !rejected ? 'bg-gray-100' : '',
              rejected ? 'bg-red-50 outline outline-1 outline-red-300' : '',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              title="Drag to reorder"
              className="mt-0.5 cursor-grab select-none text-gray-500"
            >
              ⠿
            </span>
            <span className="mt-0.5 w-6 shrink-0 text-right font-semibold text-gray-700">{index + 1}</span>
            <div className="min-w-0 flex-1">{renderItem(item, index)}</div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                ref={setBtnRef(getKey(item), 'up')}
                aria-label={`Move ${label} up`}
                disabled={index === 0 || !canDrop(index, index - 1)}
                onClick={() => moveBy(item, index, 'up')}
                className="rounded border px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                ref={setBtnRef(getKey(item), 'down')}
                aria-label={`Move ${label} down`}
                disabled={index === items.length - 1 || !canDrop(index, index + 1)}
                onClick={() => moveBy(item, index, 'down')}
                className="rounded border px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                ↓
              </button>
              {onRemove && (
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  onClick={() => onRemove(item, index)}
                  className="rounded border px-2 py-1 text-sm text-gray-700 hover:bg-gray-50"
                >
                  ✕
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
    </>
  );
}
