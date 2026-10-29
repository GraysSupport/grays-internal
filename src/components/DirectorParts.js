// G22 Director's View — small shared pieces used by every section.

const CHANGE_CLS = { up: 'text-green-800', down: 'text-red-800', flat: 'text-gray-700' };

/** ▲ / ▼ change badge from utils/director.js changeBadge(). */
export function Change({ badge }) {
  if (!badge) return null;
  return <span className={`ml-1 text-xs font-semibold ${CHANGE_CLS[badge.dir]}`}>{badge.text}</span>;
}

/** A data-coverage line: what share of the data a figure rests on. */
export function Coverage({ children }) {
  return <p role="note" className="text-xs text-gray-700">{children}</p>;
}

/** A headline figure. */
export function Tile({ label, value, badge, note }) {
  return (
    <div className="rounded-lg border bg-gray-50 p-3">
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <div className="text-lg font-bold text-gray-900"><span>{value}</span><Change badge={badge} /></div>
      {note && <div className="text-xs text-gray-700">{note}</div>}
    </div>
  );
}
