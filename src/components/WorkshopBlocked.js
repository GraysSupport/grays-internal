import { Link } from 'react-router-dom';
import { currentUserIsWorkshop } from '../utils/workshopAccess';

// G17 (Nick, 19 Oct 2026): pages that show balances, customer contact details or booking /
// creating controls are not for workshop logins (technician / workshop / the WK kiosk). The
// server refuses the same data (lib/workshopAccess.js); this is the friendly screen.
export function WorkshopBlocked({ what }) {
  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-xl rounded-xl border bg-white p-6">
        <h1 className="text-xl font-bold">{what}</h1>
        <p className="mt-2 text-gray-700">This page is not available to workshop logins.</p>
        <Link to="/delivery_operations" className="mt-4 inline-block underline">Back to Current Operations</Link>
      </div>
    </div>
  );
}

/** Wrap a page so workshop logins get WorkshopBlocked instead (no hooks run, nothing fetched). */
export function blockWorkshop(Page, what) {
  function WorkshopGuarded(props) {
    if (currentUserIsWorkshop()) return <WorkshopBlocked what={what} />;
    return <Page {...props} />;
  }
  WorkshopGuarded.displayName = `blockWorkshop(${Page.displayName || Page.name || 'Page'})`;
  return WorkshopGuarded;
}
