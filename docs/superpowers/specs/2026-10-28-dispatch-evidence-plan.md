# G18 — Dispatch evidence (photos + videos per workorder item → SharePoint)

**Status:** PLAN, waiting on the owner's answers and Microsoft 365 access. Nothing has been built.
**Written:** 28 Oct 2026.

## What it does

On the **workorder detail page** and on the **deliveries panels** (To-Be-Booked and Schedule),
staff can tap **"Dispatch evidence"** on an item, take or choose photos and videos on their phone
or tablet, and upload them. The portal saves the files into the company's Microsoft 365 shared
drive, in a folder created automatically for that workorder and named after its invoice number.
The portal then lists what was uploaded (thumbnail, who, when) and links to the folder.

```
Dispatch Evidence/                      ← the folder you create (one-off)
  19623 – WO 731/                       ← created by the portal on the first upload
    TM-95T Treadmill (L00412)/          ← one sub-folder per item (recommended, see Q2)
      2026-10-28 14-32 front.jpg
      2026-10-28 14-33 console-on.mp4
```

## How it works (technical)

**API:** Microsoft Graph (`https://graph.microsoft.com/v1.0`), the official API for
OneDrive/SharePoint files.

1. **Server-to-Microsoft login (no user sign-in).** The portal gets its own identity in
   Microsoft Entra ID (an "app registration") and logs in with the *client credentials* flow
   (tenant ID + client ID + secret or certificate, kept in Vercel environment variables, never
   in the browser). Staff keep using their normal portal login, so they don't need Microsoft
   accounts or extra sign-ins.
2. **Least privilege.** The app gets the `Sites.Selected` permission, which on its own grants
   **nothing**. An admin then grants it `write` on **only the one SharePoint site** that holds
   the evidence library. It cannot see mailboxes, other sites or anyone's OneDrive. An even
   tighter option, `Lists.SelectedOperations.Selected` (that one library only), is available.
3. **Folder per workorder.** On the first upload, the server creates
   `Dispatch Evidence/<invoice> – WO <id>` (`POST /drives/{drive}/items/{parent}/children`,
   conflict = fail, then reuse) and stores the folder ID in the portal database, so a later
   change to the invoice number can never orphan or split the folder.
   - **Why "– WO <id>":** invoice numbers are **not unique**. In the dev copy of the data (a July
     snapshot), 570 workorders share 553 invoice numbers (e.g. `18338` appears 3 times), and 8
     contain characters SharePoint does not allow or handles badly (`18030/18093`,
     `18971 & 18970`). Names are cleaned (`/` → `-`) and the WO number keeps each folder
     unique.
4. **Big videos go straight from the phone to SharePoint.** Vercel functions only accept
   ~4.5 MB per request, and phone videos are often 100 MB+. So the server asks Graph for an
   **upload session** (`POST …/createUploadSession`), which returns a one-off, pre-authorised
   upload URL for that single file. The browser sends the file there in 5–10 MB chunks
   (multiples of 320 KiB, resumable if the signal drops, and the session expires if abandoned).
   The Microsoft token never reaches the browser.
   - **To verify in the spike (Phase 0):** Microsoft's docs don't state whether a browser can
     upload directly to that URL (CORS). If it can't, the fallback is to relay the chunks
     through the portal server in ≤ 3.75 MB pieces. That is slower but works.
5. **Record + check.** When a file finishes, the server re-reads it from Graph to confirm it
   landed in the right folder, then saves a row (file, item, who, when, size, SharePoint link)
   and adds a `NOTE_ADDED` workorder log line ("3 dispatch photos uploaded by Ana"). No file
   contents are stored in the portal database.
6. **Viewing.** The panel lists the recorded files with Graph thumbnails, plus an "Open folder
   in SharePoint" link (the person needs SharePoint access to that site to open it).

### Portal changes

| Piece | Detail |
|---|---|
| `lib/msgraph.js` | Token fetch + cache, folder ensure, upload session, item lookup, thumbnails. **Mock adapter** (`GRAPH_MOCK=true`) so Previews work before credentials exist, like `PODIUM_MOCK`. |
| `lib/dispatchEvidence.js` | `/api/evidence?resource=folder|upload-session|complete|list`, routed through the existing `api/[...path].js` catch-all (**no new Vercel function**, Hobby 12-function cap). Token-gated, role-checked, workshop lockdown (G17) respected. |
| Migration `0010_dispatch_evidence` | `dispatch_evidence_folders` (workorder → SharePoint folder ID/link) + `dispatch_evidence_files` (item, file ID, name, type, size, link, uploaded_by/at). Additive + `_down`, **Neon dev only**; code tolerates the tables being absent on prod (42P01) until you migrate at merge. |
| `src/components/DispatchEvidencePanel.js` | Item picker, `accept="image/*,video/*"` with camera capture, multiple files, per-file progress + retry, thumbnails list. Used on workorder detail, To-Be-Booked and Schedule. |
| Limits | Photos + videos only (jpg/png/heic/mp4/mov), default cap **500 MB per file** (configurable), filenames cleaned + timestamped, `conflictBehavior=rename` so nothing is ever overwritten. |
| Tests | Smoke for the handler against the mock (role gates, folder naming incl. `/` and duplicates, size/type rejects, "complete" refuses a file outside the WO folder), Jest for the panel (progress, failure, retry). |

### Phases

| Phase | What | Who |
|---|---|---|
| **0. Access + spike** | You do the access steps below. I then confirm the login works, find the site/drive/folder IDs, and test a browser upload from a Preview URL (decides direct vs relay). Half a session. | You, then me |
| **1. Backend** | Graph client + mock, folder logic, upload session, complete, list, migration 0010 on dev, smoke tests. | Me |
| **2. Screens** | Evidence panel on workorder detail + the two delivery tabs, phone camera capture, progress, list. | Me |
| **3. Review + Preview** | Code review, Preview deploy (Preview env pointing at a **test** folder), PR opened, Notion report. | Me |
| **4. Go-live** | You merge, run migration 0010 on prod, add the Production env vars pointing at the real folder. | You (I can talk you through it) |

Size: **M** (likely 2 build sessions after access is ready).

## What access I need from you

You need a Microsoft 365 **Global Administrator** (or Application Administrator + SharePoint
Administrator) to do these. About 15 minutes.

1. **Tell me where the "shared drive" lives.** In Outlook, a shared drive is almost always the
   **Files of a Microsoft 365 group/Team**, which is a SharePoint site. Send me the URL you see when
   you open it in the browser (looks like `https://graysfitness.sharepoint.com/sites/<name>/…`),
   and create the folder (e.g. `Dispatch Evidence`). Please also create a `Dispatch Evidence – TEST`
   folder for Previews.
   - If it's a folder in **someone's personal OneDrive**, please move it to a SharePoint site:
     app access to a personal OneDrive needs `Files.ReadWrite.All`, which opens *every* file in
     the company. I don't recommend that.
2. **Register the app** — <https://entra.microsoft.com> → *App registrations* → *New
   registration* → name `Grays Portal – Dispatch Evidence`, single tenant, no redirect URI.
   Copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **Add the permission** — *API permissions* → *Add* → *Microsoft Graph* → *Application
   permissions* → **`Sites.Selected`** → *Grant admin consent for Grays Fitness*.
4. **Create a secret** — *Certificates & secrets* → *New client secret* (24 months; put a
   calendar reminder to renew). Put it **straight into Vercel** (step 6). Don't send it to me
   in chat.
5. **Grant the app "write" on that one site.** This is a one-off admin call. The easiest way is
   PnP PowerShell, run by the admin:
   ```powershell
   Connect-PnPOnline -Url https://graysfitness-admin.sharepoint.com -Interactive -ClientId <PnP app id>
   Grant-PnPAzureADAppSitePermission -AppId <client id from step 2> -DisplayName "Grays Portal – Dispatch Evidence" -Site https://graysfitness.sharepoint.com/sites/<name> -Permissions Write
   ```
   (PnP needs its own one-off app registration since 2024, so the Graph Explorer route may be simpler: the equivalent `POST /sites/{site-id}/permissions` with `roles: ["write"]`,
   which needs `Sites.FullControl.All`. I'll walk you through whichever you prefer.)
6. **Vercel environment variables** (project `grays-internal`). Start with **Preview scope
   only**:
   `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_EVIDENCE_SITE_URL`, and
   `MS_EVIDENCE_FOLDER=Dispatch Evidence – TEST`. Production values are added at go-live with
   the real folder name.

Cost: nothing extra. Graph is included with Microsoft 365, and files count against your existing
SharePoint storage (1 TB + 10 GB per licence). Video is the big consumer: about 100–350 MB per
minute from a phone. Recording at 1080p rather than 4K keeps that down.

## Decisions I need from you

1. **Where is the drive?** (step 1 above). This decides the permission.
2. **One folder per workorder, or a sub-folder per item inside it?** *Recommended: sub-folder per
   item* (`<SKU> <product> (<lot>)`), because multi-item workorders stay readable. You asked for
   "a folder using the invoice number", which both options keep.
3. **Who can upload?** *Recommended:* logistics, admin, superadmin, technician/workshop and the WK
   kiosk (evidence is usually taken in the warehouse at dispatch), with delete limited to
   superadmin. Drivers don't log in to the portal, so they can't upload unless you want a
   driver login later.
4. **Is it required?** *Recommended: optional for now*, with a "No evidence yet" badge on
   To-Be-Booked so gaps are visible. Making it mandatory before "Booked" can come later.
5. **Max video size.** *Recommended: 500 MB per file.*

## Risks / notes

- The **client secret expires** (max 24 months). When it does, uploads fail with a clear "Microsoft
  connection expired" message. A certificate instead of a secret is more secure and I can set
  that up if you prefer.
- **Photos can show customer addresses/faces.** Keep the SharePoint folder shared with staff only.
- Removing access later is one click: delete the site permission or the app registration.
