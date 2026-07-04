// Logical database backup as a callable module — every table dumped to one gzipped JSON file,
// uploaded to R2 when configured (off-site, durable), else written to BACKUP_DIR locally.
// Read-only by design: it can never mutate the live database; restore stays a deliberate,
// manual act. Used by the in-process daily scheduler + POST /api/admin/backup/run + npm run backup.
//
// Rolling mode keys the object by day-of-month (backups/daily-07.json.gz), giving a ~30-copy
// rolling window with zero pruning logic — day 7 next month simply overwrites day 7 this month.
import { gzipSync } from 'zlib';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { all } from './db.js';
import { r2Configured, r2Client } from './storage.js';

const KNOWN_TABLES = ['role', 'role_section', 'user_title', 'app_user', 'vendor', 'part', 'model',
  'bom_line', 'model_labor', 'trailer_type', 'customer', 'customer_allowed_type', 'sales_order',
  'order_stage_done', 'inventory_consumption', 'work_log', 'purchase_order', 'accounting_event',
  'invoice_batch', 'employee', 'time_off', 'user_outcome', 'self_goal', 'win', 'win_reaction',
  'notification', 'approval_rule', 'approval_request', 'audit_log', 'trailer', 'trailer_build_step',
  'warranty_registration', 'warranty_claim', 'warranty_claim_part', 'bom_change_request', 'app_config'];

async function tableNames() {
  const rows = await all(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`, []).catch(() => []);
  return rows.length ? rows.map(r => r.table_name) : KNOWN_TABLES;
}

export async function runBackup({ rolling = true } = {}) {
  const tables = await tableNames();
  const data = {};
  let totalRows = 0;
  for (const t of tables) {
    try { const rows = await all(`SELECT * FROM "${t}"`, []); data[t] = rows; totalRows += rows.length; }
    catch { /* table missing pre-migration — skip */ }
  }
  if (!Object.keys(data).length) throw new Error('No tables read — backup aborted.');

  const payload = { meta: { app: 'built-trailers', takenAt: new Date().toISOString(),
    tableCount: Object.keys(data).length, totalRows }, tables: data };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const name = rolling
    ? `builttrailers-daily-${String(new Date().getDate()).padStart(2, '0')}.json.gz`
    : `builttrailers-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json.gz`;
  const kb = Math.round(gz.length / 1024);

  if (r2Configured()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const Key = `backups/${name}`;
    await (await r2Client()).send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key, Body: gz, ContentType: 'application/gzip' }));
    return { ok: true, destination: 'r2', key: Key, tables: Object.keys(data).length, rows: totalRows, kb };
  }
  const dir = process.env.BACKUP_DIR || './backups';
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, name);
  await writeFile(out, gz);
  return { ok: true, destination: 'local', key: out, tables: Object.keys(data).length, rows: totalRows, kb,
    warning: 'R2 not configured — this copy is on the same machine as the database, NOT off-site.' };
}
