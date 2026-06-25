// Logical database backup — exports every table to one gzipped JSON file.
// Portable: works with both Postgres (prod) and PGlite (local), no external pg_dump binary.
// Uploads to Cloudflare R2 when the R2_* env vars are set; otherwise writes ./backups locally.
//
//   On demand:  npm run backup
//   Scheduled:  wired as a Render cron job in render.yaml (daily).
//
// This job only READS — it can never mutate the live database. Restore is manual on purpose
// (see scripts/restore-db.js note in the runbook), so an automated job can't clobber prod.
import { gzipSync } from 'zlib';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { initDb, all } from '../src/db.js';
import { r2Configured } from '../src/storage.js';

// Fallback list if information_schema is unavailable for any reason.
const KNOWN_TABLES = ['role', 'role_section', 'user_title', 'app_user', 'vendor', 'part', 'model',
  'bom_line', 'model_labor', 'trailer_type', 'customer', 'customer_allowed_type', 'sales_order',
  'order_stage_done', 'inventory_consumption', 'work_log', 'purchase_order', 'accounting_event',
  'invoice_batch', 'employee', 'time_off', 'user_outcome', 'self_goal', 'win', 'win_reaction',
  'notification', 'approval_rule', 'approval_request', 'audit_log', 'trailer', 'trailer_build_step',
  'warranty_registration', 'warranty_claim', 'warranty_claim_part', 'bom_change_request', 'app_config'];

async function tableNames() {
  const rows = await all(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
      ORDER BY table_name`, []).catch(() => []);
  return rows.length ? rows.map(r => r.table_name) : KNOWN_TABLES;
}

async function run() {
  const kind = await initDb();
  const tables = await tableNames();
  const data = {};
  let totalRows = 0;
  for (const t of tables) {
    try { const rows = await all(`SELECT * FROM "${t}"`, []); data[t] = rows; totalRows += rows.length; }
    catch (e) { console.warn(`  skip ${t}: ${e.message}`); }
  }
  if (!Object.keys(data).length) { console.error('No tables read — aborting backup.'); process.exit(1); }

  const payload = { meta: { app: 'built-trailers', dbKind: kind, takenAt: new Date().toISOString(), tableCount: Object.keys(data).length, totalRows }, tables: data };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const name = `builttrailers-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json.gz`;
  const sizeKb = (gz.length / 1024).toFixed(0);

  if (r2Configured()) {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    const Key = `backups/${name}`;
    await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key, Body: gz, ContentType: 'application/gzip' }));
    console.log(`✅ Backup uploaded to R2: ${Key} — ${Object.keys(data).length} tables, ${totalRows} rows, ${sizeKb} KB`);
  } else {
    const dir = process.env.BACKUP_DIR || './backups';
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, name);
    await writeFile(out, gz);
    console.log(`✅ Backup written: ${out} — ${Object.keys(data).length} tables, ${totalRows} rows, ${sizeKb} KB`);
    console.warn('⚠ R2 not configured — this copy is NOT offsite. Set R2_* env vars for durable, off-box backups.');
  }
  process.exit(0);
}
run().catch(e => { console.error('BACKUP FAILED:', e); process.exit(1); });
