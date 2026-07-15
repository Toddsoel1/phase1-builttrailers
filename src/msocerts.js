// 📜 MSO certificate numbers — MSOs print on PRE-NUMBERED certificate paper, and every new
// batch of paper starts at a different number. The office sets the current starting number;
// each MSO print consumes the next one so app sequencing tracks the physical stack. If the
// printer eats a sheet, limited-access users can correct assignments — until a certificate is
// confirmed-and-locked, after which it never moves again.
import { all, one, q } from './db.js';

const KEY = 'mso_next_cert';

export async function nextCert() {
  return (await one('SELECT value FROM app_config WHERE key=$1', [KEY]).catch(() => null))?.value || null;
}

export async function setNextCert(value, userId) {
  const v = String(value || '').trim().toUpperCase();
  if (!v) throw new Error('Enter the certificate number on the NEXT blank sheet in the stack.');
  if (!/\d/.test(v)) throw new Error('Certificate numbers must contain digits so the sequence can advance.');
  await q(`INSERT INTO app_config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`, [KEY, v]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'mso.cert.next', `certificate counter set to ${v}`]).catch(() => {});
  return { next: v };
}

// "70009" → "70010", "N-000123" → "N-000124" (prefix + zero padding preserved).
const bump = v => {
  const m = String(v).match(/^(.*?)(\d+)$/);
  if (!m) throw new Error('Certificate number has no trailing digits to advance.');
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
};

// Assign the next certificate to a unit at MSO print time. Idempotent: printing again returns
// the SAME certificate unless supersede is set (a reprint on fresh paper), which consumes a
// new number — a locked certificate can never be superseded.
export async function assignCert(unitId, { supersede } = {}, userId) {
  const t = await one('SELECT id, vin, mso_cert_no, mso_cert_locked FROM trailer WHERE id=$1', [unitId]);
  if (!t) throw new Error('Trailer unit not found.');
  if (!t.vin) throw new Error('No VIN on this unit yet.');
  if (t.mso_cert_no && !supersede) return { certNo: t.mso_cert_no, existing: true };
  if (t.mso_cert_no && t.mso_cert_locked) throw new Error(`Certificate ${t.mso_cert_no} is confirmed and locked — it cannot be superseded.`);
  const cur = await nextCert();
  if (!cur) throw new Error('Set the current starting certificate number first (Print Center → MSO certificates).');
  await q('UPDATE trailer SET mso_cert_no=$1, mso_cert_locked=false, mso_cert_at=now() WHERE id=$2', [cur, unitId]);
  await q(`INSERT INTO app_config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`, [KEY, bump(cur)]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'mso.cert.assign', `${unitId} (${t.vin}) → certificate ${cur}${t.mso_cert_no ? ` (supersedes ${t.mso_cert_no})` : ''}`]).catch(() => {});
  return { certNo: cur, existing: false, superseded: t.mso_cert_no || null };
}

// Post-print correction (the printer mangled the stack) — limited access, refused once locked.
export async function editCert(unitId, certNo, userId) {
  const t = await one('SELECT id, vin, mso_cert_no, mso_cert_locked FROM trailer WHERE id=$1', [unitId]);
  if (!t) throw new Error('Trailer unit not found.');
  if (t.mso_cert_locked) throw new Error(`Certificate ${t.mso_cert_no} is confirmed and locked.`);
  const v = String(certNo || '').trim().toUpperCase();
  if (!v) throw new Error('Enter the certificate number.');
  const clash = await one('SELECT id FROM trailer WHERE mso_cert_no=$1 AND id<>$2', [v, unitId]);
  if (clash) throw new Error(`Certificate ${v} is already assigned to unit ${clash.id}.`);
  await q('UPDATE trailer SET mso_cert_no=$1 WHERE id=$2', [v, unitId]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'mso.cert.edit', `${unitId} (${t.vin}) certificate ${t.mso_cert_no || '—'} → ${v}`]).catch(() => {});
  return { certNo: v };
}

export async function lockCert(unitId, userId) {
  const t = await one('SELECT id, vin, mso_cert_no, mso_cert_locked FROM trailer WHERE id=$1', [unitId]);
  if (!t) throw new Error('Trailer unit not found.');
  if (!t.mso_cert_no) throw new Error('No certificate assigned to lock.');
  if (t.mso_cert_locked) return { ok: true, locked: true };
  await q('UPDATE trailer SET mso_cert_locked=true WHERE id=$1', [unitId]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'mso.cert.lock', `${unitId} (${t.vin}) certificate ${t.mso_cert_no} confirmed & locked`]).catch(() => {});
  return { ok: true, locked: true };
}

export async function certRegister() {
  const rows = await all(
    `SELECT t.id, t.vin, t.mso_cert_no, t.mso_cert_locked, t.mso_cert_at, m.name AS model
       FROM trailer t LEFT JOIN model m ON m.id=t.model_id
      WHERE t.mso_cert_no IS NOT NULL ORDER BY t.mso_cert_at DESC NULLS LAST LIMIT 25`, []);
  return rows.map(r => ({ unitId: r.id, vin: r.vin, certNo: r.mso_cert_no,
    locked: r.mso_cert_locked === true, at: r.mso_cert_at, model: r.model }));
}
