import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import toast from 'react-hot-toast';
import { authHeaders, getRoles, hasAnyRole } from '../utils/auth';
import { parseMaybeJson } from '../utils/http';

// P11: linking an individual Podium account is a `sales` action; superadmin may also
// connect/test. This only decides whether to show the card — the server re-checks on
// /api/podium/oauth/start (403 otherwise).
const PODIUM_ROLES = ['sales', 'superadmin'];

export default function Settings() {
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const navigate = useNavigate();

  // F1 increment 3 — Podium connection state.
  const canConnectPodium = hasAnyRole(getRoles(), PODIUM_ROLES);
  const [podium, setPodium] = useState(null);      // last /api/podium/status payload
  const [podiumLoading, setPodiumLoading] = useState(canConnectPodium);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    setUser(JSON.parse(stored));
  }, [navigate]);

  const loadPodiumStatus = useCallback(async () => {
    setPodiumLoading(true);
    try {
      const res = await fetch('/api/podium/status', { headers: authHeaders() });
      const data = await parseMaybeJson(res);
      if (res.ok) setPodium(data);
      else setPodium(null);
    } catch {
      setPodium(null);
    } finally {
      setPodiumLoading(false);
    }
  }, []);

  // Fetch status on mount, and again when the tab regains focus — the OAuth connect
  // flow leaves via a full-page navigation (to Podium, or the mock loopback), so
  // re-reading on return reflects the freshly-linked account.
  useEffect(() => {
    if (!canConnectPodium) return undefined;
    loadPodiumStatus();
    const onFocus = () => loadPodiumStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [canConnectPodium, loadPodiumStatus]);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }

    const toastId = toast.loading('Updating password...');
    try {
      const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          oldPassword: form.oldPassword,
          newPassword: form.newPassword,
        }),
      });

      const data = await res.json();
      toast.dismiss(toastId);

      if (res.ok) {
        toast.success(data.message || 'Password updated');
      } else {
        toast.error(data.error || 'Password update failed');
      }
    } catch (err) {
      toast.dismiss(toastId);
      toast.error('Server error');
    }
  };

  // Begin the OAuth connect: ask the server for the authorize URL (mock loopback while
  // PODIUM_MOCK=true) and navigate the browser to it. Must be a top-level navigation —
  // real Podium consent can't happen inside an XHR.
  const connectPodium = async () => {
    setConnecting(true);
    const toastId = toast.loading('Starting Podium connection...');
    try {
      const res = await fetch('/api/podium/oauth/start', { headers: authHeaders() });
      const data = await parseMaybeJson(res);
      if (res.ok && data?.authorizeUrl) {
        toast.dismiss(toastId);
        window.location.href = data.authorizeUrl;
        return;
      }
      toast.dismiss(toastId);
      toast.error(data?.error || 'Could not start Podium connection');
      setConnecting(false);
    } catch (err) {
      toast.dismiss(toastId);
      toast.error('Server error');
      setConnecting(false);
    }
  };

  const formatExpiry = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });
  };

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>
      <div className="min-h-screen bg-gray-100 flex flex-col items-center gap-6 py-16 px-4">
        {/* User settings — change password */}
        <div className="bg-white p-6 rounded shadow-md w-full max-w-md">
          <h2 className="text-2xl font-bold mb-4 text-center">User Settings</h2>
          {user && (
            <div className="mb-6 text-sm text-gray-700 space-y-1">
              <p><strong>Name:</strong> {user.name}</p>
              <p><strong>Email:</strong> {user.email}</p>
              <p><strong>ID:</strong> {user.id}</p>
            </div>
          )}
          <form onSubmit={handleSubmit}>
            {['oldPassword', 'newPassword', 'confirmPassword'].map((field, i) => (
              <input
                key={i}
                type="password"
                name={field}
                placeholder={field.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                value={form[field]}
                onChange={handleChange}
                className="w-full mb-4 px-4 py-2 border rounded"
                required
              />
            ))}
            <button type="submit" className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600">
              Change Password
            </button>
          </form>
        </div>

        {/* Podium integration — only for users who can hold an individual Podium account */}
        {canConnectPodium && (
          <div className="bg-white p-6 rounded shadow-md w-full max-w-md">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-xl font-bold">Podium Integration</h2>
              {podium?.mock && (
                <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                  Mock mode
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Link your own Podium account so the portal reads, replies, and assigns chats as you.
            </p>

            {podiumLoading && (
              <p className="text-sm text-gray-500">Checking connection…</p>
            )}

            {!podiumLoading && podium?.connected && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-green-700">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
                  Connected
                </div>
                <dl className="text-sm text-gray-700 space-y-1">
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500">Podium member</dt>
                    <dd className="font-mono text-right break-all">
                      {podium.podiumUserId || 'resolves on first use'}
                    </dd>
                  </div>
                  {Array.isArray(podium.scopes) && podium.scopes.length > 0 && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">Scopes</dt>
                      <dd className="text-right">{podium.scopes.length} granted</dd>
                    </div>
                  )}
                  {formatExpiry(podium.expiresAt) && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-500">Token expires</dt>
                      <dd className="text-right">{formatExpiry(podium.expiresAt)}</dd>
                    </div>
                  )}
                </dl>
                {podium.needsRefresh && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Token is near expiry — it refreshes automatically on next use.
                  </p>
                )}
                <button
                  type="button"
                  onClick={connectPodium}
                  disabled={connecting}
                  className="w-full border border-blue-500 text-blue-600 py-2 rounded hover:bg-blue-50 disabled:opacity-60"
                >
                  {connecting ? 'Redirecting…' : 'Reconnect Podium account'}
                </button>
              </div>
            )}

            {!podiumLoading && podium && !podium.connected && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-500">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" />
                  Not connected
                </div>
                <button
                  type="button"
                  onClick={connectPodium}
                  disabled={connecting}
                  className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600 disabled:opacity-60"
                >
                  {connecting ? 'Redirecting…' : 'Connect my Podium account'}
                </button>
              </div>
            )}

            {!podiumLoading && !podium && (
              <div className="space-y-3">
                <p className="text-sm text-red-600">Couldn’t load your Podium connection status.</p>
                <button
                  type="button"
                  onClick={loadPodiumStatus}
                  className="w-full border border-gray-300 text-gray-700 py-2 rounded hover:bg-gray-50"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
