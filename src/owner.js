// Owner accounts for owner.builttrailers.app. Separate from staff (app_user) and dealer
// tokens: a trailer owner registers their trailer, which creates an account (email = username)
// they log into to file warranty claims, log maintenance, and access their documents. Owner
// tokens carry kind:'owner'. An owner's trailers are linked by the registration email, so any
// registration made with that email — past or future — shows up in their account automatically.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { all, one, q } from './db.js';
import { hashPassword, checkPassword, JWT_SECRET } from './auth.js';
import { submitRegistration, submitPublicClaim, submitMaintenance } from './portal.js';
import { sendPasswordReset } from './email.js';

const DEFAULT_PORTAL = process.env.OWNER_PORTAL_URL || 'https://owner.builttrailers.app';

function signOwnerToken(o) {
  return jwt.sign({ id: o.id, kind: 'owner', email: o.email }, JWT_SECRET, { expiresIn: '30d' });
}

export async function ownerAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const p = jwt.verify(tok, JWT_SECRET);
    if (p.kind !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    const o = await one('SELECT * FROM owner_user WHERE id=$1', [p.id]);
    if (!o) return res.status(401).json({ error: 'Account not found' });
    req.owner = o;
    next();
  } catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}

async function context(o) {
  const trailers = await myTrailers(o);
  return { name: o.name, email: o.email, trailerCount: trailers.length };
}
export const me = context;

// Create an account (email = username) and, when trailer details are provided, register the
// trailer to it in one step. Used both by a new owner registering their first trailer and by
// an owner "claiming" an account for registrations already made under their email.
export async function register(data) {
  const { email, password, name, vin } = data || {};
  if (!email || !password) throw new Error('Email and password are required.');
  if (String(password).length < 8) throw new Error('Password must be at least 8 characters.');
  if (await one('SELECT id FROM owner_user WHERE lower(email)=lower($1)', [email]))
    throw new Error('An account with that email already exists — please log in or reset your password.');
  const id = 'OWN-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  await q(`INSERT INTO owner_user(id,email,password_hash,name,status) VALUES($1,$2,$3,$4,'active')`,
    [id, email.trim(), hashPassword(password), name || null]);
  let registration = null;
  if (vin) registration = await submitRegistration({ ...data, email: email.trim(), ownerName: data.ownerName || name, source: 'owner' });
  const o = await one('SELECT * FROM owner_user WHERE id=$1', [id]);
  return { token: signOwnerToken(o), owner: await context(o), registration };
}

export async function login({ email, password }) {
  const o = await one('SELECT * FROM owner_user WHERE lower(email)=lower($1)', [email || '']);
  if (!o || !checkPassword(password || '', o.password_hash)) throw new Error('Invalid email or password.');
  if (o.status === 'disabled') throw new Error('This account is disabled. Please contact Built Trailers.');
  await q('UPDATE owner_user SET last_login=now() WHERE id=$1', [o.id]).catch(() => {});
  return { token: signOwnerToken(o), owner: await context(o) };
}

// Self-service password reset. Always resolves ok so the response never reveals whether an
// account exists for that email.
export async function requestReset(email, baseUrl) {
  const o = await one('SELECT * FROM owner_user WHERE lower(email)=lower($1)', [email || '']);
  if (o) {
    const token = crypto.randomBytes(32).toString('hex');
    await q("UPDATE owner_user SET reset_token=$1, reset_expires=now() + interval '1 hour' WHERE id=$2", [token, o.id]);
    const url = `${baseUrl || DEFAULT_PORTAL}/reset?token=${token}`;
    try { await sendPasswordReset({ email: o.email, ownerName: o.name, resetUrl: url }); } catch { /* email layer logs */ }
  }
  return { ok: true };
}

export async function resetPassword(token, newPassword) {
  if (!token || !newPassword) throw new Error('A reset token and new password are required.');
  if (String(newPassword).length < 8) throw new Error('Password must be at least 8 characters.');
  const o = await one('SELECT * FROM owner_user WHERE reset_token=$1 AND reset_expires > now()', [token]);
  if (!o) throw new Error('This reset link is invalid or has expired. Please request a new one.');
  await q('UPDATE owner_user SET password_hash=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2', [hashPassword(newPassword), o.id]);
  return { ok: true };
}

export async function changePassword(o, currentPassword, newPassword) {
  if (!checkPassword(currentPassword || '', o.password_hash)) throw new Error('Current password is incorrect.');
  if (String(newPassword || '').length < 8) throw new Error('New password must be at least 8 characters.');
  await q('UPDATE owner_user SET password_hash=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2', [hashPassword(newPassword), o.id]);
  return { ok: true };
}

// An owner's trailers = warranty registrations made with their email.
export async function myTrailers(o) {
  const rows = await all(
    `SELECT r.trailer_id, r.owner_name, r.sale_date, r.term_months, r.verification_status, r.warranty_address,
            t.vin, m.name AS model, m.category
       FROM warranty_registration r JOIN trailer t ON t.id=r.trailer_id
       LEFT JOIN model m ON m.id=t.model_id
      WHERE lower(r.email)=lower($1) ORDER BY r.registered_at DESC`, [o.email]);
  return rows.map(r => ({ vin: r.vin, model: r.model, category: r.category, owner: r.owner_name,
    saleDate: r.sale_date, termMonths: r.term_months, status: r.verification_status }));
}

// Confirm a VIN is registered to this owner before accepting a claim/maintenance entry for it.
async function ownsVin(o, vin) {
  return !!await one(
    `SELECT 1 AS x FROM warranty_registration r JOIN trailer t ON t.id=r.trailer_id
      WHERE upper(t.vin)=upper($1) AND lower(r.email)=lower($2)`, [String(vin || '').trim(), o.email]);
}

export async function myClaims(o) {
  const rows = await all(
    `SELECT wc.id, wc.status, wc.issue, wc.opened_at, wc.resolution, t.vin, m.name AS model
       FROM warranty_claim wc JOIN trailer t ON t.id=wc.trailer_id
       JOIN warranty_registration r ON r.trailer_id=t.id
       LEFT JOIN model m ON m.id=t.model_id
      WHERE lower(r.email)=lower($1) ORDER BY wc.opened_at DESC`, [o.email]);
  return rows.map(c => ({ id: c.id, vin: c.vin, model: c.model, status: c.status, issue: c.issue, openedAt: c.opened_at, resolution: c.resolution }));
}

export async function myMaintenance(o) {
  const rows = await all(
    `SELECT mr.id, mr.item, mr.performed_on, mr.note, mr.mileage, mr.parts, mr.created_at, t.vin
       FROM maintenance_record mr JOIN trailer t ON t.id=mr.trailer_id
       JOIN warranty_registration r ON r.trailer_id=t.id
      WHERE lower(r.email)=lower($1) ORDER BY mr.performed_on DESC NULLS LAST, mr.created_at DESC`, [o.email]);
  return rows.map(m => ({ id: m.id, vin: m.vin, item: m.item, performedOn: m.performed_on, mileage: m.mileage, parts: m.parts, note: m.note }));
}

export async function submitClaim(o, data) {
  if (!await ownsVin(o, data?.vin)) throw new Error('That VIN is not registered to your account.');
  return submitPublicClaim({ ...data, submittedBy: o.name || o.email, contact: o.email });
}

export async function logMaintenance(o, data) {
  if (!await ownsVin(o, data?.vin)) throw new Error('That VIN is not registered to your account.');
  return submitMaintenance({ ...data, submittedBy: o.name || o.email });
}
