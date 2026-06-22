// Standalone entrypoint for the morning SMS briefing.
// Run on a schedule via a Render Cron Job:  node scripts/send-briefing.js
// (The server also runs this in-process as a fallback — see server.js.)
import 'dotenv/config';
import { initDb } from '../src/db.js';
import { sendMorningBriefings } from '../src/briefing.js';

await initDb();
const r = await sendMorningBriefings(null);
console.log(`Morning briefing: sent ${r.sent}, skipped ${r.skipped}, errors ${r.errors}, of ${r.total} eligible.`);
process.exit(0);
