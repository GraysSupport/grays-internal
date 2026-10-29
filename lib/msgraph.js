// lib/msgraph.js — G18 (owner, 28 Oct 2026): the portal's own login to Microsoft 365, used to
// save dispatch evidence into the SharePoint shared drive.
//
// App-only "client credentials" login (no staff sign-in): the Entra app
// "Grays Portal - Dispatch Evidence" holds ONLY `Sites.Selected` plus a write grant on the one
// site in MS_EVIDENCE_SITE_URL — it cannot see mail, other sites or anyone's OneDrive.
//
// The token and the secret never leave the server. Browsers upload straight to SharePoint
// through a one-off upload-session URL (Phase 0, 28 Oct 2026: CORS allows it), so Vercel's
// ~4.5 MB request limit never applies to the file itself.
//
// Env (Preview only until go-live): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET,
// MS_EVIDENCE_SITE_URL, MS_EVIDENCE_FOLDER. Every value is trimmed — a value pasted into Vercel
// once carried a leading tab and the folder lookup failed.

const GRAPH = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
  constructor(message, { status = null, code = null, kind = 'graph' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind; // 'auth' = the app login failed; 'graph' = a Graph call failed
  }
}

/** The five MS_* values, trimmed. */
export function graphConfig(env = process.env) {
  const v = (k) => String(env?.[k] ?? '').trim();
  return {
    tenant: v('MS_TENANT_ID'),
    clientId: v('MS_CLIENT_ID'),
    secret: v('MS_CLIENT_SECRET'),
    siteUrl: v('MS_EVIDENCE_SITE_URL'),
    folder: v('MS_EVIDENCE_FOLDER'),
  };
}

export function isGraphConfigured(env = process.env) {
  return Object.values(graphConfig(env)).every(Boolean);
}

const enc = (name) => encodeURIComponent(name);

/**
 * A Graph client. `fetch` and `env` are injectable so the smoke can run it offline.
 * Caches the token (until a minute before expiry) and the evidence root folder per instance.
 */
export function createGraph({ env = process.env, fetch: doFetch = globalThis.fetch } = {}) {
  const cfg = graphConfig(env);
  let token = null;
  let tokenExpires = 0;
  let root = null;

  async function getToken() {
    if (token && Date.now() < tokenExpires) return token;
    const r = await doFetch(`https://login.microsoftonline.com/${enc(cfg.tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.secret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      // Microsoft's description (e.g. "AADSTS7000215: Invalid client secret") — never the secret.
      throw new GraphError(`Microsoft refused the portal's login: ${j.error_description || j.error || `HTTP ${r.status}`}`, {
        status: r.status, code: j.error || null, kind: 'auth',
      });
    }
    token = j.access_token;
    tokenExpires = Date.now() + Math.max(0, (Number(j.expires_in) || 3600) - 60) * 1000;
    return token;
  }

  async function call(path, { method = 'GET', body } = {}) {
    const r = await doFetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      throw new GraphError(json?.error?.message || `Microsoft Graph HTTP ${r.status}`, { status: r.status, code: json?.error?.code || null });
    }
    return json;
  }

  /** The evidence root (MS_EVIDENCE_FOLDER in the site's Documents library): { id, driveId, webUrl }. */
  async function rootFolder() {
    if (root) return root;
    const u = new URL(cfg.siteUrl);
    const site = await call(`/sites/${u.hostname}:${u.pathname.replace(/\/+$/, '')}`);
    const drive = await call(`/sites/${site.id}/drive`);
    const folder = await call(`/drives/${drive.id}/root:/${enc(cfg.folder)}`);
    root = { id: folder.id, driveId: drive.id, webUrl: folder.webUrl || null };
    return root;
  }

  const driveId = async () => (await rootFolder()).driveId;

  /** Create `name` under `parentId`, or return the folder already there. { id, name, webUrl } */
  async function ensureFolder(parentId, name) {
    const d = await driveId();
    try {
      const made = await call(`/drives/${d}/items/${parentId}/children`, {
        method: 'POST',
        body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      });
      return { id: made.id, name: made.name, webUrl: made.webUrl || null };
    } catch (err) {
      if (!(err instanceof GraphError) || err.status !== 409) throw err;
      const found = await call(`/drives/${d}/items/${parentId}:/${enc(name)}`);
      return { id: found.id, name: found.name, webUrl: found.webUrl || null };
    }
  }

  /** A one-off, pre-authorised upload URL for `fileName` in `folderId`. Never overwrites. */
  async function createUploadSession(folderId, fileName) {
    const d = await driveId();
    const s = await call(`/drives/${d}/items/${folderId}:/${enc(fileName)}:/createUploadSession`, {
      method: 'POST',
      body: { item: { '@microsoft.graph.conflictBehavior': 'rename' } },
    });
    return { uploadUrl: s.uploadUrl, expiresAt: s.expirationDateTime || null };
  }

  async function getItem(itemId) {
    return call(`/drives/${await driveId()}/items/${enc(itemId)}?$select=id,name,size,file,webUrl,parentReference`);
  }

  /** A file by name inside a folder (used when an upload's final reply was lost). */
  async function getChild(folderId, name) {
    return call(`/drives/${await driveId()}/items/${folderId}:/${enc(name)}?$select=id,name,size,file,webUrl,parentReference`);
  }

  /** Delete (to the SharePoint recycle bin). false = it was already gone. */
  async function deleteItem(itemId) {
    try {
      await call(`/drives/${await driveId()}/items/${enc(itemId)}`, { method: 'DELETE' });
      return true;
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return false;
      throw err;
    }
  }

  /** The files in a folder with a medium thumbnail URL each: [{ id, thumbnail }]. */
  async function childrenWithThumbnails(folderId) {
    const j = await call(`/drives/${await driveId()}/items/${folderId}/children?$select=id&$expand=thumbnails&$top=200`);
    return (j?.value || []).map((c) => ({ id: c.id, thumbnail: c.thumbnails?.[0]?.medium?.url || c.thumbnails?.[0]?.small?.url || null }));
  }

  return { rootFolder, ensureFolder, createUploadSession, getItem, getChild, deleteItem, childrenWithThumbnails };
}

// One client per warm serverless instance, so the token and root folder are reused.
let shared = null;
export function getGraph() {
  if (!shared) shared = createGraph();
  return shared;
}
