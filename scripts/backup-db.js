// Manual backup entrypoint — same engine as the server's built-in daily backup (src/backup.js),
// but with a full-timestamp filename so manual snapshots never overwrite the rolling dailies.
//
//   On demand:  npm run backup
//   (The server also backs itself up daily in-process — see the scheduler in src/server.js —
//    and admins can trigger one from the app via POST /api/admin/backup/run.)
//
// Read-only: this can never mutate the live database. Restore is manual on purpose, so an
// automated job can't clobber prod.
import { initDb } from '../src/db.js';
import { runBackup } from '../src/backup.js';

async function run() {
  await initDb();
  const r = await runBackup({ rolling: false });
  console.log(`✅ Backup ${r.destination === 'r2' ? 'uploaded to R2' : 'written'}: ${r.key} — ${r.tables} tables, ${r.rows} rows, ${r.kb} KB`);
  if (r.warning) console.warn('⚠', r.warning);
  process.exit(0);
}
run().catch(e => { console.error('BACKUP FAILED:', e); process.exit(1); });
