# Podium integration — ops runbook

What to do when the Podium integration misbehaves. Written for whoever is on the tools,
not for whoever wrote the code.

**Start here:** `/integrations` (superadmin only) — the Integrations page lists every
message the portal has sent through Podium and every event it has received, newest first.
The tiles at the top are the alert: **if `Failed` is red, something needs a human.**

> **The one thing to understand:** automated messages are sent **at most once**. If a send
> fails, it is **not** retried — the row is marked `failed` and that is the end of it. So a
> failed row means *that customer never got their message*, and someone has to decide
> whether to contact them by hand. This is deliberate: never double-texting a customer was
> judged more important than guaranteeing delivery of a convenience message.

---

## 1. Reading the log

| Column | Meaning |
|---|---|
| **Event** | Which automation: waitlist back-in-stock, delivery booked, or review request. |
| **Direction** | `outbound` = we sent it. `inbound` = Podium told us something (a webhook). |
| **Reference** | The thing it's about, e.g. `review_request:42` = workorder 42. This is also the **de-dupe key** — one row per reference, forever. |
| **Status** | `sent` (away), `failed` (never sent, not retried), `pending` (claimed but the outcome wasn't recorded — see §4), `skipped` (deliberately not sent — usually no phone number on the customer). |
| **Detail** | The error, and the envelope (ids/SKUs). **Never message text** — Podium is the system of record for conversations. |

## 2. "A customer says they never got their text"

1. `/integrations` → search their reference (e.g. `delivery_booked:1234`) or filter by event.
2. **No row at all** → the automation never fired. Either the trigger didn't happen (the
   delivery was never moved to *Booked for Delivery*; the workorder isn't both completed
   **and** fully paid), or Podium is still in mock mode (§6).
3. **`skipped`** → read the reason. Almost always *no phone on the customer* — fix the
   customer record; the automation will **not** re-fire for that reference.
4. **`failed`** → read the error, then **contact the customer manually**. It will not retry.
5. **`sent`** → we handed it to Podium. Check the conversation in Podium itself for the
   delivery receipt; the problem is downstream of us.

## 3. "Everything is failing at once"

Almost always the Podium token or credentials, not the automations.

1. Check the errors on the failed rows — `401`/`unauthorized` points at auth.
2. **Token refresh:** access tokens live **10 hours** and refresh automatically (within a
   5-minute skew, plus one forced refresh on a 401). If refresh itself is failing, the rep
   must re-link (§5). The shared-number/system sends (waitlist, delivery, review) do **not**
   use a rep's token — see the VERIFY note in `lib/podium.js` `sendSystemSms`.
3. Confirm `PODIUM_MOCK`, `PODIUM_CLIENT_ID/SECRET`, `PODIUM_API_VERSION` and
   `PODIUM_LOCATION_UID` are set on the right Vercel environment.
4. `PODIUM_API_VERSION` **must be pinned** to a dated version. Unset = Podium's latest =
   breaking changes arrive unannounced.

## 4. Rows stuck on `pending`

A `pending` row was claimed but never resolved — the process died between claiming and
recording the outcome. The message may or may not have gone out; **assume it did not**, and
check with the customer before re-sending by hand.

Because the claim row is the de-dupe gate, a `pending` row **blocks** that reference from
ever being retried. If you are certain the message never sent and you want the automation to
fire again, delete that one row (superadmin, with care):

```sql
-- Confirm what you're about to delete FIRST.
SELECT * FROM integration_sync_log WHERE reference_id = 'delivery_booked:1234';
DELETE FROM integration_sync_log WHERE reference_id = 'delivery_booked:1234' AND status = 'pending';
```

The next trigger for that reference will then re-claim and re-send.

## 5. A rep needs to re-link their Podium account

Each salesperson authorises their own Podium account (their replies must show as *them*).

1. The rep opens **Settings** → **Connect my Podium account** (the card only shows to users
   holding the `sales` role) → completes Podium's consent screen.
2. That stores their token and their `podium_user_id`, which is what maps portal
   assignment ⇄ Podium assignment.
3. To verify: Settings shows the account as connected. If assignment sync looks wrong for
   one rep specifically, re-linking them is the first thing to try.

## 6. Nothing is being sent at all (expected today)

The integration is **mock-first**: while `PODIUM_MOCK=true` (or no `PODIUM_CLIENT_ID` is
set), every Podium call is served by a local mock and **nothing reaches a real customer**.
The automations still run end-to-end and still write their audit rows, which is exactly what
makes them reviewable on a Preview.

Going live is a config change, not a code change: set the credentials and
`PODIUM_MOCK=false`. **Before you do**, confirm the outbound SMS copy has been signed off
and check the review-invite wording in Podium's own settings (Podium composes that one, not
us).

## 7. Webhook re-registration

The webhook subscription is **per location/organisation** and is created with an admin
location-scoped token, not a rep's.

- Register/re-register: `scripts/podium-webhook-register.mjs` (needs `PODIUM_MOCK=false`,
  live credentials, and `PODIUM_WEBHOOK_SECRET`).
- The receiver **fails closed**: with no `PODIUM_WEBHOOK_SECRET` set it returns 503 and
  processes nothing, because it cannot verify the signature.
- The same secret must be set on the Vercel environment receiving the calls.
- Inbound events are de-duped on Podium's event id, so a replay is harmless.
- Podium retries for ~10 days, so a receiver outage is recoverable — fix it and the queue
  drains.

## 8. Where things live

| | |
|---|---|
| Audit log | `integration_sync_log` — surfaced at `/integrations` |
| Podium calls | `lib/podium.js` (one place; mock in `lib/podium.mock.js`) |
| Automations | `lib/waitlistNotify.js`, `lib/deliveryNotify.js`, `lib/reviewNotify.js` |
| Webhook receiver | `api/podium/webhook.js` + `lib/podiumWebhook.js` |
| OAuth | `lib/podiumOAuth.js` + `api/podium/oauth/*` |
