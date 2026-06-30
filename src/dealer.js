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

// Resolve the dealer's display name + linked dealer record + role.
async function context(d) {
  let dealership = d.dealership_name;
  if (d.customer_id) { const c = await one('SELECT name FROM customer WHERE id=$1', [d.customer_id]); if (c) dealership = c.name; }
  return { name: d.name, email: d.email, dealership, customerId: d.customer_id, role: d.role || 'admin' };
}
export const me = context;

// Role gate for /api/dealer/* endpoints. Dealership admins always pass.
//   admin → everything · sales → orders+invoices · service → claims+maintenance · warranty → registrations+claims
export function dealerRole(...allowed) {
  return (req, res, next) => {
    const r = req.dealer?.role || 'admin';
    if (r === 'admin' || allowed.includes(r)) return next();
    return res.status(403).json({ error: "Your role doesn't have access to this. Ask your dealership admin." });
  };
}

// Register a trailer the dealer sold — selling dealership auto-fills from the account.
export async function registerTrailer(d, data) {
  const ctx = await context(d);
  // A linked dealer may only register their own units.
  if (d.customer_id) {
    const t = await one('SELECT customer_id FROM trailer WHERE upper(vin)=upper($1)', [String(data?.vin || '').trim()]);
    if (t && t.customer_id && t.customer_id !== d.customer_id) throw new Error('That VIN belongs to a different dealership.');
  }
  return submitRegistration({ ...data, sellingDealer: ctx.dealership, source: 'dealer', dealerCustomerId: d.customer_id });
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

// ---- orders ----
// Models this dealership is authorized to order (by trailer type).
export async function orderableModels(d) {
  if (!d.customer_id) return [];
  const allowed = (await all('SELECT type FROM customer_allowed_type WHERE customer_id=$1', [d.customer_id])).map(a => a.type);
  const models = await all('SELECT id,name,category,price FROM model ORDER BY category, id', []);
  return models.filter(m => allowed.includes(m.category)).map(m => ({ id: m.id, name: m.name, category: m.category, price: Number(m.price || 0) }));
}
export async function placeOrder(d, { modelId, qty, due }) {
  if (!d.customer_id) throw new Error('Your account is not linked to a dealer record yet — contact Built Trailers.');
  const mdl = await one('SELECT * FROM model WHERE id=$1', [modelId]);
  if (!mdl) throw new Error('Please choose a trailer model.');
  const allowed = (await all('SELECT type FROM customer_allowed_type WHERE customer_id=$1', [d.customer_id])).map(a => a.type);
  if (!allowed.includes(mdl.category)) throw new Error(`Your dealership isn't authorized to order ${mdl.category} trailers.`);
  const id = 'SO-' + (1049 + (await all('SELECT id FROM sales_order', [])).length);
  const seq = await one('SELECT COALESCE(MAX(production_seq),0)+1 AS n FROM sales_order', []);
  const cust = await one('SELECT rep_id FROM customer WHERE id=$1', [d.customer_id]);
  // Dealer orders enter as Quote = pending Built Trailers sales approval.
  await q(`INSERT INTO sales_order(id,customer_id,model_id,qty,stage,due,deposit,channel,rep_id,production_seq)
           VALUES($1,$2,$3,$4,'Quote',$5,0,'Dealer Portal',$6,$7)`,
    [id, d.customer_id, modelId, Math.max(1, Number(qty) || 1), due || null, cust?.rep_id || null, seq?.n || 1]);
  return { id, status: 'Pending approval' };
}
export async function myOrders(d) {
  if (!d.customer_id) return [];
  const rows = await all(`SELECT o.id, o.qty, o.stage, o.due, o.created_at, m.id AS model_id, m.name AS model, m.category AS type, m.price,
                                 (SELECT COUNT(*) FROM trailer t WHERE t.order_id=o.id AND t.vin IS NOT NULL) AS vins,
                                 (SELECT 1 FROM order_build ob WHERE ob.order_id=o.id) AS is_boat
                            FROM sales_order o LEFT JOIN model m ON m.id=o.model_id
                           WHERE o.customer_id=$1 ORDER BY o.created_at DESC, o.id DESC`, [d.customer_id]);
  // A dealer can edit/withdraw their own order only while it's still a Quote (before we confirm it).
  return rows.map(o => ({ id: o.id, model: o.model, modelId: o.model_id, type: o.type, qty: o.qty, stage: o.stage, due: o.due,
    createdAt: o.created_at, price: Number(o.price || 0), revenue: Number(o.price || 0) * o.qty, vinsAssigned: Number(o.vins),
    boat: !!o.is_boat, editable: o.stage === 'Quote' }));
}

// ---- invoices & team ----
export async function myInvoices(d) {
  if (!d.customer_id) return { invoices: [], owed: 0, paid: 0 };
  const rows = await all(`SELECT id, status, total, invoiced_at, paid_at FROM invoice_batch
                           WHERE customer_id=$1 AND status<>'Draft' ORDER BY invoiced_at DESC NULLS LAST, id DESC`, [d.customer_id]);
  let owed = 0, paid = 0;
  const invoices = rows.map(b => {
    const t = Number(b.total) || 0;
    if (b.status === 'Paid') paid += t; else if (b.status === 'Invoiced') owed += t;
    return { id: b.id, status: b.status, total: t, invoicedAt: b.invoiced_at, paidAt: b.paid_at };
  });
  return { invoices, owed, paid };
}
// All login accounts under this dealership + colleagues awaiting the admin's approval.
export async function team(d) {
  if (!d.customer_id) return { members: [], pending: [] };
  const members = (await all(`SELECT id,name,email,status,role,created_at FROM dealer_user WHERE customer_id=$1 ORDER BY created_at`, [d.customer_id]))
    .map(u => ({ id: u.id, name: u.name, email: u.email, status: u.status, role: u.role || 'admin', createdAt: u.created_at, self: u.id === d.id }));
  // Colleagues who signed up with this dealership's name but aren't linked yet
  const pending = (await all(`SELECT id,name,email,created_at FROM dealer_user
                               WHERE status='pending' AND customer_id IS NULL AND lower(dealership_name)=lower($1) ORDER BY created_at`, [d.dealership_name || '']))
    .map(u => ({ id: u.id, name: u.name, email: u.email, createdAt: u.created_at }));
  return { members, pending };
}
const DEALER_ROLES = ['admin', 'sales', 'service', 'warranty'];
// Dealership admin approves a colleague's signup onto their dealership with a role.
export async function approveTeamMember(admin, memberId, role) {
  if (!admin.customer_id) throw new Error('Your account is not linked to a dealership.');
  const m = await one(`SELECT * FROM dealer_user WHERE id=$1`, [memberId]);
  if (!m || m.status !== 'pending' || m.customer_id) throw new Error('That sign-up is not available to approve.');
  if (String(m.dealership_name || '').toLowerCase() !== String(admin.dealership_name || '').toLowerCase()) throw new Error('That sign-up is for a different dealership.');
  const r = DEALER_ROLES.includes(role) ? role : 'sales';
  await q(`UPDATE dealer_user SET status='active', customer_id=$1, role=$2 WHERE id=$3`, [admin.customer_id, r, memberId]);
  return { ok: true };
}
export async function rejectTeamMember(admin, memberId) {
  const m = await one(`SELECT * FROM dealer_user WHERE id=$1`, [memberId]);
  if (m && m.status === 'pending' && String(m.dealership_name || '').toLowerCase() === String(admin.dealership_name || '').toLowerCase())
    await q(`UPDATE dealer_user SET status='rejected' WHERE id=$1`, [memberId]);
  return { ok: true };
}
// Admin changes a teammate's role or deactivates them (can't change self).
export async function setTeamRole(admin, memberId, role) {
  if (!admin.customer_id) throw new Error('Your account is not linked to a dealership.');
  if (memberId === admin.id) throw new Error('You can\'t change your own role.');
  const r = DEALER_ROLES.includes(role) ? role : null;
  if (!r && role !== 'inactive') throw new Error('Invalid role.');
  if (role === 'inactive') await q(`UPDATE dealer_user SET status='rejected' WHERE id=$1 AND customer_id=$2`, [memberId, admin.customer_id]);
  else await q(`UPDATE dealer_user SET role=$1, status='active' WHERE id=$2 AND customer_id=$3`, [r, memberId, admin.customer_id]);
  return { ok: true };
}

// ---- staff side ----
export async function pendingDealers() {
  return (await all(`SELECT id,email,name,dealership_name,created_at FROM dealer_user WHERE status='pending' ORDER BY created_at DESC`, []))
    .map(d => ({ id: d.id, email: d.email, name: d.name, dealershipName: d.dealership_name, createdAt: d.created_at }));
}
export async function approveDealer(id, customerId, role) {
  if (!await one('SELECT id FROM dealer_user WHERE id=$1', [id])) throw new Error('account not found');
  // First active user at a dealership becomes its admin; otherwise use the chosen role.
  let r = role && DEALER_ROLES.includes(role) ? role : null;
  if (!r) {
    const existing = customerId ? await one(`SELECT 1 AS x FROM dealer_user WHERE customer_id=$1 AND status='active' LIMIT 1`, [customerId]) : null;
    r = existing ? 'sales' : 'admin';
  }
  await q(`UPDATE dealer_user SET status='active', customer_id=$1, role=$2 WHERE id=$3`, [customerId || null, r, id]);
  return { ok: true, role: r };
}
export async function rejectDealer(id) {
  await q(`UPDATE dealer_user SET status='rejected' WHERE id=$1`, [id]);
  return { ok: true };
}
export async function pendingDealerCount() {
  const r = await one(`SELECT COUNT(*)::int AS n FROM dealer_user WHERE status='pending'`, []).catch(() => null);
  return r ? Number(r.n) : 0;
}
