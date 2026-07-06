// VIN generation — produces a compliant 17-character VIN per trailer:
//   pos 1-3   WMI (manufacturer code, configurable; placeholder 'BLT')
//   pos 4-8   VDS (model/attribute descriptor, derived from the model)
//   pos 9     check digit (calculated per the NHTSA algorithm)
//   pos 10    model-year code
//   pos 11    plant code (configurable)
//   pos 12-17 sequential serial
// WMI and plant are stored in app_config so Accounting can set the real
// NHTSA-assigned values before any live VINs are issued.
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
  return { wmi: await getCfg('vin_wmi', DEFAULTS.wmi), plant: await getCfg('vin_plant', DEFAULTS.plant),
    nextSerial: Number(await getCfg('vin_seq', '1')) || 1 };
}
export async function setVinConfig({ wmi, plant, nextSerial }) {
  if (wmi != null && wmi !== '') await setCfg('vin_wmi', sanitize(wmi, 3));
  if (plant != null && plant !== '') await setCfg('vin_plant', sanitize(plant, 1));
  // Where the sequence continues from — set past the highest serial already issued on paper,
  // so app VINs can never collide with pre-app trailers. Forward-only: never rewind the counter.
  if (nextSerial != null && nextSerial !== '') {
    const n = Math.floor(Number(nextSerial));
    if (!Number.isFinite(n) || n < 1 || n > 999999) throw new Error('Next serial must be between 1 and 999999.');
    const cur = Number(await getCfg('vin_seq', '1')) || 1;
    if (n < cur) throw new Error(`The serial counter is already at ${cur} — it can only move forward.`);
    await setCfg('vin_seq', n);
  }
  return vinConfig();
}

// Model-year code table (A=2010 … Y=2030), excluding I,O,Q,U,Z and 0.
function yearCode(y) {
  const map = 'ABCDEFGHJKLMNPRSTVWXY';
  const idx = y - 2010;
  return (idx >= 0 && idx < map.length) ? map[idx] : map[((idx % map.length) + map.length) % map.length];
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

// Positions 4-8: manufacturer descriptor derived from the model id + category.
function descriptor(modelId, category) {
  const base = (String(modelId || '') + String(category || '')).toUpperCase()
    .replace(/[^A-Z0-9]/g, '').replace(/[IOQ]/g, 'X');
  return (base + '00000').slice(0, 5);
}

// Next sequential serial (persisted), used for positions 12-17.
export async function nextSerial() {
  const cur = Number(await getCfg('vin_seq', '1')) || 1;
  await setCfg('vin_seq', cur + 1);
  return cur;
}

// Build a compliant 17-char VIN for a trailer. Returns { vin, serial }.
export async function generateVin({ modelId, category }) {
  const { wmi, plant } = await vinConfig();
  const serial = await nextSerial();
  const wmi3 = sanitize(wmi, 3);
  const vds = descriptor(modelId, category);                 // pos 4-8
  const yr = yearCode(new Date().getFullYear());             // pos 10
  const plant1 = sanitize(plant, 1);                         // pos 11
  const serial6 = String(serial).padStart(6, '0').slice(-6); // pos 12-17
  const provisional = wmi3 + vds + '0' + yr + plant1 + serial6; // '0' placeholder at pos 9 (weight 0)
  const vin = wmi3 + vds + checkDigit(provisional) + yr + plant1 + serial6;
  return { vin, serial };
}

// ---- NHTSA vPIC verification ----
// Every issued VIN is double-checked against the federal decoder (the API behind
// https://vpic.nhtsa.dot.gov/decoder/): check digit, WMI/manufacturer registration,
// model year, and vehicle type. Results are stored on the trailer so the office sees
// pass/fail in the Print Center without re-querying NHTSA.
const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const YEAR_MAP = 'ABCDEFGHJKLMNPRSTVWXY';
const vinYear = vin => { const i = YEAR_MAP.indexOf(String(vin || '')[9]); return i >= 0 ? 2010 + i : null; };

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
