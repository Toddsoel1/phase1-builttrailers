# Database restore runbook

**Backups:** the server backs itself up nightly at 2am (Mountain) — every table → one gzipped
JSON file → the R2 bucket under `backups/`, keyed by day-of-month (`builttrailers-daily-DD.json.gz`,
a rolling ~30-day window). Manual snapshots: `npm run backup` (timestamped filename) or the app's
`POST /api/admin/backup/run`. Every run is in the audit log. If R2 isn't configured the file lands
in `./backups` on the server disk and the log shouts **NOT OFF-SITE**.

**Restores are manual on purpose** — nothing automated can ever overwrite production.

## Drill: inspect a backup locally (safe, do this quarterly)

```bash
# 1. Fetch a backup from R2 (Cloudflare dashboard → R2 → bucket → backups/ → download),
#    or grab a local one from ./backups.

# 2. Restore into a throwaway local database:
PGLITE_DIR=./restore-check node scripts/restore-db.js ~/Downloads/builttrailers-daily-07.json.gz --yes

# 3. Point a local server at it and look around:
PGLITE_DIR=./restore-check npm start     # open http://localhost:3000, log in, spot-check orders/parts

# 4. Clean up:
rm -rf ./restore-check
```

## Real recovery (production database lost/corrupted)

1. **Stop writes**: in Render, suspend the web service (Dashboard → service → Suspend).
2. **Create a fresh Postgres** in Render (don't reuse the damaged one — keep it for forensics).
3. **Restore into it** from your machine:
   ```bash
   DATABASE_URL='<new database external URL>' node scripts/restore-db.js <backup file> --yes
   ```
   The script prints the target and row counts; it exits non-zero if any row failed.
4. **Repoint the app**: service → Environment → set `DATABASE_URL` to the new database → resume.
5. **Verify**: `curl https://app.builttrailers.app/api/health` (db: postgres, fresh uptime),
   log in, check the Production Flow board and Parts Master against expectations.
6. You lose at most the work since the last nightly backup — tell the crew to re-enter today.

## Notes

- The script requires `--yes` and is destructive only for tables **in the dump** on the target DB.
- Restore order is derived from the live FK constraints (topological), with a retry pass for
  self-references; SERIAL sequences are reset past restored ids.
- The round-trip (seed → backup → restore → identical counts) is enforced by
  `test/restore.test.mjs` on every `npm test`, so the restore path can't silently rot.
