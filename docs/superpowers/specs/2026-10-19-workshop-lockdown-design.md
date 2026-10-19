# G17 — Workshop lockdown: technicians and workshop see the job, not the money (design)

Requested by Nick, 19 Oct 2026 (interactive): technician and workshop users must not see
balances or specific customer details, and must not change salesperson, target completion,
cancel or add products, or modify anything else in workorders.

## What exists today (investigated 19 Oct 2026)

- The workorder, delivery, customer and lot endpoints read **no login token**. The acting user
  is whatever the page sends in `X-User-Id` / `body.user_id`; it is used for log attribution and
  the superadmin-only `selling_price` check only.
- On the workorder page a `technician` can edit everything (salesperson, target date, balance,
  delivery money, add/remove/cancel items, reopen, notes). The only gate is the WK kiosk's email,
  which hides payment + target-date editing but still allows salesperson, add/remove, cancel.
- Balances and customer phone/email are in the data sent to every browser (`GET /api/workorder`,
  `GET /api/delivery`), whether or not the page shows them.
- WK (the shared workshop kiosk) is an **`admin`** login on prod, so it also passes every
  admin gate (Lot Tracker, Temp Run, board-note edits, run order) and sees Customers/Products.

## Decisions (Nick, 19 Oct 2026)

| Question | Answer |
|---|---|
| What may technicians/workshop still change? | **Item status** (Not in Workshop → In Workshop → Completed; never Canceled) and **serials + lot stickers** (incl. the G16 Tech Checklist). Nothing else — not notes, not technician reassignment. |
| Which customer details may they see? | **Name + suburb/state only.** No phone, email, address, notes, customer page or journey. |
| Does WK get the same restrictions? | **Yes**, by user id (it is an admin login). WK also loses the admin-only extras. |

## Who is restricted

`isWorkshopRestricted({ id, roles })` =
- user id `WK`, **or**
- has `technician` or `workshop` **and none of** `superadmin`, `admin`, `logistics`, `sales`, `staff`
  (a multi-role manager who also repairs machines keeps full access).

The server decides it from the signed login token **or** the user id the page sends
(`X-User-Id` / `body.user_id` / `query.user_id`, looked up in `users` + `user_roles`). Claiming
to be a technician can only reduce what you can do, so trusting the claimed id for *restriction*
is safe — and it keeps the kiosk restricted after its 1-hour token expires.

## Server rules (restricted users)

- `GET /api/workorder` (single + list): drop `outstanding_balance`, `delivery_charged`,
  `installation_cost`, `cash_to_removalist`, `free_delivery`, `customer_id`, `customer_email`,
  `customer_phone`; items never carry `selling_price` / `custom_unit_price`; payment log rows keep
  their event but lose any note text.
- `PUT /api/workorder`: only `items[].{workorder_items_id, status, item_sn}` (+ `user_id`) is
  accepted, status ∈ {Not in Workshop, In Workshop, Completed}. Anything else → **403** naming the
  refused fields, **before** any write. Completing the last item still auto-completes the
  workorder and creates its delivery, exactly as today.
- `POST` / `DELETE /api/workorder` → 403.
- `GET /api/delivery` (single + list): same money + contact redaction. `POST/PUT/DELETE` → 403.
- `/api/customers` (all methods, incl. journey) → 403.
- WK (and any restricted token) → 403 on the admin-gated Lot Tracker, Temp Run, board-note
  edits and run-order saves.
- Unchanged: lot assign/unassign/serial, the G16 checklist, the public `/scan` lookup.

## Screens (restricted users)

- Workorder page: no payment status, balance or delivery-money fields, no customer View/Edit;
  salesperson, target completion, important flag, technician and notes read-only; no Add
  Product, Remove, Reopen or Check Ecommerce; item status offers the three workshop statuses;
  serial + lot controls stay. Save sends only the allowed fields.
- Active / completed workorder lists: no Payment column, filter or print column; no
  "+ Create New Work Order".
- Delivery tabs: the To-Be-Booked, Schedule and Completed Deliveries tabs are hidden and those
  pages show "not available" (they are booking + money screens); collections tabs unchanged.
- Customers pages and Create Workorder: "not available".
- Nav: Products, Customers, Waitlist, Lot Tracker hidden (as technicians already are).
- Dashboard: analytics hidden for WK as for technicians.

## Known gap (separate proposal for Nick)

Someone with **no login at all** can still call these APIs, exactly as today. Closing that means
requiring a token on every workorder/customer/delivery call, which collides with the 1-hour token
and the never-logged-out kiosk — an architecture decision, raised as proposal **P7**.

## Testing (failing first)

- `scripts/ops-workshop-lockdown-smoke.mjs`: restriction matrix; actor resolution (token, header,
  body, WK, expired token + header, multi-role); workorder GET redaction, PUT allow/deny (no write
  before the 403), POST/DELETE; delivery redaction + write denial; customers gate; WK denied on
  the four admin-gated features.
- Jest: workorder page (restricted vs admin), lists, delivery tabs, customers pages; nav smoke.
