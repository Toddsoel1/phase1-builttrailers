// Restore a logical backup (the gzipped JSON written by src/backup.js) into the target
// database. DESTRUCTIVE for the tables in the dump — which is why it demands --yes and
// prints exactly what it's about to do first.
//
//   Local/PGlite:  PGLITE_DIR=./restore-here node scripts/restore-db.js backups/<file>.json.gz --yes
//   Postgres:      DATABASE_URL=<url>        node scripts/restore-db.js <file>.json.gz --yes
//
// How it works: ensures the schema exists, discovers foreign-key dependencies from
// information_schema, topologically orders the tables, DELETEs children-first, INSERTs
// parents-first, retries rows that failed on the first pass (self-references like
// app_user.manager_id resolve once the rest of the table is in), then resets SERIAL
// sequences. Full restore drill: see docs/RESTORE-RUNBOOK.md.
import { gunzipSync } from 'zlib';
import { readFileSync } from 'fs';
import { initDb, q, all } from '../src/db.js';
import { ensureSchema } from '../db/migrate.js';

const file = process.argv[2];
const yes = process.argv.includes('--yes');
if (!file || !yes) {
  console.error('Usage: node scripts/restore-db.js <backup.json.gz> --yes');
  console.error('       (--yes acknowledges this OVERWRITES the target database\'s data)');
  process.exit(1);
}

async function topoOrder(tables) {
  // parent -> children edges from FK constraints; order parents before children.
  const fks = await all(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`, []).catch(() => []);
  const set = new Set(tables);
  const deps = Object.fromEntries(tables.map(t => [t, new Set()]));
  for (const f of fks)
    if (set.has(f.child) && set.has(f.parent) && f.child !== f.parent) deps[f.child].add(f.parent);
  const ordered = [];
  const seen = new Set();
  const visit = (t, stack = new Set()) => {
    if (seen.has(t) || stack.has(t)) return; // cycles: fall back to retry pass
    stack.add(t);
    for (const p of deps[t]) visit(p, stack);
    stack.delete(t); seen.add(t); ordered.push(t);
  };
  for (const t of tables) visit(t);
  return ordered;
}

async function run() {
  const payload = JSON.parse(gunzipSync(readFileSync(file)).toString());
  const tables = Object.keys(payload.tables || {});
  if (!tables.length) { console.error('Backup contains no tables — aborting.'); process.exit(1); }

  const kind = await initDb();
  const target = kind === 'postgres' ? (process.env.DATABASE_URL || '').replace(/:\/\/.*@/, '://***@') : (process.env.PGLITE_DIR || './.pglite');
  console.log(`Restoring ${file}`);
  console.log(`  taken at:  ${payload.meta?.takenAt} (${payload.meta?.totalRows} rows, ${payload.meta?.tableCount} tables)`);
  console.log(`  target:    ${kind} → ${target}`);

  await ensureSchema();
  const order = await topoOrder(tables);

  // Wipe children-first so FKs never block the deletes.
  for (const t of [...order].reverse()) await q(`DELETE FROM "${t}"`).catch(e => console.warn(`  delete ${t}: ${e.message}`));

  // Insert parents-first; anything that trips a constraint goes to a retry pass.
  let inserted = 0;
  const retries = [];
  const insertRow = async (t, row) => {
    const cols = Object.keys(row);
    if (!cols.length) return;
    await q(`INSERT INTO "${t}"(${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
      cols.map(c => row[c]));
  };
  for (const t of order) {
    for (const row of payload.tables[t]) {
      try { await insertRow(t, row); inserted++; }
      catch { retries.push([t, row]); }
    }
  }
  let failed = 0;
  for (const [t, row] of retries) {
    try { await insertRow(t, row); inserted++; }
    catch (e) { failed++; if (failed <= 5) console.warn(`  FAILED ${t}: ${e.message}`); }
  }

  // SERIAL sequences must resume past the restored max ids.
  for (const t of order) {
    await q(`SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT MAX(id) FROM "${t}"), 1))`).catch(() => {});
  }

  console.log(`✅ Restore complete: ${inserted} rows across ${order.length} tables${retries.length ? ` (${retries.length} needed a retry pass)` : ''}.`);
  if (failed) { console.error(`❌ ${failed} row(s) could not be restored — inspect the warnings above.`); process.exit(1); }
  process.exit(0);
}
run().catch(e => { console.error('RESTORE FAILED:', e); process.exit(1); });
