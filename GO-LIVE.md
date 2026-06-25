# Built Trailers — Go-Live Checklist

Stabilization Tiers 1–4 are built and committed. These are the **owner-only** setup steps —
things that can't be done from code (Render dashboard, GitHub settings, external services).
Ordered by priority. Each item notes *where* to do it.

---

## 1. Data safety — do this first

> This is what protects you from another "the users disappeared" incident.

- [ ] **Enable Render managed Postgres backups.**
      Render dashboard → database **built-trailers-db** → **Recovery / Backups** → confirm
      daily backups + point-in-time recovery are on. (The `basic-256mb` plan may need a bump
      for PITR.)
- [ ] **Confirm the DB is a persistent, paid instance** — not an expiring free tier. Render
      deletes free Postgres after ~90 days, which is what wiped the user accounts.
- [ ] **Do NOT set `SEED_DEMO=1` in production.** Leaving it unset keeps the seed fail-safe
      (it can no longer wipe or reseed a database that has data).
- [ ] *(Optional)* Set `OWNER_USERNAME` / `OWNER_PASSWORD` in Render env, so if the DB is ever
      empty the auto-created recovery admin uses your credentials instead of the default.
- [ ] *(Optional)* Turn on the nightly **offsite** backup: set `R2_ACCOUNT_ID`,
      `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` on the **built-trailers-backup**
      cron service in `render.yaml`. (Or delete that cron block to rely on Render backups alone.)
      You can also run a backup on demand any time: `npm run backup`.

## 2. Ship the stabilization work

- [ ] **Verify locally:** `npm install && npm run lint && npm test` → expect `# pass 48`, lint clean.
- [ ] **Merge `feat/dealer-subdomains` → your default branch** and let Render deploy. This brings
      the fail-safe seed, test suite, CI, observability, and the Tier-4 changes to production.
- [ ] After deploy, hit `https://app.builttrailers.app/api/health` → expect `{"ok":true,...}`.

## 3. Catch regressions automatically

- [ ] After the workflow is on your default branch, **make `CI` a required check:**
      GitHub → repo **Settings → Branches → Branch protection** (default branch) → require the
      **CI** status check. A red suite then blocks merging (and therefore deploying).
- [ ] *(Optional)* **Staging:** uncomment the `previews:` block in `render.yaml` for a throwaway
      app+DB per pull request. Adds cost; leave commented to rely on CI + manual promotion.

## 4. See problems the moment they happen

- [ ] **Pick an alert channel** (Render env — either or both):
  - `ALERT_WEBHOOK_URL` — a Slack/Discord incoming webhook. Instant ping on any server error,
    ~2 minutes to set up, no new dependencies.
  - `SENTRY_DSN` — full error dashboard. Also run `npm install @sentry/node` and commit it.
  - *(Without either, errors still go to Render's searchable logs.)*
- [ ] **Add an uptime monitor** on `https://app.builttrailers.app/api/health` (UptimeRobot's free
      tier works). It returns **503 when the database is down**, so you're paged on real outages,
      not just when the server process dies.

## Feature env vars (only if you use the feature, and not already set)

- [ ] `QBO_ENV` / `QBO_REALM_ID` — QuickBooks (already connected, listed for completeness).
- [ ] `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — web push notifications.
- [ ] `R2_*` — Cloudflare R2 for uploads/OCR and the backup cron (see item 1).

---

## Already done — no action needed

Fail-safe seed (cannot wipe prod) · on-demand + scheduled DB backup · smoke + lint test suites ·
GitHub Actions CI · structured logging + central error capture + deep DB health check + browser
crash capture · request IDs · N+1 query elimination · unified schema application · QuickBooks
single-flight token refresh.

_See the Tier 1–4 commits for details._
