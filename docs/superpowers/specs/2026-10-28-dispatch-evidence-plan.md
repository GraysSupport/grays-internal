# G18 — Dispatch evidence (photos + videos per workorder item → SharePoint)

**Status:** APPROVED by the owner 28 Oct 2026 — next development item. **Phase 0 DONE 28 Oct 2026** (access set up by the owner; spike passed, see "Phase 0 results"). Next: Phase 1 backend.
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
| `lib/msgraph.js` | Token fetch + cache, folder ensure, upload session, item lookup, thumbnails. ~~Mock adapter~~ — **dropped 28 Oct 2026** (real credentials exist on Preview; tests inject a fake Graph; an unconfigured environment shows "not set up"). |
| `lib/dispatchEvidence.js` | `/api/evidence?resource=list|upload-session|complete|file` (folders are ensured inside upload-session), routed through the existing `api/[...path].js` catch-all (**no new Vercel function**, Hobby 12-function cap). Token-gated, role-checked, workshop lockdown (G17) respected. |
| Migration `0010_dispatch_evidence` | `dispatch_evidence_folders` (workorder → SharePoint folder ID/link) + `dispatch_evidence_files` (item, file ID, name, type, size, link, uploaded_by/at). Additive + `_down`, **Neon dev only**; code tolerates the tables being absent on prod (42P01) until you migrate at merge. |
| `src/components/DispatchEvidencePanel.js` | Item picker, `accept="image/*,video/*"` with camera capture, multiple files, per-file progress + retry, thumbnails list. Used on workorder detail, To-Be-Booked and Schedule. |
| Limits | Photos + videos only (jpg/png/heic/mp4/mov), cap **300 MB per file**, filenames cleaned + timestamped, `conflictBehavior=rename` so nothing is ever overwritten. |
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
   and create the folder (e.g. `Dispatch Evidence`). Please also create a `Dispatch Evidence - TEST`
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
   `MS_EVIDENCE_FOLDER=Dispatch Evidence - TEST`. Production values are added at go-live with
   the real folder name.

Cost: nothing extra. Graph is included with Microsoft 365, and files count against your existing
SharePoint storage (1 TB + 10 GB per licence). Video is the big consumer: about 100–350 MB per
minute from a phone. Recording at 1080p rather than 4K keeps that down.

## Decisions (answered by the owner, 28 Oct 2026)

1. **Drive:** SharePoint site `https://graysfitness.sharepoint.com/sites/shared.group` (its Documents library).
2. **Layout:** a sub-folder per item inside each workorder folder.
3. **Upload:** logistics, admin, superadmin, technician/workshop and the WK kiosk only. **Delete: superadmin only.**
4. **Optional.** No "No evidence yet" badge.
5. **Max file size: 300 MB per file.**
6. **OTHER items take no evidence** (owner, 28 Oct 2026: "OTHER equipment doesn't require any
   evidence pictures"). SKU `OTHER` ("Custom / Misc Item") is left out of the evidence list, gets
   no folder, and uploads for it are refused. On the dev data it covers all 120 custom lines.

## Phase 0 results (28 Oct 2026)

Throwaway spike on branch `spike/g18-graph-check` (never merge), run on its Preview deploy
`grays-internal-ll1w31akd-…vercel.app` against the TEST folder:

| Check | Result |
|---|---|
| App login (client credentials) | ✅ token issued; roles = `["Sites.Selected"]` only |
| Site | ✅ `graysfitness.sharepoint.com,28fdc126-59da-4779-8b52-5b98b46abf7a,f6f79a39-6135-48c5-be10-986378654a9c` ("Shared") |
| Drive | ✅ `b!JsH9KNpZeUeLUluYtGq_ejma9_Y1YcVIvhCYY3hlSpzh-QYFrshzRqm7CAkHn6by` ("Documents", documentLibrary) |
| TEST folder | ✅ `01T5C275EB7YAFI2OSWJD32BCCRIPELEZQ` "Dispatch Evidence - TEST" (real `Dispatch Evidence` folder also exists) |
| Write grant | ✅ create folder (conflict=fail) + DELETE (204) |
| Upload session | ✅ created; PUT 201; idle expiry ≈ **15 min** (Graph extends it per chunk) |
| CORS | ✅ preflight 200, `Access-Control-Allow-Origin: *`, allows `content-range`; **real browser PUT from the Preview origin → 201** |

**Decision: direct browser → SharePoint upload** (no relay). The relay fallback is dropped.

Learned:
- The Vercel `MS_EVIDENCE_FOLDER` value had a **leading tab** pasted in, so the lookup
  failed until it was trimmed. The real code must `.trim()` every `MS_*` value.
- Folder names use a plain hyphen (`Dispatch Evidence - TEST`), not an en dash.
- Resolve site/drive/folder ids at runtime (cached per warm instance) rather than hard-coding
  them. The ids above are for reference only.

## Phase 1 results (28 Oct 2026)

Backend built on `feat/ops-g18-dispatch-evidence`:
- `lib/msgraph.js`, `lib/dispatchEvidence.js`, `lib/handlers/evidence.js`, plus `case 'evidence'` in
  `api/[...path].js`.
- Migration 0010, applied to **Neon dev only**. The real `ON CONFLICT` clauses were proved against
  the dev index.
- Offline smoke: 93 checks, mutation-checked.
- Live run of the real `lib/msgraph.js` against the TEST folder (spike `step=lib`): folder create
  and reuse, an upload session with the name `a&b #1.jpg`, getItem, thumbnails, delete,
  delete-again and cleanup all passed.

Code review: no blockers. Fixed:
1. A long file name lost its extension, so the finished upload was deleted.
2. `complete` could delete an already-recorded file.
3. An unknown file id gave 502 instead of 400.
4. A missing size was waved through.
5. The delete 403 now comes before the not-configured 503.

Noted, not changed:
- Size and type are only enforced at `complete`.
- Uncompleted uploads leave orphans in SharePoint.
- No paging past 200 files per item.
- The root folder is cached per warm instance.

**Carry into Phase 2:**
- The panel must always call `complete`, and retry it after a re-login. The 1-hour token also
  applies to the WK kiosk. `complete` is idempotent, so retrying is safe.
- The full-size `web_url` needs a SharePoint login, which technicians and WK may not have. Rely on
  thumbnails on screen.
- Consider hiding thumbnails from roles that can't upload, if the owner wants the G17 lockdown
  applied strictly. Today any logged-in user may view.

## Phase 2 results (29 Oct 2026)

Branch `feat/ops-g18-dispatch-evidence`: `81668ce` (screens), `63c8113` (review fixes + new features).

- **Screens.** The workorder page has a Dispatch evidence panel above the Activity Log. To-Be-Booked
  (1 place) and Schedule (2 places) have a "Dispatch evidence" button on the invoice cell, which
  opens the same panel in a dialog.
- **New features (owner, 29 Oct 2026):**
  - The **Lot Tracker** shows that machine's evidence, read-only: its own workorder item only, with
    no upload or delete. It's hidden when there are no files, in line with decision 4 (no badge).
  - The **workorder header** shows "Open dispatch evidence folder" once a delivery on the
    workorder is *Delivery Completed* and the folder exists. The list response now carries
    `dispatched`.
- **Review fixes:**
  - Resume from `nextExpectedRanges` after any failure; no blind resend.
  - Back-off of 2 → 30 s, a 2-minute chunk timeout, and `Retry-After` on 429.
  - Waits for the connection to come back.
  - Retry only re-records, so no duplicates.
  - A lost final reply is recorded by its session file name: `complete` accepts `file_name`.
  - Closing the dialog or leaving the page aborts the chunks and cancels the session.
  - Uploads keep the 30-minute idle logout away.
  - Unrecorded uploads are kept per user for 7 days and dropped only on 400/404.
  - Dialog: empty states, focus trap and restore, Escape to close, 44 px targets.
- **Checks:**
  - Jest: 330/330.
  - Smokes: 31/31; dispatch-evidence smoke has 117 checks.
  - `CI=true` build is green.
  - 5 mutants, all caught. The cancel-on-close mutant was missed at first, so a test was added.
- **Final review (`6f28941`, 29 Oct 2026):**
  - Each mount now gets its own AbortController. Before, StrictMode or a change of workorder left
    every upload stuck on "waiting".
  - Retry after the final chunk was sent records the file by name, so there's no second copy. If
    SharePoint never got it, Retry sends it afresh.
  - Recording by name needs a matching `size` and never deletes anything.
  - Jest: 334/334. Both new mutants were caught.
  - Known leftovers (minor, accepted):
    - The pending entry is only saved after the upload returns, so closing during the final chunk
      can leave a committed file that isn't recorded. It shows in the SharePoint folder but not in
      the portal.
    - The back-off `sleep` can't be interrupted.
    - An offline spell over 30 minutes still logs the user out.
- **Pinned guard counts were bumped:** contrast 66 files, formgrid 16 pages. They will conflict with
  PR #114's 64→65 contrast bump. Whichever merges second must re-run the smoke and pin the new real
  count, which is both changes added together, not the higher of the two.

## Risks / notes

- The **client secret expires** (max 24 months). When it does, uploads fail with a clear "Microsoft
  connection expired" message. A certificate instead of a secret is more secure and I can set
  that up if you prefer.
- **Photos can show customer addresses/faces.** Keep the SharePoint folder shared with staff only.
- Removing access later is one click: delete the site permission or the app registration.
