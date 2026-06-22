// Dealership accounts for dealership.builttrailers.app. Separate from staff
// (app_user) auth: dealers sign up, stay 'pending' until Built Trailers staff
// approve and link them to their dealer (customer) record, then log in to
// register the trailers they sold (their dealership auto-fills) and track claims.
// Dealer tokens carry kind:'dealer' and are rejected by the staff authMiddleware.
import jwt from 'jsonwebtoken';
import { all, one, q } from './db.js';
import { hashPassword, checkPassword, JWT_SECRET } from './auth.js';
import { submitRegistration } from './portal.js';

function signDealerToken(d) {
  return jwt.sign({ id: d.id, kind: 'dealer', email: d.email }, JWT_SECRET, { expiresIn: '12h' });
}

export async function dealerAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const p = jwt.verify(tok, JWT_SECRET);
    if (p.kind !== 'dealer') return res.status(403).json({ error: 'Dealer access required' });
    const d = await one('SELECT * FROM dealer_user WHERE id=$1', [p.id]);
    if (!d) return res.status(401).json({ error: 'Account not found' });
    if (d.status !== 'active') return res.status(403).json({ error: 'Your account is pending approval by Built Trailers.' });
    req.dealer = d;
    next();
  } catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}

export async function signup({ email, password, name, dealershipName }) {
  if (!email || !password || !name || !dealershipName) throw new Error('Name, dealership, email, and password are all required.');
  if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
  if (await one('SELECT id FROM dealer_user WHERE lower(email)=lower($1)', [email])) throw new Error('An account with that email already exists.');
  const id = 'DLR-' + Date.now().toString(36);
  await q(`INSERT INTO dealer_user(id,email,password_hash,name,dealership_name,status) VALUES($1,$2,$3,$4,$5,'pending')`,
    [id, email, hashPassword(password), name, dealershipName]);
  return { ok: true, status: 'pending' };
}

export async function login({ email, password }) {
  const d = await one('SELECT * FROM dealer_user WHERE lower(email)=lower($1)', [email || '']);
  if (!d || !checkPassword(password || '', d.password_hash)) throw new Error('Invalid email or password.');
  if (d.status === 'pending') throw new Error('Your account is still pending approval by Built Trailers.');
  if (d.status === 'rejected') throw new Error('This account was not approved. Please contact Built Trailers.');
  return { token: signDealerToken(d), dealer: await context(d) };
}

// Resolve the dealer's display name + linked dealer record.
async function context(d) {
  let dealership = d.dealership_name, customerId = d.customer_id;
  if (d.customer_id) { const c = await one('SELECT name FROM customer WHERE id=$1', [d.customer_id]); if (c) dealership = c.name; }
  return { name: d.name, email: d.email, dealership, customerId };
}
export const me = context;

// Register a trailer the dealer sold — selling dealership auto-fills from the account.
export async function registerTrailer(d, data) {
  const ctx = await context(d);
  // A linked dealer may only register their own units.
  if (d.customer_id) {
    const t = await one('SELECT customer_id FROM trailer WHERE upper(vin)=upper($1)', [String(data?.vin || '').trim()]);
    if (t && t.customer_id && t.customer_id !== d.customer_id) throw new Error('That VIN belongs to a different dealership.');
  }
  return submitRegistration({ ...data, sellingDealer: ctx.dealership, source: 'dealer' });
}

export async function myRegistrations(d) {
  if (!d.customer_id) return [];
  const rows = await all(`SELECT r.owner_name, r.sale_date, r.verification_status, r.within_15_days, t.vin, m.name AS model
                            FROM warranty_registration r JOIN trailer t ON t.id=r.trailer_id
                            LEFT JOIN model m ON m.id=t.model_id
                           WHERE t.customer_id=$1 ORDER BY r.registered_at DESC`, [d.customer_id]);
  return rows.map(r => ({ vin: r.vin, model: r.model, owner: r.owner_name, saleDate: r.sale_date, status: r.verification_status, within15: r.within_15_days }));
}
export async function myClaims(d) {
  if (!d.customer_id) return [];
  const rows = await all(`SELECT wc.id, wc.status, wc.issue, wc.opened_at, t.vin, m.name AS model
                            FROM warranty_claim wc JOIN trailer t ON t.id=wc.trailer_id
                            LEFT JOIN model m ON m.id=t.model_id
                           WHERE t.customer_id=$1 ORDER BY wc.opened_at DESC`, [d.customer_id]);
  return rows.map(c => ({ id: c.id, vin: c.vin, model: c.model, status: c.status, issue: c.issue, openedAt: c.opened_at }));
}

// ---- staff side ----
export async function pendingDealers() {
  return (await all(`SELECT id,email,name,dealership_name,created_at FROM dealer_user WHERE status='pending' ORDER BY created_at DESC`, []))
    .map(d => ({ id: d.id, email: d.email, name: d.name, dealershipName: d.dealership_name, createdAt: d.created_at }));
}
export async function approveDealer(id, customerId) {
  if (!await one('SELECT id FROM dealer_user WHERE id=$1', [id])) throw new Error('account not found');
  await q(`UPDATE dealer_user SET status='active', customer_id=$1 WHERE id=$2`, [customerId || null, id]);
  return { ok: true };
}
export async function rejectDealer(id) {
  await q(`UPDATE dealer_user SET status='rejected' WHERE id=$1`, [id]);
  return { ok: true };
}
export async function pendingDealerCount() {
  const r = await one(`SELECT COUNT(*)::int AS n FROM dealer_user WHERE status='pending'`, []).catch(() => null);
  return r ? Number(r.n) : 0;
}
