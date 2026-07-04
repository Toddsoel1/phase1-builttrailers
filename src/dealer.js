// Dealership accounts for dealership.builttrailers.app. Separate from staff
// (app_user) auth: dealers sign up, stay 'pending' until Built Trailers staff
// approve and link them to their dealer (customer) record, then log in to
// register the trailers they sold (their dealership auto-fills) and track claims.
// Dealer tokens carry kind:'dealer' and are rejected by the staff authMiddleware.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { all, one, q } from './db.js';
import { hashPassword, checkPassword, JWT_SECRET } from './auth.js';
import { submitRegistration } from './portal.js';
import { sendDealerPasswordReset, sendDealerApproved } from './email.js';

const DEFAULT_PORTAL = process.env.DEALER_PORTAL_URL || 'https://dealership.builttrailers.app';

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

export async function signup({ email, password, name, dealershipName, address, city, state, zip }) {
  if (!email || !password || !name || !dealershipName) throw new Error('Name, dealership, email, and password are all required.');
  if (!address || !city || !state || !zip) throw new Error('Your dealership address — street, city, state, and ZIP — is required.');
  if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
  if (await one('SELECT id FROM dealer_user WHERE lower(email)=lower($1)', [email])) throw new Error('An account with that email already exists.');
  const id = 'DLR-' + Date.now().toString(36);
  const st = String(state).toUpperCase().slice(0, 2);
  await q(`INSERT INTO dealer_user(id,email,password_hash,name,dealership_name,status,address,city,state,zip) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)`,
    [id, email, hashPassword(password), name, dealershipName, address, city, st, zip]);
  return { ok: true, status: 'pending' };
}

export async function login({ email, password }) {
  const d = await one('SELECT * FROM dealer_user WHERE lower(email)=lower($1)', [email || '']);
  if (!d || !checkPassword(password || '', d.password_hash)) throw new Error('Invalid email or password.');
  if (d.status === 'pending') throw new Error('Your account is still pending approval by Built Trailers.');
  if (d.status === 'rejected') throw new Error('This account was not approved. Please contact Built Trailers.');
  return { token: signDealerToken(d), dealer: await context(d) };
}

// Self-service password reset. Always resolves ok so the response never reveals whether an
// account exists for that email (mirrors owner.js requestReset/resetPassword exactly).
export async function requestReset(email, baseUrl) {
  const d = await one('SELECT * FROM dealer_user WHERE lower(email)=lower($1)', [email || '']);
  if (d) {
    const token = crypto.randomBytes(32).toString('hex');
    await q("UPDATE dealer_user SET reset_token=$1, reset_expires=now() + interval '1 hour' WHERE id=$2", [token, d.id]);
    const url = `${baseUrl || DEFAULT_PORTAL}/dealer?token=${token}`;
    try { await sendDealerPasswordReset({ email: d.email, name: d.name, resetUrl: url }); } catch { /* email layer logs */ }
  }
  return { ok: true };
}

export async function resetPassword(token, newPassword) {
  if (!token || !newPassword) throw new Error('A reset token and new password are required.');
  if (String(newPassword).length < 6) throw new Error('Password must be at least 6 characters.');
  const d = await one('SELECT * FROM dealer_user WHERE reset_token=$1 AND reset_expires > now()', [token]);
  if (!d) throw new Error('This reset link is invalid or has expired. Please request a new one.');
  await q('UPDATE dealer_user SET password_hash=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2', [hashPassword(newPassword), d.id]);
  return { ok: true };
}

export async function changePassword(d, currentPassword, newPassword) {
  if (!checkPassword(currentPassword || '', d.password_hash)) throw new Error('Current password is incorrect.');
  if (String(newPassword || '').length < 6) throw new Error('New password must be at least 6 characters.');
  await q('UPDATE dealer_user SET password_hash=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2', [hashPassword(newPassword), d.id]);
  return { ok: true };
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

// ---- stock: unsold stock builds this dealership is authorized to claim ----
// "Available now" = finished (Ready); everything earlier is "in production — coming soon".
export async function stockList(d) {
  if (!d.customer_id) return { available: [], coming: [] };
  const allowed = (await all('SELECT type FROM customer_allowed_type WHERE customer_id=$1', [d.customer_id])).map(a => a.type);
  const rows = await all(`
    SELECT o.id, o.qty, o.stage, o.due, m.name AS model, m.category AS type, m.price,
           (SELECT string_agg(t.vin, ', ') FROM trailer t WHERE t.order_id=o.id AND t.vin IS NOT NULL) AS vin_list,
           (SELECT COUNT(*) FROM stock_request sr WHERE sr.order_id=o.id AND sr.status='pending' AND sr.customer_id=$1) AS mine
      FROM sales_order o JOIN model m ON m.id=o.model_id
     WHERE o.channel='Stock' AND o.customer_id IS NULL AND o.billed=false AND o.stage <> 'Cancelled'
     ORDER BY o.due NULLS LAST, o.id`, [d.customer_id]);
  const mapped = rows.filter(r => allowed.includes(r.type)).map(r => ({
    id: r.id, model: r.model, type: r.type, qty: r.qty, stage: r.stage, due: r.due,
    price: Number(r.price || 0), vins: r.vin_list || '', requested: Number(r.mine) > 0 }));
  return { available: mapped.filter(x => x.stage === 'Ready'), coming: mapped.filter(x => x.stage !== 'Ready') };
}
export async function requestStock(d, orderId, note) {
  if (!d.customer_id) throw new Error('Your account is not linked to a dealer record yet — contact Built Trailers.');
  const o = await one(`SELECT o.*, m.category FROM sales_order o JOIN model m ON m.id=o.model_id WHERE o.id=$1`, [orderId]);
  if (!o || o.channel !== 'Stock' || o.customer_id || o.billed || o.stage === 'Cancelled')
    throw new Error('That stock trailer is no longer available.');
  const allowed = (await all('SELECT type FROM customer_allowed_type WHERE customer_id=$1', [d.customer_id])).map(a => a.type);
  if (!allowed.includes(o.category)) throw new Error(`Your dealership isn't authorized to carry ${o.category} trailers.`);
  if (await one(`SELECT id FROM stock_request WHERE order_id=$1 AND customer_id=$2 AND status='pending'`, [orderId, d.customer_id]))
    throw new Error('You already have a pending request for this trailer — Built Trailers is reviewing it.');
  await q(`INSERT INTO stock_request(order_id, dealer_user_id, customer_id, note) VALUES($1,$2,$3,$4)`,
    [orderId, d.id, d.customer_id, String(note || '').slice(0, 300) || null]);
  return { ok: true };
}
// Staff side: every pending request, oldest first (first come, first served).
export async function stockRequests() {
  return (await all(`SELECT sr.id, sr.order_id, sr.note, sr.created_at, c.id AS customer_id, c.name AS dealership,
                            du.name AS requested_by, m.name AS model, o.qty, o.stage
                       FROM stock_request sr
                       JOIN customer c ON c.id = sr.customer_id
                       LEFT JOIN dealer_user du ON du.id = sr.dealer_user_id
                       JOIN sales_order o ON o.id = sr.order_id
                       JOIN model m ON m.id = o.model_id
                      WHERE sr.status='pending' ORDER BY sr.created_at`, []).catch(() => []))
    .map(r => ({ id: r.id, orderId: r.order_id, customerId: r.customer_id, dealership: r.dealership,
      requestedBy: r.requested_by, model: r.model, qty: r.qty, stage: r.stage, note: r.note, at: r.created_at }));
}
export async function pendingStockRequestCount() {
  const r = await one(`SELECT COUNT(*)::int AS n FROM stock_request WHERE status='pending'`, []).catch(() => null);
  return r ? Number(r.n) : 0;
}

// The dealer-facing production tracker: the stage ladder with real completion dates.
// A stage counts done if it's stamped in order_stage_done OR it sits behind the current stage
// (orders that predate stage stamping still render sensibly).
const TRACK_STAGES = ['Confirmed', 'Scheduled', 'Build', 'Paint/Powder Coat', 'Finish', 'Ready'];
export async function orderProgress(d, orderId) {
  const o = await one(`SELECT o.*, m.name AS model FROM sales_order o LEFT JOIN model m ON m.id=o.model_id
                        WHERE o.id=$1 AND o.customer_id=$2`, [orderId, d.customer_id]);
  if (!o) return null;
  const done = await all(`SELECT stage, completed_at FROM order_stage_done WHERE order_id=$1`, [orderId]).catch(() => []);
  const at = Object.fromEntries(done.map(r => [r.stage, r.completed_at]));
  // order_stage_done stamps the stage that was LEFT, so the newest stamp = when the order
  // arrived where it is now. Ready is terminal: being there IS done (the trailer is finished).
  const entered = done.reduce((m, r) => (!m || new Date(r.completed_at) > new Date(m) ? r.completed_at : m), null);
  const curIdx = TRACK_STAGES.indexOf(o.stage);
  const vins = (await all(`SELECT vin FROM trailer WHERE order_id=$1 AND vin IS NOT NULL ORDER BY vin`, [orderId])).map(r => r.vin);
  return {
    id: o.id, model: o.model, qty: o.qty, stage: o.stage, due: o.due, vins,
    steps: TRACK_STAGES.map((s, i) => {
      const isCur = s === o.stage;
      return { stage: s, current: isCur,
        done: !!at[s] || (curIdx >= 0 && i < curIdx) || (isCur && s === 'Ready'),
        at: at[s] || (isCur && s === 'Ready' ? entered : null) };
    }),
  };
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
  sendDealerApproved({ email: m.email, name: m.name, dealershipName: admin.dealership_name }).catch(e => console.warn('approval email:', e.message));
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
  const du = await one('SELECT * FROM dealer_user WHERE id=$1', [id]);
  if (!du) throw new Error('account not found');
  // First active user at a dealership becomes its admin; otherwise use the chosen role.
  let r = role && DEALER_ROLES.includes(role) ? role : null;
  if (!r) {
    const existing = customerId ? await one(`SELECT 1 AS x FROM dealer_user WHERE customer_id=$1 AND status='active' LIMIT 1`, [customerId]) : null;
    r = existing ? 'sales' : 'admin';
  }
  await q(`UPDATE dealer_user SET status='active', customer_id=$1, role=$2 WHERE id=$3`, [customerId || null, r, id]);
  // Tell them — until this email existed, approved dealers had to log in on a hunch.
  sendDealerApproved({ email: du.email, name: du.name, dealershipName: du.dealership_name }).catch(e => console.warn('approval email:', e.message));
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
// All dealer_user logins tied to a dealership (customer) record, for staff (Customers & Dealers
// screen) — the dealer's own team() is self-service and requires a dealer session; this is the
// staff-side equivalent so Built Trailers can see + help with accounts without one.
export async function accountsForCustomer(customerId) {
  return (await all(`SELECT id,name,email,status,role,created_at FROM dealer_user WHERE customer_id=$1 ORDER BY created_at`, [customerId]))
    .map(u => ({ id: u.id, name: u.name, email: u.email, status: u.status, role: u.role || 'admin', createdAt: u.created_at }));
}
// Staff-assisted password reset (a dealer forgot their password and can't/didn't use email
// self-service) — sets a new password directly, mirroring the admin path for staff (app_user).
export async function adminResetPassword(dealerId, newPassword) {
  if (String(newPassword || '').length < 6) throw new Error('Password must be at least 6 characters.');
  if (!await one('SELECT id FROM dealer_user WHERE id=$1', [dealerId])) throw new Error('Account not found.');
  await q('UPDATE dealer_user SET password_hash=$1, reset_token=NULL, reset_expires=NULL WHERE id=$2', [hashPassword(newPassword), dealerId]);
  return { ok: true };
}
