// VIN generation — produces a compliant 17-character VIN per trailer:
//   pos 1-3   WMI (manufacturer code, configurable; placeholder 'BLT')
//   pos 4-8   VDS (model/attribute descriptor, derived from the model)
//   pos 9     check digit (calculated per the NHTSA algorithm)
//   pos 10    model-year code
//   pos 11    plant code (configurable)
//   pos 12-17 sequential serial
// WMI and plant are stored in app_config so Accounting can set the real
// NHTSA-assigned values before any live VINs are issued.
import { one, q } from './db.js';

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
  return { wmi: await getCfg('vin_wmi', DEFAULTS.wmi), plant: await getCfg('vin_plant', DEFAULTS.plant) };
}
export async function setVinConfig({ wmi, plant }) {
  if (wmi != null && wmi !== '') await setCfg('vin_wmi', sanitize(wmi, 3));
  if (plant != null && plant !== '') await setCfg('vin_plant', sanitize(plant, 1));
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
