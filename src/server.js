// Built Trailers — Phase 1 API + static UI
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, dbKind, q, all, one } from './db.js';
import { authMiddleware, requireTier, signToken, checkPassword, hashPassword } from './auth.js';
import { modelRollup, modelsSummary, inventoryValuation, partUnitCost } from './cost.js';
import { STAGES, canSell, trailerTypes, customersWithTypes, allowedTypesFor, ordersFull, consumeInventory } from './orders.js';
import { mrp, poList, createPO, receivePO } from './mrp.js';
import { accountingMode, qboConfigured, ledger, totals, sync, scanInvoice, invoiceList } from './accounting.js';
import * as people from './people.js';
import { forecast, workingCapital, scenario } from './forecast.js';
import * as sms from './sms.js';

function requireSales(req, res, next) {
  if (!canSell(req.user)) return res.status(403).json({ error: 'Order management is controlled by Sales' });
  next();
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

async function audit(req, action, detail) {
  try { await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [req.user?.id || null, action, detail]); } catch {}
}

// ---- health ----
app.get('/api/health', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true, db: dbKind() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ---- auth ----
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = await one('SELECT * FROM app_user WHERE lower(username)=lower($1)', [username || '']);
  if (!u || !checkPassword(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const safe = { id: u.id, name: u.name, username: u.username, title: u.title, role: u.role, manager_id: u.manager_id };
  res.json({ token: signToken(u), user: safe });
});
app.get('/api/auth/me', authMiddleware, (req, res) => res.json({ user: req.user }));

// ---- users (admin) ----
app.get('/api/users', authMiddleware, async (_req, res) => {
  res.json(await all('SELECT id,name,username,title,role,manager_id FROM app_user ORDER BY id', []));
});
app.post('/api/users', authMiddleware, requireTier('admin'), async (req, res) => {
  const { name, title, password } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const tier = (await one('SELECT tier FROM role WHERE name=$1', [title]))?.tier || 'viewer';
  const id = 'u' + Date.now();
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  await q('INSERT INTO app_user(id,name,username,password_hash,title,role,manager_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, name, base, hashPassword(password || 'built2026'), title || null, tier, req.user.id]);
  await audit(req, 'user.create', `${name} (${title})`);
  res.json({ id, username: base });
});
app.patch('/api/users/:id', authMiddleware, requireTier('admin'), async (req, res) => {
  const { title, role, manager_id, password, username } = req.body || {};
  const cur = await one('SELECT * FROM app_user WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  let tier = role;
  if (title) tier = (await one('SELECT tier FROM role WHERE name=$1', [title]))?.tier || cur.role;
  await q('UPDATE app_user SET title=$1, role=$2, manager_id=$3, username=$4 WHERE id=$5',
    [title ?? cur.title, tier ?? cur.role, manager_id ?? cur.manager_id, username ?? cur.username, req.params.id]);
  if (password) await q('UPDATE app_user SET password_hash=$1 WHERE id=$2', [hashPassword(password), req.params.id]);
  await audit(req, 'user.update', req.params.id);
  res.json({ ok: true });
});

// ---- parts master ----
app.get('/api/parts', authMiddleware, async (_req, res) => {
  const rows = await all(`SELECT p.*, v.name AS vendor_name, v.lead_days
                            FROM part p LEFT JOIN vendor v ON v.id=p.vendor_id ORDER BY p.type DESC, p.id`, []);
  res.json(rows.map(p => ({
    id: p.id, name: p.name, type: p.type, vendor: p.vendor_name, leadDays: p.lead_days,
    uom: p.uom, spec: p.spec, cost: Number(p.cost), onHand: p.on_hand, reorder: p.reorder,
    cushion: p.cushion, lot: p.lot, extValue: Number(p.cost) * p.on_hand,
    status: p.on_hand < p.reorder ? 'below' : (p.on_hand < p.reorder + p.cushion ? 'low' : 'ok')
  })));
});
app.patch('/api/parts/:id', authMiddleware, requireTier('editor'), async (req, res) => {
  const cur = await one('SELECT * FROM part WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const { cost, reorder, cushion, lot } = req.body || {};
  await q('UPDATE part SET cost=$1, reorder=$2, cushion=$3, lot=$4 WHERE id=$5',
    [cost ?? cur.cost, reorder ?? cur.reorder, cushion ?? cur.cushion, lot ?? cur.lot, req.params.id]);
  if (cost != null && Number(cost) !== Number(cur.cost))
    await audit(req, 'part.cost', `${req.params.id}: ${cur.cost} -> ${cost}`);
  res.json({ ok: true });
});
app.post('/api/parts/:id/receive', authMiddleware, requireTier('editor'), async (req, res) => {
  const qty = Math.round(Number(req.body?.qty) || 0);
  const cur = await one('SELECT * FROM part WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  await q('UPDATE part SET on_hand=on_hand+$1 WHERE id=$2', [qty, req.params.id]);
  await audit(req, 'part.receive', `${req.params.id}: +${qty}`);
  res.json({ ok: true, onHand: cur.on_hand + qty });
});
app.post('/api/parts/:id/adjust', authMiddleware, requireTier('editor'), async (req, res) => {
  const to = Math.round(Number(req.body?.onHand) || 0);
  const cur = await one('SELECT * FROM part WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  await q('UPDATE part SET on_hand=$1 WHERE id=$2', [to, req.params.id]);
  await audit(req, 'part.adjust', `${req.params.id}: ${cur.on_hand} -> ${to} (${req.body?.reason || ''})`);
  res.json({ ok: true });
});

// ---- models / BOMs ----
app.get('/api/models', authMiddleware, async (_req, res) => res.json(await modelsSummary()));
app.get('/api/models/:id', authMiddleware, async (req, res) => {
  const r = await modelRollup(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

// ---- inventory ----
app.get('/api/inventory/summary', authMiddleware, async (_req, res) => res.json(await inventoryValuation()));

// ---- trailer types (Phase 2) ----
app.get('/api/trailer-types', authMiddleware, async (_req, res) => res.json(await trailerTypes()));
app.post('/api/trailer-types', authMiddleware, requireSales, async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  await q('INSERT INTO trailer_type(name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
  await audit(req, 'type.add', name);
  res.json({ ok: true });
});

// ---- customers / dealers (Phase 2) ----
app.get('/api/customers', authMiddleware, async (_req, res) => res.json(await customersWithTypes()));
app.post('/api/customers', authMiddleware, requireSales, async (req, res) => {
  const { name, kind, allowed } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'c' + Date.now();
  await q('INSERT INTO customer(id,name,kind,rep_id) VALUES ($1,$2,$3,$4)', [id, name, kind || 'Dealership', req.user.id]);
  for (const t of (allowed || [])) await q('INSERT INTO customer_allowed_type(customer_id,type) VALUES ($1,$2)', [id, t]);
  await audit(req, 'customer.create', name);
  res.json({ id });
});
app.patch('/api/customers/:id/types', authMiddleware, requireSales, async (req, res) => {
  const { type, on } = req.body || {};
  if (on) await q('INSERT INTO customer_allowed_type(customer_id,type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, type]);
  else await q('DELETE FROM customer_allowed_type WHERE customer_id=$1 AND type=$2', [req.params.id, type]);
  await audit(req, 'customer.types', `${req.params.id} ${on ? '+' : '-'}${type}`);
  res.json({ ok: true });
});

// ---- orders / fulfillment (Phase 2) ----
app.get('/api/orders', authMiddleware, async (_req, res) => res.json({ stages: STAGES, orders: await ordersFull() }));
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  const o = (await ordersFull()).find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  const lines = await all(`SELECT b.part_id, b.qty, p.name, p.on_hand FROM bom_line b JOIN part p ON p.id=b.part_id WHERE b.model_id=$1`, [o.modelId]);
  o.bom = lines.map(l => ({ partId: l.part_id, name: l.name, need: Math.round(Number(l.qty) * o.qty), onHand: l.on_hand, short: l.on_hand < Number(l.qty) * o.qty }));
  res.json(o);
});
app.post('/api/orders', authMiddleware, requireSales, async (req, res) => {
  const { customerId, modelId, qty, due } = req.body || {};
  const cust = await one('SELECT * FROM customer WHERE id=$1', [customerId]);
  const mdl = await one('SELECT * FROM model WHERE id=$1', [modelId]);
  if (!cust || !mdl) return res.status(400).json({ error: 'customer and model required' });
  const allowed = await allowedTypesFor(customerId);
  if (!allowed.includes(mdl.category))
    return res.status(403).json({ error: `${cust.name} is not authorized to order ${mdl.category} trailers` });
  const id = 'SO-' + (1049 + (await all('SELECT id FROM sales_order', [])).length);
  await q('INSERT INTO sales_order(id,customer_id,model_id,qty,stage,due,deposit,channel,rep_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, customerId, modelId, Math.max(1, Number(qty) || 1), 'Quote', due || null, 0, 'Sales', req.user.id]);
  await audit(req, 'order.create', `${id} ${cust.name} ${mdl.category} x${qty}`);
  res.json({ id });
});
app.patch('/api/orders/:id/stage', authMiddleware, requireTier('editor'), async (req, res) => {
  const stage = req.body?.stage;
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'invalid stage' });
  const cur = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  await q('UPDATE sales_order SET stage=$1 WHERE id=$2', [stage, req.params.id]);
  if (stage === 'Ready / Shipped' && !cur.consumed) await consumeInventory(req.params.id, req.user.id);
  await audit(req, 'order.stage', `${req.params.id} -> ${stage}`);
  await sms.notifyOrderStage(req.params.id, stage, req.user.id); // Phase 6: text the customer
  res.json({ ok: true });
});

// ---- MRP / predictive ordering (Phase 3) ----
app.get('/api/mrp', authMiddleware, async (_req, res) => {
  const rows = await mrp();
  res.json({
    rows,
    summary: {
      critical: rows.filter(r => r.sev === 'crit').length,
      warning: rows.filter(r => r.sev === 'warn').length,
      ok: rows.filter(r => r.sev === 'ok').length
    }
  });
});
app.get('/api/po', authMiddleware, async (_req, res) => res.json(await poList()));
app.post('/api/po', authMiddleware, requireTier('editor'), async (req, res) => {
  try {
    const { partId, qty } = req.body || {};
    const id = await createPO(partId, Math.max(1, Math.round(Number(qty) || 0)), req.user.id);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/po/:id/receive', authMiddleware, requireTier('editor'), async (req, res) => {
  const ok = await receivePO(req.params.id, req.user.id);
  res.json({ ok });
});
app.post('/api/mrp/auto', authMiddleware, requireTier('editor'), async (req, res) => {
  const rows = (await mrp()).filter(r => r.sev !== 'ok' && r.type === 'P');
  const created = [];
  for (const r of rows) created.push(await createPO(r.id, r.suggestQty, req.user.id));
  res.json({ created: created.length, ids: created });
});

// ---- accounting / QuickBooks (Phase 4) ----
app.get('/api/accounting', authMiddleware, async (_req, res) => {
  res.json({ mode: accountingMode(), configured: qboConfigured(), totals: await totals(), events: await ledger() });
});
app.post('/api/accounting/sync', authMiddleware, requireTier('editor'), async (req, res) => {
  const r = await sync(); await audit(req, 'acct.sync', JSON.stringify(r)); res.json(r);
});
app.get('/api/invoices', authMiddleware, async (_req, res) => res.json(await invoiceList()));
app.post('/api/invoices/scan', authMiddleware, requireTier('editor'), async (req, res) => {
  const r = await scanInvoice(req.body?.vendorId || req.body?.vendor, req.user.id);
  await audit(req, 'invoice.scan', `${r.id} ${r.vendor} $${Math.round(r.total)} (${r.lines.length} lines)`);
  res.json(r);
});

// ---- people: employees & payroll (Phase 5) ----
app.get('/api/employees', authMiddleware, async (_req, res) => res.json(await people.employees()));
app.get('/api/payroll/summary', authMiddleware, async (_req, res) => res.json(await people.payrollSummary()));
app.patch('/api/employees/:id/schedule', authMiddleware, requireTier('editor'), async (req, res) => {
  await people.setSchedule(req.params.id, req.body?.schedule || {}, req.user); res.json({ ok: true });
});

// ---- time off ----
app.get('/api/timeoff', authMiddleware, async (_req, res) => res.json(await people.timeOffList()));
app.post('/api/timeoff', authMiddleware, requireTier('editor'), async (req, res) => {
  const id = await people.submitTimeOff(req.body || {}, req.user); res.json({ id });
});
app.post('/api/timeoff/:id/approve', authMiddleware, async (req, res) => {
  if (!await people.canApproveTO(req.user, req.params.id)) return res.status(403).json({ error: 'Only the direct manager (or admin) can approve' });
  await people.approveTimeOff(req.params.id, req.user); res.json({ ok: true });
});
app.post('/api/timeoff/:id/deny', authMiddleware, async (req, res) => {
  if (!await people.canApproveTO(req.user, req.params.id)) return res.status(403).json({ error: 'Only the direct manager (or admin) can deny' });
  await people.denyTimeOff(req.params.id, req.user); res.json({ ok: true });
});
app.post('/api/timeoff/:id/process', authMiddleware, async (req, res) => {
  if (!people.canProcessTO(req.user)) return res.status(403).json({ error: 'Office Manager (or admin) processes payroll' });
  const ok = await people.processTimeOff(req.params.id, req.user); res.json({ ok });
});

// ---- outcomes & self-goals ----
app.get('/api/outcomes/:uid', authMiddleware, async (req, res) => res.json(await people.outcomeFor(req.params.uid) || {}));
app.patch('/api/users/:id/outcomes', authMiddleware, async (req, res) => {
  const u = await one('SELECT manager_id FROM app_user WHERE id=$1', [req.params.id]);
  if (!(req.user.role === 'admin' || (u && u.manager_id === req.user.id)))
    return res.status(403).json({ error: 'Only the direct manager (or admin) sets outcomes' });
  await people.setOutcome(req.params.id, req.body || {}, req.user); res.json({ ok: true });
});
app.get('/api/selfgoals', authMiddleware, async (req, res) => res.json(await people.selfGoals(req.user.id)));
app.post('/api/selfgoals', authMiddleware, async (req, res) => {
  if (!req.body?.text) return res.status(400).json({ error: 'text required' });
  res.json({ id: await people.addSelfGoal(req.user.id, req.body.text, req.body.horizon) });
});
app.post('/api/selfgoals/:id/toggle', authMiddleware, async (req, res) => { await people.toggleSelfGoal(req.user.id, req.params.id); res.json({ ok: true }); });
app.delete('/api/selfgoals/:id', authMiddleware, async (req, res) => { await people.deleteSelfGoal(req.user.id, req.params.id); res.json({ ok: true }); });

// ---- recognition / wins ----
app.get('/api/wins', authMiddleware, async (_req, res) => res.json({ wins: await people.wins(), departments: await people.departments(), workstations: await people.workstationsList() }));
app.post('/api/wins', authMiddleware, async (req, res) => {
  if (req.user.title === 'External Viewer') return res.status(403).json({ error: 'External viewers cannot post' });
  if (!req.body?.title) return res.status(400).json({ error: 'title required' });
  res.json({ id: await people.postWin(req.body, req.user) });
});
app.post('/api/wins/:id/react', authMiddleware, async (req, res) => {
  if (req.user.title === 'External Viewer') return res.status(403).json({ error: 'External viewers cannot react' });
  await people.reactWin(req.params.id, req.body?.emoji, req.user.id); res.json({ ok: true });
});

// ---- forecasting & planning (Phase 6) ----
app.get('/api/forecast', authMiddleware, async (req, res) => res.json(await forecast(Number(req.query.horizon) || 90)));
app.get('/api/workingcapital', authMiddleware, async (req, res) => res.json(await workingCapital(Number(req.query.horizon) || 30)));
app.post('/api/scenario', authMiddleware, async (req, res) => res.json(await scenario(req.body || {})));

// ---- notifications / SMS (Phase 6) ----
app.get('/api/notifications', authMiddleware, async (_req, res) => res.json({ mode: sms.smsMode(), configured: sms.twilioConfigured(), items: await sms.notifications() }));
app.post('/api/notifications/send', authMiddleware, requireTier('editor'), async (req, res) => {
  const r = await sms.send(req.body || {}, req.user.id); await audit(req, 'sms.send', JSON.stringify(req.body?.kind || 'manual')); res.json(r);
});

// ---- audit ----
app.get('/api/audit', authMiddleware, requireTier('admin'), async (_req, res) =>
  res.json(await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100', [])));

// ---- static UI ----
app.use(express.static(path.join(__dir, '..', 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dir, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
const kind = await initDb();
// auto-create schema on boot if empty (handy for first deploy)
try {
  const has = await one("SELECT to_regclass('public.part') AS t", []).catch(() => null);
  if (!has || !has.t) console.log('Note: run `npm run init-db` to create schema + seed.');
} catch {}
app.listen(PORT, () => console.log(`Built Trailers Phase 1 API on :${PORT} (db: ${kind})`));
