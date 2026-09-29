import { useState } from 'react';

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
 *   canDrop      optional (from, to) => boolean — reject a drop (G9: other carrier/day)
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

  const endDrag = () => { setDragFrom(null); setOverIndex(null); };

  return (
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
              if (dragFrom !== null && dragFrom !== index && canDrop(dragFrom, index)) onMove(dragFrom, index);
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
                aria-label={`Move ${label} up`}
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
                className="rounded border px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${label} down`}
                disabled={index === items.length - 1}
                onClick={() => onMove(index, index + 1)}
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
  );
}
