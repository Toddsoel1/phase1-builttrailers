// VIN generation — implements Built's filed 49 CFR Part 565 deciphering submission exactly:
//   pos 1-3   WMI (7XJ, assigned by SAE; placeholder 'BLT' until configured)
//   pos 4     type of trailer / hitch: B=Ball, P=Pintle, G=Gooseneck(5th wheel), K=Kingpin
//   pos 5     body type (filed table: A=Auto hauler, B=Boat/Watercraft, U=Utility, R=Landscape,
//             G=Cooking/Concession, N=Dump, E=Enclosed, F=Flat bed, …)
//   pos 6-7   length, exact feet (2 digits)
//   pos 8     number of axles
//   pos 9     check digit per 49 CFR 565.15(c)
//   pos 10    model-year code (…T=2026, V=2027; digits 1-9 = 2031-2039)
//   pos 11    plant (S = Saint George, Utah)
//   pos 12-17 sequential — RESTARTS AT 000001 EACH MODEL YEAR per the filing,
//             so the counter is stored per year (app_config vin_seq_<year>).
// WMI and plant live in app_config so Accounting sets the real values before live VINs.
import { all, one, q } from './db.js';

const DEFAULTS = { wmi: 'BLT', plant: 'A' };

async function getCfg(key, def) {
  const r = await one('SELECT value FROM app_config WHERE key=$1', [key]).catch(() => null);
  return r && r.value != null ? r.value : def;
}
async function setCfg(key, val) {
  await q(`INSERT INTO app_config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`, [key, String(val)]);
}

// VIN characters never include I, O, or Q (avoids confusion with 1/0).
function sanitize(s, len, pad = '0') {
  const up = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[IOQ]/g, '');
  return up.slice(0, len).padEnd(len, pad);
}

export async function vinConfig() {
  const year = serialKeyYear();
  return { wmi: await getCfg('vin_wmi', DEFAULTS.wmi), plant: await getCfg('vin_plant', DEFAULTS.plant),
    year, nextSerial: Number(await getCfg(`vin_seq_${year}`, '1')) || 1 };
}
export async function setVinConfig({ wmi, plant, nextSerial }) {
  if (wmi != null && wmi !== '') await setCfg('vin_wmi', sanitize(wmi, 3));
  if (plant != null && plant !== '') await setCfg('vin_plant', sanitize(plant, 1));
  // Where THIS model year's sequence continues from (the filing restarts at 000001 each year).
  // Set it past the highest serial already issued on paper for the current year, so app VINs
  // can never collide with pre-app trailers. Forward-only: never rewind the counter.
  if (nextSerial != null && nextSerial !== '') {
    const year = serialKeyYear();
    const n = Math.floor(Number(nextSerial));
    if (!Number.isFinite(n) || n < 1 || n > 999999) throw new Error('Next serial must be between 1 and 999999.');
    const cur = Number(await getCfg(`vin_seq_${year}`, '1')) || 1;
    if (n < cur) throw new Error(`The ${year} serial counter is already at ${cur} — it can only move forward.`);
    await setCfg(`vin_seq_${year}`, n);
  }
  return vinConfig();
}

// Model-year code table per 49 CFR 565: A=2010 … Y=2030 (skipping I,O,Q,U,Z),
// then digits 1-9 = 2031-2039; the letters restart at A in 2040 (30-year cycle).
const YEAR_MAP = 'ABCDEFGHJKLMNPRSTVWXY123456789';
function yearCode(y) {
  const idx = ((y - 2010) % YEAR_MAP.length + YEAR_MAP.length) % YEAR_MAP.length;
  return YEAR_MAP[idx];
}
// Decode position 10 back to a year (2010-2039 window). Null if not a valid code.
export function vinYear(vin) {
  const i = YEAR_MAP.indexOf(String(vin || '')[9]);
  return i >= 0 ? 2010 + i : null;
}

// Check-digit (position 9) per the standard VIN algorithm.
const TRANSLIT = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
  '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9 };
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
function checkDigit(vin17) {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (TRANSLIT[vin17[i]] || 0) * WEIGHTS[i];
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

// The filed body-type table (position 5) and the category → code mapping for Built's catalog.
export const HITCH_CODES = { B: 'Ball Hitch', P: 'Pintle Hitch', G: 'Gooseneck (Fifth Wheel)', K: 'Kingpin' };
export const BODY_CODES = {
  A: 'Auto / Vehicle / Equipment Hauler', B: 'Boat / Watercraft Trailer', C: 'Camper / Tiny Home',
  D: 'Dolly', E: 'Enclosed Trailer', F: 'Flat Bed Trailer', G: 'Cooking / Concession Trailer',
  H: 'Deck Over Trailer', J: 'Low Boy Trailer', K: 'Container Trailer', L: 'Livestock Trailer',
  M: 'Open Trailer', N: 'Dump Trailer', P: 'Pump Trailer', R: 'Landscape Trailer', S: 'Open Trailer',
  T: 'Tank Trailer', U: 'Utility Trailer', V: 'Roll-Off Trailer', W: 'Tilt Bed Trailer',
  X: 'Equipment Trailer', Y: 'Reel Trailer', Z: 'Drop deck Trailer',
};
const BODY_BY_CATEGORY = { boat: 'B', watercraft: 'B', utility: 'U', landscape: 'R', bbq: 'G',
  flatbed: 'F', 'flat bed': 'F', dump: 'N', enclosed: 'E', 'car hauler': 'A', equipment: 'X' };
const axlesFrom = s => /tri/i.test(s || '') ? 3 : /tand|dbl|dual/i.test(s || '') ? 2 : /sing/i.test(s || '') ? 1 : null;

// Positions 4-8 per the filing: hitch + body + length(2) + axles. Refuses to encode a guess —
// a federal identifier must not lie, so missing model data throws with exactly what to fill in.
function vds(m) {
  const hitch = String(m.hitch_code || 'B').toUpperCase();
  if (!HITCH_CODES[hitch]) throw new Error(`Model ${m.id}: hitch code "${hitch}" is not in the filed scheme (B/P/G/K).`);
  const body = String(m.body_code || BODY_BY_CATEGORY[String(m.category || '').toLowerCase()] || '').toUpperCase();
  if (!BODY_CODES[body]) throw new Error(`Model ${m.id}: set its Body code in Model print specs (Print Center) — the category "${m.category}" doesn't map to the filed table.`);
  const len = Math.round(Number(m.length_ft));
  if (!Number.isFinite(len) || len < 1 || len > 99) throw new Error(`Model ${m.id}: set its Length (ft) in Model print specs (Print Center) before VINs can be issued.`);
  const axles = Number(m.axles) || axlesFrom(m.axle);
  if (!axles || axles < 1 || axles > 9) throw new Error(`Model ${m.id}: set its Axles in Model print specs (Print Center) before VINs can be issued.`);
  return hitch + body + String(len).padStart(2, '0') + String(axles);
}

// Next serial for a model year — the filing restarts numbering at 000001 every year.
export async function nextSerial(year) {
  const key = `vin_seq_${year}`;
  const cur = Number(await getCfg(key, '1')) || 1;
  await setCfg(key, cur + 1);
  return cur;
}
export const serialKeyYear = () => new Date().getFullYear();

// Build a compliant 17-char VIN for a trailer of the given model. Returns { vin, serial }.
export async function generateVin(modelId) {
  const m = await one('SELECT * FROM model WHERE id=$1', [modelId]);
  if (!m) throw new Error(`Model ${modelId} not found.`);
  const { wmi, plant } = await vinConfig();
  const year = serialKeyYear();
  const wmi3 = sanitize(wmi, 3);
  const mid = vds(m);                                        // pos 4-8 (throws if specs missing)
  const yr = yearCode(year);                                 // pos 10
  const plant1 = sanitize(plant, 1);                         // pos 11
  const serial = await nextSerial(year);
  const serial6 = String(serial).padStart(6, '0').slice(-6); // pos 12-17
  const provisional = wmi3 + mid + '0' + yr + plant1 + serial6; // '0' placeholder at pos 9 (weight 0)
  const vin = wmi3 + mid + checkDigit(provisional) + yr + plant1 + serial6;
  return { vin, serial };
}
export const computeCheckDigit = checkDigit; // exported for the test suite's independent verification

// ---- NHTSA vPIC verification ----
// Every issued VIN is double-checked against the federal decoder (the API behind
// https://vpic.nhtsa.dot.gov/decoder/): check digit, WMI/manufacturer registration,
// model year, and vehicle type. Results are stored on the trailer so the office sees
// pass/fail in the Print Center without re-querying NHTSA.
const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles';

// Judge one vPIC DecodeVinValues row. Pure — unit-tested with fixture payloads.
export function evaluateNhtsa(row, vin) {
  const issues = [];
  const codes = String(row.ErrorCode ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (!codes.every(c => c === '0'))
    issues.push(String(row.ErrorText || `vPIC error ${row.ErrorCode}`).split(';')[0].trim());
  const mfr = String(row.Manufacturer || row.Make || '').trim();
  if (!mfr) issues.push('Manufacturer not recognized — is the WMI registered with NHTSA?');
  else if (!/BUILT/i.test(mfr)) issues.push(`Manufacturer decodes as "${mfr}" — expected Built Manufacturing`);
  const expectYear = vinYear(vin);
  if (row.ModelYear && expectYear && Number(row.ModelYear) !== expectYear)
    issues.push(`Model year decodes as ${row.ModelYear} — this VIN was issued for ${expectYear}`);
  const vt = String(row.VehicleType || '').trim();
  if (vt && !/TRAILER/i.test(vt)) issues.push(`Vehicle type decodes as "${vt}" — expected TRAILER`);
  return { ok: issues.length === 0, note: issues.join(' · ') || 'VIN decoded clean' };
}

// Decode up to 50 VINs in one vPIC batch call. Returns { VIN -> vPIC row }.
async function vpicBatch(vins) {
  const r = await fetch(`${VPIC}/DecodeVINValuesBatch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `format=json&data=${encodeURIComponent(vins.join(';'))}`,
  });
  if (!r.ok) throw new Error(`vPIC ${r.status}`);
  const data = await r.json();
  const map = {};
  for (const row of data.Results || []) if (row.VIN) map[String(row.VIN).toUpperCase()] = row;
  return map;
}

// Check the given units (or every VIN'd unit with `all: true`) and stamp the results.
// Network failure marks nothing — units stay "unchecked" and the error is reported.
export async function nhtsaCheckUnits({ unitIds, checkAll, recheck } = {}) {
  if (['1', 'true'].includes(String(process.env.NHTSA_DISABLED))) return { skipped: 'NHTSA checks disabled' };
  let units;
  if (checkAll) units = await all(`SELECT id, vin FROM trailer WHERE vin IS NOT NULL${recheck ? '' : ' AND nhtsa_checked_at IS NULL'} ORDER BY id`, []);
  else units = await all(`SELECT id, vin FROM trailer WHERE id = ANY($1) AND vin IS NOT NULL`, [unitIds || []]);
  if (!units.length) return { checked: 0, passed: 0, failed: 0, results: [] };
  const results = [];
  let passed = 0, failed = 0;
  for (let i = 0; i < units.length; i += 50) {
    const batch = units.slice(i, i + 50);
    let rows;
    try { rows = await vpicBatch(batch.map(u => u.vin)); }
    catch (e) { return { checked: results.length, passed, failed, results, error: `NHTSA vPIC unreachable (${e.message}) — nothing marked; try again later.` }; }
    for (const u of batch) {
      const row = rows[String(u.vin).toUpperCase()];
      const v = row ? evaluateNhtsa(row, u.vin) : { ok: false, note: 'vPIC returned no result for this VIN' };
      await q(`UPDATE trailer SET nhtsa_checked_at=now(), nhtsa_ok=$1, nhtsa_note=$2 WHERE id=$3`, [v.ok, v.note.slice(0, 400), u.id]);
      results.push({ unitId: u.id, vin: u.vin, ...v });
      if (v.ok) passed++; else failed++;
    }
  }
  return { checked: results.length, passed, failed, results };
}
