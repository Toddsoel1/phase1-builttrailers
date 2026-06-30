// Manual importer for Built Trailers' dealer network. The same list normally seeds itself
// automatically at server startup (src/dealerseed.js — one-time, guarded by an app_config flag),
// so you usually don't need this. Run it only to FORCE a re-apply (e.g. after correcting a baked
// address or coordinate in src/dealerseed.js) without waiting on / resetting the startup seed.
//
//   DATABASE_URL=<prod-url> node scripts/import-dealers.js
//   (or in the Render shell:  node scripts/import-dealers.js)
//
// Idempotent — upserts by name; safe to re-run.
import { initDb } from '../src/db.js';
import { ensureSchema } from '../db/migrate.js';
import { DEALERS, upsertDealer } from '../src/dealerseed.js';

async function run() {
  await initDb();
  await ensureSchema();
  let added = 0, updated = 0; const noCoords = [];
  for (let i = 0; i < DEALERS.length; i++) {
    if (DEALERS[i][6] == null) noCoords.push(DEALERS[i][0]);
    (await upsertDealer(DEALERS[i], i)) === 'added' ? added++ : updated++;
  }
  console.log(`Done — ${added} added, ${updated} updated, ${DEALERS.length - noCoords.length}/${DEALERS.length} on the map.`);
  if (noCoords.length) console.log(`Set coordinates by hand (Customers & Dealers -> the dealer's address editor): ${noCoords.join(', ')}`);
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
