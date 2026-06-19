# Built Trailers — Phase 1 (Live Hosted Environment)

The production foundation: a deployable web application backed by a real database that
serves as the **single source of truth** for parts, BOMs, and inventory — with secure,
role-based access for the whole organization.

This is real, running software (not a mockup). It has been booted and tested end to end.

---

## What's in Phase 1

| Capability | Detail |
|---|---|
| **Secure auth** | Username + bcrypt-hashed password, JWT sessions (12h), three permission tiers. |
| **Roles & hierarchy** | 15 job roles mapped to Admin / Editor / Viewer; each user has a direct manager. |
| **Parts master** | All ~200 real parts (purchased + manufactured), unit cost, on-hand, reorder/cushion/lot, vendor & lead time. |
| **BOMs & true cost** | All 32 models; live rollup of material + burdened labor → total cost & margin. |
| **Inventory valuation** | Live dollar value of every part on hand, below-reorder flags, make-vs-buy split. |
| **Audit log** | Every cost change, stock receipt and user edit is recorded with who/when. |
| **Live web UI** | Login screen + Dashboard, Parts, BOMs, Inventory, and Users views, all reading/writing the API. |

Seeded with Built Trailers' real catalog. Costs are the editable estimates from the
prototype — replace them with real numbers and every BOM and valuation updates instantly.

---

## Run it on your laptop in 30 seconds (no database to install)

```bash
npm install
npm run init-db      # creates schema + seeds the catalog (uses built-in PGlite)
npm start            # serves on http://localhost:3000
```

Open http://localhost:3000 and sign in as **tsoelberg** / **built2026**.

> With no `DATABASE_URL` set, the app uses **PGlite**, an in-process PostgreSQL — perfect
> for trying it locally. Production uses a real managed PostgreSQL (below).

---

## Go live on Render (recommended) — ~10 minutes

**1. Put this folder in a Git repository**

```bash
git init && git add . && git commit -m "Built Trailers Phase 1"
# create an empty repo on GitHub, then:
git remote add origin https://github.com/<you>/built-trailers.git
git push -u origin main
```

**2. Deploy the blueprint**

- Go to [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**.
- Connect the GitHub repo. Render reads `render.yaml` and provisions **both** the web
  service and a managed PostgreSQL database automatically.
- Click **Apply**. Render runs `npm install && npm run init-db` (creating the schema and
  seeding the catalog against the real Postgres), then `npm start`.

**3. You're live**

- Render gives you a URL like `https://built-trailers-phase1.onrender.com`.
- `JWT_SECRET` is generated for you; `DATABASE_URL` is wired to the database automatically.
- Sign in with the seeded admin account and **change the passwords** (see below).

> First thing after go-live: sign in as an admin and reset every password from a value
> only you know. The seed password (`built2026`) is for first login only.

### Deploy anywhere else (AWS, Azure, your own server)

A `Dockerfile` is included. Build and run the image, set `DATABASE_URL` to any PostgreSQL,
run `npm run init-db` once, then start the container. Works on Fly.io, Railway, ECS, etc.

---

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Render provides this). Unset → uses PGlite. |
| `JWT_SECRET` | Secret for signing login tokens. Use a long random string in production. |
| `LABOR_RATE` | Burdened blended $/hr for cost rollups until Phase 5 wires real payroll (default 37). |
| `PORT` | Server port (Render sets automatically). |

See `.env.example`.

---

## API reference (all `/api/*`, JSON, Bearer token except login/health)

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | Liveness + DB engine. |
| POST | `/api/auth/login` | public | `{username,password}` → `{token,user}`. |
| GET | `/api/auth/me` | any | Current user. |
| GET | `/api/users` | any | List users + roles + hierarchy. |
| POST | `/api/users` | admin | Create user. |
| PATCH | `/api/users/:id` | admin | Update role/title/manager/password/username. |
| GET | `/api/parts` | any | Parts master with extended value + status. |
| PATCH | `/api/parts/:id` | editor | Edit cost / reorder / cushion / lot. |
| POST | `/api/parts/:id/receive` | editor | Receive stock (+qty). |
| POST | `/api/parts/:id/adjust` | editor | Set on-hand to a counted value. |
| GET | `/api/models` | any | All models with cost rollup + margin. |
| GET | `/api/models/:id` | any | One model: BOM lines + labor + rollup. |
| GET | `/api/inventory/summary` | any | Total valuation, SKU counts, below-reorder. |
| GET | `/api/audit` | admin | Recent change history. |

---

## Architecture

- **Node.js + Express** API (ESM), **PostgreSQL** via `pg` in production.
- **Auth**: `bcryptjs` password hashing, `jsonwebtoken` sessions, tier-based middleware
  (`viewer < editor < admin`) enforced on every write.
- **Cost engine** (`src/cost.js`): single source of truth for trailer cost and inventory value.
- **Data layer** (`src/db.js`): swaps PostgreSQL ↔ PGlite by environment, same SQL.
- **Schema**: `db/schema.sql`; seed: `db/seed.js`; catalog data: `db/catalog.json`.

```
phase1-builttrailers/
├─ src/         server.js · db.js · auth.js · cost.js
├─ db/          schema.sql · seed.js · catalog.json
├─ public/      index.html  (the live web UI)
├─ render.yaml  one-click Render blueprint (web + Postgres)
├─ Dockerfile   portable image for any host
└─ .env.example
```

---

## Verified

Booted against a live PostgreSQL-compatible engine and tested: health, login (and rejection
of bad credentials), JWT enforcement on protected routes, parts master (200 SKUs, 42 below
reorder), inventory valuation ($273,801), model cost rollup (e.g. UT7X14T total $1,721 at
37.4% margin), admin cost edits, and viewer write-blocking (403).

## Phases 2 & 3 — included

This build now also contains:

- **Phase 2 — Sales & fulfillment:** Sales-controlled, dealer-authorized order entry; a
  type-based fulfillment pipeline (drag across stages); inventory consumed at ship.
  Endpoints: `/api/customers`, `/api/trailer-types`, `/api/orders` (+ `/:id`, `/:id/stage`).
- **Phase 3 — Predictive ordering / MRP:** demand from open orders × production capacity
  × vendor lead times with cushion stock → ranked order/build recommendations, one-click
  and bulk PO generation, and receive-to-inventory. Endpoints: `/api/mrp`, `/api/po`
  (+ `/:id/receive`), `/api/mrp/auto`. Projected on-hand includes open POs, so the engine
  never recommends a duplicate order for something already inbound.

- **Phase 4 — Accounting + invoices:** QuickBooks integration that posts a customer
  invoice when an order ships and a vendor bill when a PO is received, plus OCR invoice
  intake that updates part costs (and flows into BOM cost + valuation). Works in a
  **simulated mode** out of the box (a real accounting ledger you can inspect); set
  `ACCOUNTING_MODE=quickbooks` + QBO credentials (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
  `QBO_REFRESH_TOKEN`, `QBO_REALM_ID`) to push live — the single hook is marked in
  `src/accounting.js`. Endpoints: `/api/accounting` (+ `/sync`), `/api/invoices` (+ `/scan`).

- **Phase 5 — People:** employees & burdened payroll whose **workstation rates flow into
  every BOM's labor cost** (change the team → trailer margins update); work schedules;
  a time-off approval workflow (employee → direct manager → Office Manager / payroll, with
  PTO auto-decrement); manager-set day/week/month outcomes; employee self-goals; and a
  recognition wall for individual/workstation/department wins with reactions. Endpoints:
  `/api/employees`, `/api/payroll/summary`, `/api/timeoff` (+ approve/deny/process),
  `/api/outcomes`, `/api/selfgoals`, `/api/wins` (+ react).

- **Phase 6 — Intelligence & comms:** ML demand forecasting (least-squares trend over a
  weekly demand series, with per-category confidence/R²), a live working-capital outlook,
  a what-if scenario planner (demand / material cost / added staff / horizon), and SMS
  notifications that auto-text customers on order-status changes. Simulated by default;
  set `SMS_MODE=twilio` + Twilio credentials to send live. Endpoints: `/api/forecast`,
  `/api/workingcapital`, `/api/scenario`, `/api/notifications` (+ `/send`).

## Connecting live QuickBooks

The connector is fully implemented in `src/qbo.js` (OAuth2 refresh-token flow + Invoice/Bill
creation, find-or-create customer/vendor). To switch from simulated to live:

1. At **developer.intuit.com**, create an app → get the **Client ID** and **Client Secret**.
2. Add a redirect URI and run the OAuth consent once to obtain a **Refresh Token** and your
   company's **Realm ID** (the Intuit OAuth Playground is the quickest way).
3. In QuickBooks, make sure at least one **Service item** and one **expense/COGS account** exist.
4. Set these env vars (locally in `.env`, or in the Render dashboard) and restart:
   `ACCOUNTING_MODE=quickbooks`, `QBO_ENV=production` (or `sandbox`), `QBO_CLIENT_ID`,
   `QBO_CLIENT_SECRET`, `QBO_REFRESH_TOKEN`, `QBO_REALM_ID`.

After that, shipping an order creates a QuickBooks **invoice** and receiving a PO creates a
**bill** automatically. If a call fails it's recorded as `pending` (with the reason in the
audit log) and retried on `POST /api/accounting/sync` — nothing is lost.

## Status

All six roadmap phases are built into this single deployable application — auth/roles,
dealer-gated sales + fulfillment, predictive MRP/purchasing, QuickBooks accounting + OCR,
people/payroll/scheduling/recognition, and forecasting/planning/SMS — on one PostgreSQL
foundation with JWT auth, role enforcement, and an audit log throughout.
