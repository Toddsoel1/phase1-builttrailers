// The restore drill, automated: seed a database → back it up → restore into a SECOND, empty
// database → every table's row count must match. Runs on every `npm test`, so the restore path
// (the half of "backups" that usually rots) is proven continuously.
// Each step is a child process because src/db.js holds one database per process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (args, env) => new Promise((resolve, reject) => {
  const p = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  p.on('exit', c => c === 0 ? resolve(out) : reject(new Error(`node ${args.join(' ')} exited ${c}\n${out}\n${err}`)));
});

const COUNTS_SNIPPET = `
  import { initDb, all } from './src/db.js';
  await initDb();
  const tables = (await all("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name", [])).map(r => r.table_name);
  const counts = {};
  for (const t of tables) counts[t] = Number((await all('SELECT COUNT(*)::int AS n FROM "' + t + '"', []))[0].n);
  console.log('COUNTS::' + JSON.stringify(counts));
  process.exit(0);
`;
const countsFor = async dir => {
  const out = await run(['--input-type=module', '-e', COUNTS_SNIPPET], { PGLITE_DIR: dir });
  return JSON.parse(out.split('COUNTS::')[1].trim());
};

test('backup -> restore round trip preserves every table', async () => {
  const A = mkdtempSync(path.join(tmpdir(), 'bt-restore-A-'));
  const B = mkdtempSync(path.join(tmpdir(), 'bt-restore-B-'));
  const BAK = mkdtempSync(path.join(tmpdir(), 'bt-restore-bak-'));
  try {
    await run(['db/seed.js'], { PGLITE_DIR: A, SEED_DEMO: '1' });
    await run(['scripts/backup-db.js'], { PGLITE_DIR: A, BACKUP_DIR: BAK });
    const file = readdirSync(BAK).find(f => f.endsWith('.json.gz'));
    assert.ok(file, 'backup file written');
    await run(['scripts/restore-db.js', path.join(BAK, file), '--yes'], { PGLITE_DIR: B });

    const a = await countsFor(A);
    const b = await countsFor(B);
    const populated = Object.keys(a).filter(t => a[t] > 0);
    assert.ok(populated.length >= 20, `seed populated ${populated.length} tables`);
    for (const t of Object.keys(a)) assert.equal(b[t], a[t], `row count matches for ${t}`);
  } finally {
    for (const d of [A, B, BAK]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
});
