// Smoke tests for the critical paths: login, order → production → invoice, inventory
// valuation, parts, roles, and the QuickBooks cost preview. Boots the REAL server against a
// throwaway PGlite database (no external services), so a regression on any of these shows up
// in seconds. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_PORT || 4599);
const BASE = `http://localhost:${PORT}`;
// Hermetic env: simulated accounting, no SMS, no QuickBooks creds — tests never touch a
// real external service regardless of what's in .env.
const HERMETIC = { PORT: String(PORT), ACCOUNTING_MODE: 'simulated', SMS_ENABLED: '0',
  QBO_CLIENT_ID: '', QBO_CLIENT_SECRET: '', JWT_SECRET: 'test-secret-smoke',
  LOGIN_RATE_MAX: '100000', PORTAL_RATE_MAX: '100000', DEALER_FEED_TOKEN: 'test-feed-token', GEOCODE_DISABLED: '1', NHTSA_DISABLED: '1', IDEAS_VOTE_OPEN: '1',
  BACKUP_DIR: path.join(tmpdir(), 'bt-smoke-backups'), TIME_SURVEY_MIN_ITEMS: '3' };

let server, dbDir, token, orderId, modelId;

function runNode(args, extraEnv) {
  return new Promise((res, rej) => {
    const p = spawn('node', args, { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('exit', c => c === 0 ? res() : rej(new Error(`node ${args.join(' ')} exited ${c}`)));
  });
}
async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}
const api = (p, opt = {}) => fetch(BASE + p, { ...opt, headers: {
  'Content-Type': 'application/json', Accept: 'application/json',
  ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opt.headers || {}) } });
const json = r => r.json();

before(async () => {
  dbDir = mkdtempSync(path.join(tmpdir(), 'bt-smoke-'));
  // Seed the demo catalog into the test DB (seed.js calls process.exit, so it must be a child).
  await runNode(['db/seed.js'], { ...HERMETIC, SEED_DEMO: '1', PGLITE_DIR: dbDir });
  server = spawn('node', ['src/server.js'], { env: { ...process.env, ...HERMETIC, PGLITE_DIR: dbDir }, stdio: ['ignore', 'ignore', 'inherit'] });
  await waitHealth();
});
after(() => {
  try { server?.kill('SIGKILL'); } catch {}
  try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
  try { rmSync(HERMETIC.BACKUP_DIR, { recursive: true, force: true }); } catch {}
});

test('health endpoint reports DB status + uptime', async () => {
  const r = await api('/api/health');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.ok(d.db, 'reports db kind');
  assert.equal(typeof d.uptime, 'number');
  assert.ok(r.headers.get('x-request-id'), 'request id header set');
});

test('client-error endpoint accepts a front-end crash report', async () => {
  const r = await api('/api/client-error', { method: 'POST', body: JSON.stringify({ kind: 'error', message: 'smoke client error', url: 'http://x/test' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('login succeeds and rejects a bad password', async () => {
  const ok = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'tsoelberg', password: 'built2026' }) });
  assert.equal(ok.status, 200);
  token = (await ok.json()).token;
  assert.ok(token, 'a token is returned');
  const bad = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'tsoelberg', password: 'nope' }) });
  assert.equal(bad.status, 401, 'wrong password rejected');
});

test('create a sales order against an authorized customer + model', async () => {
  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cust, model;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category)); if (m) { cust = c; model = m; break; } }
  assert.ok(cust && model, 'found an authorized customer + model pairing');
  modelId = model.id;
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId, qty: 1, due: '2026-12-01' }) });
  assert.equal(r.status, 200);
  orderId = (await r.json()).id;
  assert.match(orderId, /^SO-/, 'order id assigned');
});

test('daily update completes a stage: consumes materials and advances the order', async () => {
  const r = await api('/api/work-log', { method: 'POST', body: JSON.stringify({ orderId, workstation: 'Weld', stage: 'Build', hours: 4, stageComplete: true }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.advanced, 'Paint/Powder Coat', 'order advanced past Build');
  assert.ok(d.consumed?.consumed, 'Build stage consumed');
  const wip = (await json(await api('/api/wip'))).find(o => o.id === orderId);
  assert.ok(wip && wip.wip > 0, 'order shows a WIP value');
  assert.ok(wip.doneStages.includes('Build'), 'Build recorded as done');
});

test('invoice consumes remaining stages, bills once, and blocks a re-invoice', async () => {
  await api(`/api/orders/${orderId}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'Ready' }) });
  assert.equal((await api(`/api/orders/${orderId}/invoice`, { method: 'POST' })).status, 200, 'first invoice succeeds');
  assert.equal((await api(`/api/orders/${orderId}/invoice`, { method: 'POST' })).status, 400, 're-invoice rejected');
  const stillWip = (await json(await api('/api/wip'))).find(o => o.id === orderId);
  assert.ok(!stillWip, 'invoiced order left WIP');
});

test('invoicing relieves COGS to the ledger for single orders AND batches', async () => {
  // The single-order invoice from the test above left a cogs event (its Build stage consumed
  // real material, so WIP > 0) — this is what pushes to QBO as Dr COGS / Cr Inventory.
  const acct = await json(await api('/api/accounting'));
  const single = acct.events.find(e => e.kind === 'cogs' && e.ref === orderId);
  assert.ok(single, 'single-order invoice posted a cogs event');
  assert.ok(single.amount > 0, 'cogs carries the consumed WIP value');

  // Batch path: two orders, batched, posted — each order gets consumed + its own cogs relief.
  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cust, model;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category)); if (m) { cust = c; model = m; break; } }
  const o1 = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  const o2 = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  const batch = await json(await api('/api/invoice-batches', { method: 'POST', body: JSON.stringify({ customerId: cust.id, orderIds: [o1.id, o2.id] }) }));
  assert.equal((await api('/api/invoice-batches/' + batch.id + '/post', { method: 'POST' })).status, 200, 'batch posts');
  const after = await json(await api('/api/accounting'));
  for (const oid of [o1.id, o2.id]) {
    const ev = after.events.find(e => e.kind === 'cogs' && e.ref === oid);
    assert.ok(ev, `batch order ${oid} relieved COGS`);
    assert.ok(ev.amount > 0, `batch order ${oid} cogs carries the consumed value`);
  }
  assert.ok(after.events.find(e => e.kind === 'invoice' && e.ref === batch.id), 'one combined invoice for the batch');
});

test('counts: opening baseline sets on-hand with NO books posting; a regular count posts', async () => {
  const p = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Count Test Widget', cost: 10 }) }));
  await api('/api/parts/' + p.id + '/adjust', { method: 'POST', body: JSON.stringify({ onHand: 5, reason: 'count test seed' }) });

  // Opening (clean-start) count: 5 -> 12. On-hand applies; the books see nothing.
  const cc = await json(await api('/api/cycle-counts', { method: 'POST', body: JSON.stringify({ lines: [{ partId: p.id, countedQty: 12 }], note: 'baseline', opening: true }) }));
  assert.ok((await json(await api('/api/cycle-counts?status=pending'))).find(c => c.id === cc.id && c.opening === true), 'opening flag rides the listing');
  const ap = await json(await api('/api/cycle-counts/' + cc.id + '/approve', { method: 'POST' }));
  assert.equal(ap.qb, 'baseline', 'opening count does not post an adjustment');
  assert.equal((await json(await api('/api/parts'))).find(x => x.id === p.id).onHand, 12, 'baseline on-hand applied');
  assert.ok(!(await json(await api('/api/accounting'))).events.find(e => e.kind === 'inventory-adjust' && e.ref === 'CC-' + cc.id),
    'no inventory-adjust ledger event for a baseline');

  // Regular cycle count: 12 -> 9 posts a -$30 variance to the ledger (QBO journal in live mode).
  const cc2 = await json(await api('/api/cycle-counts', { method: 'POST', body: JSON.stringify({ lines: [{ partId: p.id, countedQty: 9 }], note: 'weekly count' }) }));
  const ap2 = await json(await api('/api/cycle-counts/' + cc2.id + '/approve', { method: 'POST' }));
  assert.equal(ap2.netValue, -30);
  assert.ok((await json(await api('/api/accounting'))).events.find(e => e.kind === 'inventory-adjust' && e.ref === 'CC-' + cc2.id),
    'regular count variance hits the ledger');
  await api('/api/parts/' + p.id + '/adjust', { method: 'POST', body: JSON.stringify({ onHand: 0, reason: 'count test cleanup' }) });
});

test('multi-vendor buys: a PO can go to an alternate vendor; the primary stays for MRP timing', async () => {
  const vendors = (await json(await api('/api/vendors'))).filter(v => v.status !== 'pending' && v.status !== 'rejected');
  assert.ok(vendors.length >= 2, 'two usable vendors available');
  const [primary, alt] = vendors;
  const part = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Dual Source Bracket', cost: 8 }) }));
  await api('/api/parts/' + part.id, { method: 'PATCH', body: JSON.stringify({ vendorId: primary.id }) });

  const po = await json(await api('/api/po', { method: 'POST', body: JSON.stringify({ partId: part.id, qty: 2, vendorId: alt.id }) }));
  const row = (await json(await api('/api/po'))).find(x => x.id === po.id);
  assert.equal(row.vendorId, alt.id, 'the PO belongs to the vendor actually used');
  assert.equal((await json(await api('/api/parts'))).find(x => x.id === part.id).vendorId, primary.id, 'primary vendor unchanged');
  assert.equal((await api('/api/po', { method: 'POST', body: JSON.stringify({ partId: part.id, qty: 1, vendorId: 'nope' }) })).status, 400, 'unknown alternate vendor rejected');
});

test('landed-cost receiving: extras allocate by value, parts land at weighted cost, the bill equals the invoice', async () => {
  const vendors = (await json(await api('/api/vendors'))).filter(v => v.status !== 'pending' && v.status !== 'rejected');
  const vendor = vendors[0];
  // Two parts with the vendor as primary; B starts with stock so the weighted average is proven.
  const A = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Landed A', cost: 10 }) }));
  const B = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Landed B', cost: 30 }) }));
  await api('/api/parts/' + A.id, { method: 'PATCH', body: JSON.stringify({ vendorId: vendor.id }) });
  await api('/api/parts/' + B.id, { method: 'PATCH', body: JSON.stringify({ vendorId: vendor.id }) });
  await api('/api/parts/' + B.id + '/adjust', { method: 'POST', body: JSON.stringify({ onHand: 10, reason: 'landed test pre-stock' }) });

  const poA = await json(await api('/api/po', { method: 'POST', body: JSON.stringify({ partId: A.id, qty: 4 }) })); // 4 × $10 = $40
  const poB = await json(await api('/api/po', { method: 'POST', body: JSON.stringify({ partId: B.id, qty: 2 }) })); // 2 × $30 = $60
  // Invoice: parts $100 + shipping $20 + tax $5 = $125.
  // Value shares: A 40% → $10 → landed (40+10)/4 = $12.50; B 60% → $15 → landed (60+15)/2 = $37.50.
  // Weighted costs: A → 12.50 (no prior stock); B → (10×30 + 2×37.50)/12 = 31.25.
  const r = await json(await api('/api/vendor-invoices/receive', { method: 'POST', body: JSON.stringify({
    vendorId: vendor.id, invoiceNo: 'INV-7788', poIds: [poA.id, poB.id], shipping: 20, tax: 5 }) }));
  assert.equal(r.total, 125, 'bottom line = parts + shipping + tax');
  assert.equal(r.extras, 25);
  const parts = await json(await api('/api/parts'));
  const a = parts.find(p => p.id === A.id), b = parts.find(p => p.id === B.id);
  assert.equal(a.onHand, 4);
  assert.equal(a.cost, 12.5, 'A carries its fully landed unit cost');
  assert.equal(b.onHand, 12);
  assert.equal(b.cost, 31.25, 'B is a weighted average of old stock and the landed receipt');
  const rows = await json(await api('/api/po'));
  assert.equal(rows.find(p => p.id === poA.id).status, 'Received');
  assert.equal(rows.find(p => p.id === poB.id).status, 'Received');
  const bill = (await json(await api('/api/accounting'))).events.find(e => e.kind === 'bill' && e.ref === 'INV-7788');
  assert.ok(bill, 'ONE bill carrying the vendor invoice number');
  assert.equal(bill.amount, 125, 'the bill equals the invoice bottom line, to the penny');
  assert.equal((await api('/api/vendor-invoices/receive', { method: 'POST', body: JSON.stringify({ vendorId: vendor.id, poIds: [poA.id] }) })).status, 400, 'already-received PO refused');
  for (const id of [A.id, B.id]) await api('/api/parts/' + id + '/adjust', { method: 'POST', body: JSON.stringify({ onHand: 0, reason: 'landed test cleanup' }) });
});

test('effective dating: price changes hit FUTURE orders only — history, invoices, batches never move', async () => {
  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cust, model;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category)); if (m) { cust = c; model = m; break; } }
  const before = Number(model.price);

  const oldO = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  // A plain editor title cannot reprice the catalog; Sales/admin can — future orders only.
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Price Probe', tier: 'editor', sections: ['orders'] }) });
  const pu = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Price Probe P', titles: ['Price Probe'], password: 'pricePw1' }) }));
  const pl = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: pu.username, password: 'pricePw1' }) }));
  assert.equal((await fetch(BASE + '/api/models/' + encodeURIComponent(model.id) + '/price', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pl.token }, body: JSON.stringify({ price: 1 }) })).status, 403, 'repricing is sales/admin only');
  assert.equal((await api('/api/models/' + encodeURIComponent(model.id) + '/price', { method: 'PATCH', body: JSON.stringify({ price: before + 777 }) })).status, 200);

  const frozen = await json(await api('/api/orders/' + oldO.id));
  assert.equal(frozen.price, before, 'the existing order keeps its frozen price');
  assert.equal(frozen.revenue, before, 'historical revenue does not move');
  const newO = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  assert.equal((await json(await api('/api/orders/' + newO.id))).price, before + 777, 'a NEW order gets the new price');

  // Invoicing the old order bills the frozen amount, even though the catalog moved.
  await api('/api/orders/' + oldO.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Ready' }) });
  assert.equal((await api('/api/orders/' + oldO.id + '/invoice', { method: 'POST' })).status, 200);
  const ev = (await json(await api('/api/accounting'))).events.find(e => e.kind === 'invoice' && e.ref === oldO.id);
  assert.equal(ev.amount, before, 'the invoice posts the frozen price');

  // Batches freeze the same way: reprice AGAIN, the batched order still bills at ITS price.
  const batch = await json(await api('/api/invoice-batches', { method: 'POST', body: JSON.stringify({ customerId: cust.id, orderIds: [newO.id] }) }));
  assert.equal((await api('/api/models/' + encodeURIComponent(model.id) + '/price', { method: 'PATCH', body: JSON.stringify({ price: before + 1500 }) })).status, 200);
  assert.equal((await json(await api('/api/invoice-batches/' + batch.id))).total, before + 777, 'batch total uses each order\'s own frozen price');

  await api('/api/models/' + encodeURIComponent(model.id) + '/price', { method: 'PATCH', body: JSON.stringify({ price: before }) }); // restore for downstream tests
});

test('inventory valuation exposes the raw / make / WIP / finished buckets', async () => {
  const v = await json(await api('/api/inventory/summary'));
  for (const k of ['rawPurchased', 'makeParts', 'wipValue', 'finishedValue', 'totalValue'])
    assert.equal(typeof v[k], 'number', `bucket ${k} present`);
});

test('batched modelsSummary matches per-model modelRollup (N+1 refactor correctness)', async () => {
  const list = await json(await api('/api/models'));
  assert.ok(list.length, 'models present');
  for (const m of list.slice(0, 6)) {
    const one = await json(await api('/api/models/' + encodeURIComponent(m.id)));
    assert.equal(Math.round(m.material * 100), Math.round(one.material * 100), `material ${m.id}`);
    assert.equal(Math.round(m.laborCost * 100), Math.round(one.laborCost * 100), `labor ${m.id}`);
    assert.equal(Math.round(m.totalCost * 100), Math.round(one.totalCost * 100), `total ${m.id}`);
    assert.equal(m.bom.length, one.bom.length, `bom line count ${m.id}`);
  }
});

test('create an app-only Make part', async () => {
  const r = await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Smoke Test Bracket', cost: 12.5, uom: 'ea' }) });
  assert.equal(r.status, 200);
  const id = (await r.json()).id;
  const p = (await json(await api('/api/parts'))).find(x => x.id === id);
  assert.ok(p && p.type === 'M', 'Make part created with type M');
});

test('sell parts over the counter: stock down, invoice + COGS posted, oversell needs confirmation', async () => {
  // A dedicated part so the sale never disturbs the MRP/replenishment assertions elsewhere.
  const made = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Sale Test Fender', cost: 40 }) }));
  await api('/api/parts/' + made.id + '/adjust', { method: 'POST', body: JSON.stringify({ onHand: 10, reason: 'stock for sale test' }) });

  assert.equal((await api('/api/parts/sell', { method: 'POST', body: JSON.stringify({ customerName: 'X', lines: [] }) })).status, 400, 'empty sale refused');
  assert.equal((await api('/api/parts/sell', { method: 'POST', body: JSON.stringify({ lines: [{ partId: made.id, qty: 1, unitPrice: 60 }] }) })).status, 400, 'needs a customer or walk-in name');

  const sale = await json(await api('/api/parts/sell', { method: 'POST', body: JSON.stringify({ customerName: 'Walk-in Wally', lines: [{ partId: made.id, qty: 2, unitPrice: 60 }], note: 'smoke sale' }) }));
  assert.match(sale.ref, /^PS-\d+$/);
  assert.equal(sale.total, 120);
  assert.equal(sale.costTotal, 80, 'cost side captured from the part');
  assert.equal(sale.margin, 40);
  const after = (await json(await api('/api/parts'))).find(p => p.id === made.id);
  assert.equal(after.onHand, 8, 'stock deducted');
  const acct = await json(await api('/api/accounting'));
  assert.ok(acct.events.find(e => e.kind === 'invoice' && e.ref === sale.ref), 'invoice posted for the sale');
  assert.ok(acct.events.find(e => e.kind === 'cogs' && e.ref === sale.ref && e.amount === 80), 'COGS relieved at part cost');

  // Overselling requires the explicit confirmation flag; stock then goes honestly negative.
  const over = await api('/api/parts/sell', { method: 'POST', body: JSON.stringify({ customerName: 'Wally', lines: [{ partId: made.id, qty: 12, unitPrice: 50 }] }) });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /sell anyway/i, 'oversell explains itself');
  assert.equal((await api('/api/parts/sell', { method: 'POST', body: JSON.stringify({ customerName: 'Wally', lines: [{ partId: made.id, qty: 12, unitPrice: 50 }], allowNegative: true }) })).status, 200, 'confirmed oversell allowed');
  assert.equal((await json(await api('/api/parts'))).find(p => p.id === made.id).onHand, -4, 'stock goes negative until receiving/count corrects it');

  const reg = await json(await api('/api/parts/sales'));
  assert.ok(reg.markup >= 1, 'suggested-price markup exposed');
  const row = reg.sales.find(s => s.ref === sale.ref);
  assert.ok(row && row.party === 'Walk-in Wally' && /Sale Test Fender|2×/.test(row.items + ''), 'sale in the register');

  await api('/api/parts/' + made.id + '/adjust', { method: 'POST', body: JSON.stringify({ onHand: 0, reason: 'sale test cleanup' }) });
});

test('assign a vendor to a part — validated, reflected on GET, and unassignable', async () => {
  const v = await json(await api('/api/vendors', { method: 'POST', body: JSON.stringify({ name: 'Part Vendor Test Co', leadDays: 3 }) }));
  const part = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Smoke Vendor-Assign Bracket', cost: 4.5 }) }));
  const patch = await api('/api/parts/' + part.id, { method: 'PATCH', body: JSON.stringify({ vendorId: v.id }) });
  assert.equal(patch.status, 200);
  const p = (await json(await api('/api/parts'))).find(x => x.id === part.id);
  assert.equal(p.vendorId, v.id, 'vendorId reflected');
  assert.equal(p.vendor, 'Part Vendor Test Co', 'vendor name joined');
  assert.equal(p.vendorStatus, 'pending', 'new vendor requires approval per seeded rules');

  const bad = await api('/api/parts/' + part.id, { method: 'PATCH', body: JSON.stringify({ vendorId: 'nope-does-not-exist' }) });
  assert.equal(bad.status, 400, 'unknown vendor id rejected');

  await api('/api/parts/' + part.id, { method: 'PATCH', body: JSON.stringify({ vendorId: null }) });
  const p2 = (await json(await api('/api/parts'))).find(x => x.id === part.id);
  assert.equal(p2.vendorId, null, 'unassigned');
});

test('vendor approval: two-step chain, then active + safe QBO push (no-op without QBO creds)', async () => {
  const create = await api('/api/vendors', { method: 'POST', body: JSON.stringify({ name: 'Smoke Test Vendor Co', leadDays: 5, terms: 'Net 30' }) });
  assert.equal(create.status, 200);
  const { id: vendorId, status } = await create.json();
  assert.equal(status, 'pending', 'new vendor requires approval per seeded rules');

  const users = await json(await api('/api/users'));
  const u3 = users.find(u => u.id === 'u3'), u1 = users.find(u => u.id === 'u1');
  const loginAs = async username => json(await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'built2026' }) }));
  const hdrs = tok => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok });
  const asU3 = hdrs((await loginAs(u3.username)).token), asU1 = hdrs((await loginAs(u1.username)).token);

  // Step 1: Office Manager (seq 1) approves — still pending afterward (seq 2 remains)
  const req1 = (await json(await fetch(BASE + '/api/approvals/pending', { headers: asU3 }))).find(r => r.ref_id === vendorId);
  assert.ok(req1, 'seq-1 approver has the request');
  const dec1 = await json(await fetch(BASE + '/api/approvals/' + req1.token + '/decide', { method: 'POST', headers: asU3, body: JSON.stringify({ decision: 'approved' }) }));
  assert.equal(dec1.outcome, 'approved_next_seq');
  assert.equal((await json(await api('/api/vendors'))).find(v => v.id === vendorId).status, 'pending', 'still pending after step 1');

  // Step 2: GM (seq 2) approves — fully approved -> active. The QBO push is best-effort and
  // mode-gated (accountingMode() is 'simulated' with no QBO creds in HERMETIC), so it must not
  // throw or block the decision; qbo_id stays null since nothing was actually pushed.
  const req2 = (await json(await fetch(BASE + '/api/approvals/pending', { headers: asU1 }))).find(r => r.ref_id === vendorId);
  assert.ok(req2, 'seq-2 approver has the request');
  const dec2 = await json(await fetch(BASE + '/api/approvals/' + req2.token + '/decide', { method: 'POST', headers: asU1, body: JSON.stringify({ decision: 'approved' }) }));
  assert.equal(dec2.outcome, 'fully_approved');
  const finalVendor = (await json(await api('/api/vendors'))).find(v => v.id === vendorId);
  assert.equal(finalVendor.status, 'active', 'active after full approval');
  assert.equal(finalVendor.qbo_id, null, 'no QBO push attempted in simulated mode');
});

test('qbo pull: vendors requires QuickBooks configured', async () => {
  const r = await api('/api/qbo/pull', { method: 'POST', body: JSON.stringify({ what: ['vendors'] }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not configured/i);
});

test('role access sections can be saved (regression: the onclick Save bug)', async () => {
  assert.ok((await json(await api('/api/roles'))).some(r => r.name === 'Sales'), 'Sales role exists');
  const sections = ['orders', 'parts'];
  const r = await api('/api/roles/' + encodeURIComponent('Sales'), { method: 'PATCH', body: JSON.stringify({ sections }) });
  assert.equal(r.status, 200);
  const after = (await json(await api('/api/roles'))).find(r => r.name === 'Sales');
  assert.deepEqual(after.sections.sort(), sections.sort(), 'sections persisted');
});

test('QuickBooks trailer-cost preview computes cost from the BOM', async () => {
  const r = await api('/api/accounting/trailer-costs');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.rows) && d.rows.length, 'preview rows present');
  assert.ok(d.rows.every(x => typeof x.appCost === 'number'), 'each row has an app cost from the BOM');
});

// ---- Owner account portal ----
let ownerToken;
const oapi = (p, opt = {}) => fetch(BASE + p, { ...opt, headers: {
  'Content-Type': 'application/json', Accept: 'application/json',
  ...(ownerToken ? { Authorization: 'Bearer ' + ownerToken } : {}), ...(opt.headers || {}) } });

test('owner: register creates an account (email = username) and auto-logs-in', async () => {
  const r = await oapi('/api/owner/register', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'ownerpass1', name: 'Olive Owner' }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  ownerToken = d.token;
  assert.ok(ownerToken, 'token issued');
  assert.equal(d.owner.email, 'owner@example.com');
  assert.equal(d.owner.trailerCount, 0);
});

test('owner: duplicate email is rejected', async () => {
  const r = await oapi('/api/owner/register', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'another1x', name: 'Dup' }) });
  assert.equal(r.status, 400);
});

test('owner: registering a trailer requires a phone number', async () => {
  const r = await oapi('/api/owner/register', { method: 'POST', body: JSON.stringify({
    email: 'phonevalidation@x.test', password: 'ownerpass1', name: 'No Phone',
    vin: 'BLTNOPHONE0000001', ownerName: 'No Phone', saleDate: '2026-06-01',
    warrantyAddress: '1 Main St', city: 'Provo', state: 'UT', zip: '84601' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /phone/i);
});

test('owner: registering a trailer requires a full address (street, city, state, zip)', async () => {
  const base = { email: 'addrvalidation@x.test', password: 'ownerpass1', name: 'No Addr',
    vin: 'BLTNOADDR0000001', ownerName: 'No Addr', saleDate: '2026-06-01', phone: '555-123-4567' };
  for (const missing of ['warrantyAddress', 'city', 'state', 'zip']) {
    const body = { ...base, warrantyAddress: '1 Main St', city: 'Provo', state: 'UT', zip: '84601' };
    delete body[missing];
    const r = await oapi('/api/owner/register', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 400, `missing ${missing} rejected`);
    assert.match((await r.json()).error, /address/i);
  }
});

test('owner: account-only registration (no vin) does not require phone/address', async () => {
  const r = await oapi('/api/owner/register', { method: 'POST', body: JSON.stringify({ email: 'noviown@x.test', password: 'ownerpass1', name: 'No VIN Owner' }) });
  assert.equal(r.status, 200, 'account-only call has nothing to register, so nothing to require');
});

test('owner: login works and rejects a bad password', async () => {
  const ok = await oapi('/api/owner/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'ownerpass1' }) });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
  const bad = await oapi('/api/owner/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'wrong' }) });
  assert.equal(bad.status, 401);
});

test('owner: /me requires an owner token (rejects none + staff token)', async () => {
  const meR = await oapi('/api/owner/me');
  assert.equal(meR.status, 200);
  assert.equal((await meR.json()).email, 'owner@example.com');
  assert.equal((await fetch(BASE + '/api/owner/me')).status, 401, 'no token rejected');
  assert.equal((await fetch(BASE + '/api/owner/me', { headers: { Authorization: 'Bearer ' + token } })).status, 403, 'staff token rejected');
});

test('owner: forgot-password always returns ok (no account enumeration)', async () => {
  const known = await oapi('/api/owner/forgot', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com' }) });
  const unknown = await oapi('/api/owner/forgot', { method: 'POST', body: JSON.stringify({ email: 'nobody@nowhere.test' }) });
  assert.equal(known.status, 200); assert.equal(unknown.status, 200);
  assert.equal((await known.json()).ok, true); assert.equal((await unknown.json()).ok, true);
});

test('owner: reset with an invalid token is rejected', async () => {
  const r = await oapi('/api/owner/reset', { method: 'POST', body: JSON.stringify({ token: 'bogus-token', password: 'newpass12' }) });
  assert.equal(r.status, 400);
});

test('owner: cannot file a claim for a VIN not registered to the account', async () => {
  const r = await oapi('/api/owner/claims', { method: 'POST', body: JSON.stringify({ vin: 'NOTMYVIN123456789', issue: 'test issue' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not registered to your account/i);
});

// ---- VIN / MSO print workflow ----
let vinUnitId, vinJobId;
test('VIN: Build auto-assigns a VIN, Paint queues the VIN print, Paint-complete queues the MSO', async () => {
  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cu, mo;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category)); if (m) { cu = c; mo = m; break; } }
  const oid = (await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cu.id, modelId: mo.id, qty: 1, due: '2026-12-20' }) }))).id;
  // enter Build → VIN auto-assigned; enter Paint → VIN print queues
  await api(`/api/orders/${oid}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'Build' }) });
  await api(`/api/orders/${oid}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'Paint/Powder Coat' }) });
  const vinQ = await json(await api('/api/print-queue?kind=vin'));
  const job = vinQ.find(j => j.orderId === oid);
  assert.ok(job, 'a VIN print job is queued for the order');
  assert.equal(String(job.vin).length, 17, 'unit has a 17-char VIN (auto-assigned at Build)');
  assert.match(job.vin, /^BLT/, 'VIN uses the BUILT WMI');
  vinUnitId = job.unitId; vinJobId = job.jobId;
  // complete Paint → MSO queues
  await api(`/api/orders/${oid}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'Finish' }) });
  const msoQ = await json(await api('/api/print-queue?kind=mso'));
  assert.ok(msoQ.some(j => j.unitId === vinUnitId), 'an MSO print job is queued once Paint is complete');
});

test('VIN: marking a print job done removes it from the queue', async () => {
  assert.equal((await api(`/api/print-queue/${vinJobId}/printed`, { method: 'POST' })).status, 200);
  const vinQ = await json(await api('/api/print-queue?kind=vin'));
  assert.ok(!vinQ.some(j => j.jobId === vinJobId), 'printed job left the queue');
});

test('VIN: correction changes the VIN but keeps the same unit (build history stays)', async () => {
  const r = await api(`/api/trailers/${vinUnitId}/vin`, { method: 'POST', body: JSON.stringify({ vin: 'BLTTESTVIN0000099' }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.unitId, vinUnitId, 'same physical unit');
  assert.equal(d.newVin, 'BLTTESTVIN0000099');
  assert.ok(d.oldVin && d.oldVin !== d.newVin, 'old VIN recorded');
  assert.equal((await api(`/api/trailers/${vinUnitId}/vin`, { method: 'POST', body: JSON.stringify({ vin: 'TOOSHORT' }) })).status, 400, 'invalid VIN rejected');
});

test('VIN: print center + correction are restricted to OM/GM/Admin', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token; // Angela Ruiz — Sales (editor), not an office authority
  const h = { headers: { Authorization: 'Bearer ' + sales } };
  assert.equal((await fetch(BASE + '/api/print-queue', h)).status, 403, 'sales cannot open the print center');
  assert.equal((await fetch(BASE + `/api/trailers/${vinUnitId}/vin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: JSON.stringify({ vin: 'BLTHACKVIN0000001' }) })).status, 403, 'sales cannot change a VIN');
});

test("users section grant: a non-admin title with 'users' manages accounts but can never mint or touch an admin", async () => {
  // The owner's real scenario: an editor-tier Office Manager granted the 'users' section checkbox.
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'User Desk', tier: 'editor', sections: ['users', 'dashboard'] }) });
  const made = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Uma Desk', titles: ['User Desk'], password: 'deskPw123' }) }));
  const dl = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: made.username, password: 'deskPw123' }) }));
  assert.ok(dl.token, 'section-granted manager can log in');
  assert.ok((dl.user.sections || []).includes('users'), 'login payload carries the users section');
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dl.token };
  const desk = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: H });

  // Day-to-day works: list users, create a normal (non-admin) user, edit their email.
  assert.equal((await desk('/api/users')).status, 200, 'can list users');
  const nu = await (await desk('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Floor Hand', titles: ['Sales'] }) })).json();
  assert.ok(nu.id, 'can create a non-admin user');
  assert.equal((await desk('/api/users/' + nu.id, { method: 'PATCH', body: JSON.stringify({ email: 'floor@builttrailers.app' }) })).status, 200, 'can edit a non-admin user');

  // Escalation is impossible: no admin-tier titles, no touching admins, no self-edit, no role management.
  const gm = (await json(await api('/api/users'))).find(u => u.role === 'admin');
  assert.equal((await desk('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Sneaky', titles: ['General Manager'] }) })).status, 403, 'cannot create an admin-tier user');
  assert.equal((await desk('/api/users/' + nu.id, { method: 'PATCH', body: JSON.stringify({ titles: ['General Manager'] }) })).status, 403, 'cannot promote to an admin-tier title');
  assert.equal((await desk('/api/users/' + nu.id, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) })).status, 403, 'cannot set the raw admin role');
  assert.equal((await desk('/api/users/' + gm.id, { method: 'PATCH', body: JSON.stringify({ email: 'x@x.test' }) })).status, 403, 'cannot edit an admin account');
  assert.equal((await desk('/api/users/' + gm.id, { method: 'DELETE' })).status, 403, 'cannot remove an admin');
  assert.equal((await desk('/api/users/' + made.id, { method: 'PATCH', body: JSON.stringify({ titles: ['General Manager'] }) })).status, 403, 'cannot edit their own record here');
  assert.equal((await desk('/api/roles/Sales', { method: 'PATCH', body: JSON.stringify({ tier: 'admin' }) })).status, 403, 'role/tier management stays admin-only');
  const still = (await json(await api('/api/users'))).find(u => u.id === nu.id);
  assert.equal(still.role, 'editor', 'target user was never escalated');

  // A title WITHOUT the users section (Sales) still gets nothing.
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: JSON.stringify({ name: 'Nope', titles: ['Sales'] }) })).status, 403, 'no users grant -> still locked out');
});

test('section grants unlock print center, boat admin, and order entry — the matrix checkboxes work everywhere', async () => {
  for (const [name, tier, sections] of [
    ['Print Desk', 'editor', ['printcenter']], ['Boat Desk', 'editor', ['boatadmin']],
    ['Order Desk', 'editor', ['neworder', 'orders']], ['Read Desk', 'viewer', ['printcenter']],
  ]) await api('/api/roles', { method: 'POST', body: JSON.stringify({ name, tier, sections }) });
  const mk = async title => {
    const u = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: title + ' Person', titles: [title], password: 'deskPw123' }) }));
    const l = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'deskPw123' }) }));
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token };
  };
  const printH = await mk('Print Desk'), boatH = await mk('Boat Desk'), orderH = await mk('Order Desk'), readH = await mk('Read Desk');

  assert.equal((await fetch(BASE + '/api/print-queue', { headers: printH })).status, 200, 'printcenter grant opens the print center');
  assert.equal((await fetch(BASE + '/api/print-specs', { headers: printH })).status, 200, 'printcenter grant covers specs too');
  assert.equal((await fetch(BASE + '/api/boat-admin/catalog', { headers: boatH })).status, 200, 'boatadmin grant opens boat settings');
  assert.equal((await fetch(BASE + '/api/print-queue', { headers: boatH })).status, 403, 'grants do not bleed across sections');
  assert.equal((await fetch(BASE + '/api/boat-admin/catalog', { headers: printH })).status, 403, 'grants do not bleed the other way either');
  assert.equal((await fetch(BASE + '/api/print-queue', { headers: readH })).status, 403, 'a viewer-tier title cannot use a mutation-capable grant');

  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cust, model;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category)); if (m) { cust = c; model = m; break; } }
  const sold = await fetch(BASE + '/api/orders', { method: 'POST', headers: orderH, body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1, due: '2026-12-20' }) });
  assert.equal(sold.status, 200, 'neworder grant lets an editor-tier title create orders');
  assert.equal((await fetch(BASE + '/api/orders', { method: 'POST', headers: printH, body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) })).status, 403, 'no neworder grant -> still cannot sell');
});

test('bill-to vs ship-to: MSO + invoices bill the parent entity; the BOL ships to the lot with its window', async () => {
  // Only Accounting / Sales / GM (or admin) may set billing — an ordinary editor title cannot.
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Yard Hand', tier: 'editor', sections: ['orders'] }) });
  const yh = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Yard Hand Person', titles: ['Yard Hand'], password: 'yardPw123' }) }));
  const yl = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: yh.username, password: 'yardPw123' }) }));
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Ship Lot Powersports', kind: 'Dealership', allowed: ['Utility'] }) }));
  await api('/api/customers/' + cust.id, { method: 'PATCH', body: JSON.stringify({ address: '500 Lake Rd', city: 'Provo', state: 'UT', zip: '84601' }) });
  assert.equal((await fetch(BASE + '/api/customers/' + cust.id + '/billing', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + yl.token }, body: '{}' })).status, 403, 'a plain editor title cannot set billing');
  assert.equal((await api('/api/customers/' + cust.id + '/billing', { method: 'PATCH', body: JSON.stringify({
    billName: 'Ship Lot Holdings LLC', billAddress: '1 Corporate Way', billCity: 'Salt Lake City', billState: 'ut', billZip: '84101',
    deliveryDays: [2, 4], deliveryStart: '07:30', deliveryEnd: '15:00', deliveryNote: 'call ahead 30 min' }) })).status, 200);
  const c2 = (await json(await api('/api/customers'))).find(c => c.id === cust.id);
  assert.equal(c2.billName, 'Ship Lot Holdings LLC');
  assert.equal(c2.billState, 'UT', 'state uppercased');
  assert.deepEqual(c2.deliveryWindow.days, [2, 4]);
  assert.equal(c2.deliveryWindow.note, 'call ahead 30 min');

  // Build an order so a unit exists, then check every document picks the right entity.
  const o = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: 'UT7X16T', qty: 1 }) }));
  await api('/api/orders/' + o.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Build' }) });
  const unit = (await json(await api('/api/trailers'))).registry.find(t => t.orderId === o.id);
  const pd = await json(await api('/api/trailers/' + unit.id + '/print-data'));
  assert.equal(pd.billTo.name, 'Ship Lot Holdings LLC', 'MSO Sold-to = billing entity');
  assert.equal(pd.dealer.name, 'Ship Lot Holdings LLC', 'print layout key carries the bill-to');
  assert.equal(pd.shipTo.name, 'Ship Lot Powersports', 'ship-to stays the lot');

  const bol = await json(await api('/api/orders/' + o.id + '/bol'));
  assert.match(bol.shipper.name, /Built Manufacturing/);
  assert.equal(bol.shipTo.name, 'Ship Lot Powersports');
  assert.equal(bol.shipTo.address, '500 Lake Rd');
  assert.equal(bol.billTo.name, 'Ship Lot Holdings LLC');
  assert.deepEqual(bol.deliveryWindow.days, [2, 4], 'BOL carries the receiving window');
  assert.equal(bol.units.length, 1);
  assert.ok(bol.units[0].vin, 'BOL lists the VIN');

  // Invoice bills the parent: pass QC, move to Ready, invoice, check the ledger party.
  await api('/api/trailers/' + unit.id + '/qc', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
  await api('/api/orders/' + o.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Ready' }) });
  assert.equal((await api('/api/orders/' + o.id + '/invoice', { method: 'POST' })).status, 200);
  const ev = (await json(await api('/api/accounting'))).events.find(e => e.kind === 'invoice' && e.ref === o.id);
  assert.equal(ev.party, 'Ship Lot Holdings LLC', 'the invoice bills the parent company');

  // A stock order has no destination — the BOL refuses.
  const stock = await json(await api('/api/orders/stock', { method: 'POST', body: JSON.stringify({ modelId: 'UT7X16T', qty: 1 }) }));
  const noBol = await api('/api/orders/' + stock.id + '/bol');
  assert.equal(noBol.status, 400);
  assert.match((await noBol.json()).error, /destination/i);
});

test('parts capabilities: add/receive vs full edit; renaming a part number carries its history', async () => {
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Parts Adder', tier: 'editor', sections: ['parts', 'parts_add'] }) });
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Parts Editor', tier: 'editor', sections: ['parts', 'parts_edit'] }) });
  const mk = async title => {
    const u = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: title + ' Person', titles: [title], password: 'partsPw1' }) }));
    const l = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'partsPw1' }) }));
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token };
  };
  const addH = await mk('Parts Adder'), edH = await mk('Parts Editor');

  // The lighter grant: create + receive, but no editing and no on-hand overrides.
  const np = await (await fetch(BASE + '/api/parts', { method: 'POST', headers: addH, body: JSON.stringify({ name: 'Cap Test Widget', cost: 5, vendorPartNo: 'ACME-77' }) })).json();
  assert.ok(np.id, 'parts_add can create a part');
  assert.equal((await json(await api('/api/parts'))).find(p => p.id === np.id).vendorPartNo, 'ACME-77', 'vendor part # stored at creation');
  assert.equal((await fetch(BASE + '/api/parts/' + np.id + '/receive', { method: 'POST', headers: addH, body: JSON.stringify({ qty: 3 }) })).status, 200, 'parts_add can receive stock');
  assert.equal((await fetch(BASE + '/api/parts/' + np.id, { method: 'PATCH', headers: addH, body: JSON.stringify({ cost: 9 }) })).status, 403, 'parts_add cannot edit a part');
  assert.equal((await fetch(BASE + '/api/parts/' + np.id + '/adjust', { method: 'POST', headers: addH, body: JSON.stringify({ onHand: 0 }) })).status, 403, 'parts_add cannot set on-hand');

  // The restricted grant: every field, including the vendor part number and the part number itself.
  assert.equal((await fetch(BASE + '/api/parts/' + np.id, { method: 'PATCH', headers: edH, body: JSON.stringify({ cost: 9, vendorPartNo: 'ACME-99', name: 'Cap Test Widget v2' }) })).status, 200, 'parts_edit edits fields');
  const vendor = (await json(await api('/api/vendors'))).find(v => v.status !== 'pending' && v.status !== 'rejected');
  assert.equal((await fetch(BASE + '/api/parts/' + np.id, { method: 'PATCH', headers: edH, body: JSON.stringify({ vendorId: vendor.id }) })).status, 200, 'parts_edit assigns the primary vendor');
  const po = await json(await api('/api/po', { method: 'POST', body: JSON.stringify({ partId: np.id, qty: 2 }) }));

  const rn = await (await fetch(BASE + '/api/parts/' + np.id, { method: 'PATCH', headers: edH, body: JSON.stringify({ newId: 'CAP-RENAMED-1' }) })).json();
  assert.equal(rn.renamed, true);
  assert.equal(rn.id, 'CAP-RENAMED-1');
  const parts2 = await json(await api('/api/parts'));
  assert.ok(!parts2.find(p => p.id === np.id), 'old part number is gone');
  const renamed = parts2.find(p => p.id === 'CAP-RENAMED-1');
  assert.ok(renamed && renamed.onHand === 3 && renamed.cost === 9 && renamed.vendorPartNo === 'ACME-99', 'stock, cost, and vendor part # followed the rename');
  const poRow = (await json(await api('/api/po'))).find(x => x.id === po.id);
  assert.equal(poRow.partId, 'CAP-RENAMED-1', 'the open PO followed the rename');
  assert.equal(poRow.vendorPartNo, 'ACME-99', 'PO list carries the vendor part number');
  const clashTarget = parts2.find(p => p.id !== 'CAP-RENAMED-1').id;
  assert.equal((await fetch(BASE + '/api/parts/CAP-RENAMED-1', { method: 'PATCH', headers: edH, body: JSON.stringify({ newId: clashTarget }) })).status, 400, 'renaming onto an existing number refused');
  await api('/api/parts/CAP-RENAMED-1/adjust', { method: 'POST', body: JSON.stringify({ onHand: 0, reason: 'cap test cleanup' }) });
});

test('job titles: rename carries assignments, access, and the legacy title text', async () => {
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Old Title Name', tier: 'editor', sections: ['orders', 'standup'] }) });
  const u = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Rename Holder', titles: ['Old Title Name'] }) }));
  assert.equal((await api('/api/roles/' + encodeURIComponent('Old Title Name') + '/rename', { method: 'PATCH', body: JSON.stringify({ newName: 'New Title Name' }) })).status, 200);
  const roles = await json(await api('/api/roles'));
  assert.ok(!roles.find(r => r.name === 'Old Title Name'), 'old name gone');
  const nr = roles.find(r => r.name === 'New Title Name');
  assert.ok(nr && nr.sections.includes('orders') && nr.sections.includes('standup'), 'access followed the rename');
  const user = (await json(await api('/api/users'))).find(x => x.id === u.id);
  assert.ok(user.titles.includes('New Title Name'), 'the user now holds the renamed title');
  assert.equal(user.title, 'New Title Name', 'legacy primary-title text updated');
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Clash Title', tier: 'viewer', sections: [] }) });
  assert.equal((await api('/api/roles/' + encodeURIComponent('New Title Name') + '/rename', { method: 'PATCH', body: JSON.stringify({ newName: 'Clash Title' }) })).status, 400, 'renaming onto an existing title refused');
});

test('shop manager dashboard: labor efficiency, SOP compliance, red flags, and bottlenecks', async () => {
  // Gate: the dashboard is SM/GM/admin — a plain editor title gets nothing.
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Dash Probe', tier: 'editor', sections: ['orders', 'daily'] }) });
  const du = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Dash Probe P', titles: ['Dash Probe'], password: 'dashPw12' }) }));
  const dl = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: du.username, password: 'dashPw12' }) }));
  const probeH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dl.token };
  assert.equal((await fetch(BASE + '/api/shopdash', { headers: probeH })).status, 403, 'dashboard is manager-only');

  // SOP checkpoints: managers define, anyone confirms, once per day.
  const cp1 = await json(await api('/api/sop', { method: 'POST', body: JSON.stringify({ text: 'Torque wrench calibrated' }) }));
  await api('/api/sop', { method: 'POST', body: JSON.stringify({ text: 'Paint booth filters checked', workstation: 'Paint' }) });
  assert.equal((await fetch(BASE + '/api/sop', { method: 'POST', headers: probeH, body: JSON.stringify({ text: 'nope' }) })).status, 403, 'only SM/GM/admin define checkpoints');
  assert.equal((await fetch(BASE + '/api/sop/' + cp1.id + '/confirm', { method: 'POST', headers: probeH, body: '{}' })).status, 200, 'any staff member confirms');
  assert.equal((await api('/api/sop/' + cp1.id + '/confirm', { method: 'POST' })).status, 200, 're-confirming the same day is idempotent');
  const sop = await json(await api('/api/sop'));
  assert.ok(sop.required >= 2 && sop.confirmed >= 1, 'confirmations counted once');
  const cp1Row = sop.items.find(i => i.id === cp1.id);
  assert.equal(cp1Row.confirmed, true);

  // Labor efficiency + red flag: a stage completion earns the model's routed standard hours;
  // 40 actual hours against them puts the worker under the threshold.
  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cust, model;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category) && mm.laborCost > 0); if (m) { cust = c; model = m; break; } }
  const slow = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Slow Sam', titles: ['Dash Probe'] }) }));
  const o = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  assert.equal((await api('/api/work-log', { method: 'POST', body: JSON.stringify({ orderId: o.id, workstation: 'Weld', stage: 'Build', hours: 40, stageComplete: true, userId: slow.id }) })).status, 200);
  const dash = await json(await api('/api/shopdash'));
  assert.ok(dash.laborEff.today.actual >= 40, 'actual hours counted');
  assert.ok(dash.laborEff.today.std > 0, 'stage completion earned standard hours');
  assert.ok(dash.laborEff.byStation.find(s => s.ws === 'Weld'), 'station breakdown present');
  assert.ok(dash.sop.required >= 2 && dash.sop.confirmed >= 1, 'SOP widget rolls up');
  const flagged = dash.redFlags.find(u => u.userId === slow.id);
  assert.ok(flagged && flagged.pct < dash.threshold, 'the slow day shows as a red flag');

  // Bottleneck: cap a stage below its population and the widget names it with a duration.
  const stages = (await json(await api('/api/orders'))).orders.filter(x => !x.billed && x.stage === 'Scheduled');
  if (stages.length < 2) {
    await api('/api/orders/stock', { method: 'POST', body: JSON.stringify({ modelId: model.id, qty: 1 }) });
    await api('/api/orders/stock', { method: 'POST', body: JSON.stringify({ modelId: model.id, qty: 1 }) });
  }
  await api('/api/wip-limits', { method: 'POST', body: JSON.stringify({ Scheduled: 1 }) });
  const dash2 = await json(await api('/api/shopdash'));
  const bn = dash2.bottlenecks.find(b => b.stage === 'Scheduled');
  assert.ok(bn && bn.count > bn.limit, 'over-limit stage surfaces');
  assert.ok(bn.overForHours != null && bn.overForHours >= 0, 'with how long it has been over');
  await api('/api/wip-limits', { method: 'POST', body: JSON.stringify({}) }); // clear for downstream tests
});

test('owner dashboard: GM/admin only — cash, margin, 12-week trends, safety log, inventory turns', async () => {
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Owner Probe', tier: 'editor', sections: ['orders'] }) });
  const pu = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Owner Probe P', titles: ['Owner Probe'], password: 'ownPw123' }) }));
  const pl = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: pu.username, password: 'ownPw123' }) }));
  assert.equal((await fetch(BASE + '/api/ownerdash', { headers: { Authorization: 'Bearer ' + pl.token } })).status, 403, 'owner page is GM/admin only');

  const d = await json(await api('/api/ownerdash'));
  assert.equal(typeof d.cash.net, 'number');
  assert.ok(d.cash.invoiced > 0, 'billed revenue flows from the ledger');
  assert.ok(d.margin.revenue > 0 && d.margin.cogs > 0, 'margin from posted invoices + COGS');
  assert.ok(Array.isArray(d.margin.byModel) && d.margin.byModel.length >= 1, 'by-model margin present');
  assert.equal(d.weeks.length, 12, 'twelve weekly buckets');
  assert.ok(d.weeks.reduce((a, w) => a + w.units, 0) >= 1, 'units reaching Ready counted');
  assert.ok('turns' in d.turns && 'inventoryValue' in d.turns, 'inventory turns computed');
  assert.ok(Array.isArray(d.warranty), 'warranty trend series');

  // Safety: findings stay open until resolved; incidents drive days-since.
  const tenAgo = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
  const f = await json(await api('/api/safety', { method: 'POST', body: JSON.stringify({ kind: 'finding', description: 'Extension cord across walkway' }) }));
  await api('/api/safety', { method: 'POST', body: JSON.stringify({ kind: 'incident', description: 'Minor cut — first aid', occurredOn: tenAgo }) });
  const s = await json(await api('/api/safety'));
  assert.ok(s.openFindings >= 1, 'finding counts as open');
  assert.equal(s.daysSinceIncident, 10, 'days since last incident from the occurrence date');
  assert.equal((await api('/api/safety/' + f.id + '/resolve', { method: 'POST', body: JSON.stringify({ resolution: 'taped and rerouted' }) })).status, 200);
  assert.equal((await api('/api/safety/' + f.id + '/resolve', { method: 'POST', body: '{}' })).status, 400, 'double resolve refused');
  const s2 = await json(await api('/api/safety'));
  assert.equal(s2.openFindings, s.openFindings - 1, 'resolving closes the finding');
});

test('daily scorecard: standard vs actual with the drill-down; self always, managers for anyone', async () => {
  const carl = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Card Carl', titles: ['Owner Probe'], password: 'carlPw12' }) }));
  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cust, model;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category) && mm.laborCost > 0); if (m) { cust = c; model = m; break; } }
  const o = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  await api('/api/work-log', { method: 'POST', body: JSON.stringify({ orderId: o.id, workstation: 'Weld', stage: 'Build', hours: 8, stageComplete: true, userId: carl.id }) });

  const card = await json(await api('/api/scorecard?userId=' + carl.id));
  assert.equal(card.user.id, carl.id);
  assert.ok(card.hoursLogged >= 8, 'hours logged counted');
  assert.ok(card.stdEarned > 0, 'the stage completion earned standard hours');
  assert.equal(card.effPct, Math.round((card.stdEarned / card.hoursLogged) * 100), 'efficiency math checks out');
  const expectFlag = card.effPct >= 100 ? 'green' : card.effPct >= 85 ? 'yellow' : 'red';
  assert.equal(card.flag, expectFlag, 'flag matches the 100/85 thresholds');
  assert.equal(card.trend.length, 7, 'seven-day sparkline');
  assert.equal(card.trend[6].pct, card.effPct, 'today is the last sparkline point');
  assert.ok(card.drill.length >= 1 && card.drill.some(l => l.stageComplete && l.earnedStd > 0), 'the drill-down shows WHICH lines earned the hours');
  assert.ok(Array.isArray(card.trailersTouched) && Array.isArray(card.partsBuilt) && Array.isArray(card.tasksCompleted), 'My Work slices ride along');

  // Carl sees his own card; he cannot open someone else's.
  const cl = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: carl.username, password: 'carlPw12' }) }));
  const own = await json(await fetch(BASE + '/api/scorecard', { headers: { Authorization: 'Bearer ' + cl.token } }));
  assert.equal(own.user.id, carl.id, 'self view works for everyone');
  const gm = (await json(await api('/api/users'))).find(x => x.role === 'admin');
  assert.equal((await fetch(BASE + '/api/scorecard?userId=' + gm.id, { headers: { Authorization: 'Bearer ' + cl.token } })).status, 403, 'peeking at others is manager-only');
});

test('daily ideas: anonymous ranking, daily winner, voting without self-votes, reveal, implementation', async () => {
  await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Idea Probe', tier: 'viewer', sections: ['standup'] }) });
  const mk = async name => {
    const u = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name, titles: ['Idea Probe'], password: 'ideaPw12' }) }));
    const l = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'ideaPw12' }) }));
    return { id: u.id, H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token } };
  };
  const ida = await mk('Ida Ideas'), ivan = await mk('Ivan Voter');

  assert.equal((await fetch(BASE + '/api/ideas', { method: 'POST', headers: ida.H, body: JSON.stringify({ text: 'short' }) })).status, 400, 'one real sentence required');
  const A = await (await fetch(BASE + '/api/ideas', { method: 'POST', headers: ida.H, body: JSON.stringify({ text: 'Pre-kit axle hardware in labeled bins at the Build bay', category: 'Process' }) })).json();
  const B = await (await fetch(BASE + '/api/ideas', { method: 'POST', headers: ivan.H, body: JSON.stringify({ text: 'Add a second grinder station so Finish never waits', category: 'Shop life' }) })).json();
  assert.ok(A.id && B.id);
  assert.equal((await json(await fetch(BASE + '/api/ideas/board', { headers: ida.H }))).mineToday, true, 'daily-idea flag set for the author');

  // Anonymity is structural: the ranking payload carries no author in any form.
  const adminBoard = await json(await api('/api/ideas/board'));
  for (const i of adminBoard.ranking.today) {
    assert.ok(!('author' in i) && !('authorId' in i) && !('author_id' in i), 'ranking never exposes the author');
  }

  // Only the SM/GM/admin ranks; the pick is swappable within the day.
  assert.equal((await fetch(BASE + '/api/ideas/' + A.id + '/daily-winner', { method: 'POST', headers: ivan.H, body: '{}' })).status, 403, 'workers cannot rank');
  await api('/api/ideas/' + B.id + '/daily-winner', { method: 'POST' });
  await api('/api/ideas/' + A.id + '/daily-winner', { method: 'POST' }); // re-pick swaps
  const ranked = (await json(await api('/api/ideas/board'))).ranking.today;
  assert.equal(ranked.find(i => i.id === A.id).dailyWinner, true);
  assert.equal(ranked.find(i => i.id === B.id).dailyWinner, false, 'one daily winner per day');

  // Voting: the author can't vote for their own; others can, and can change their vote.
  assert.equal((await fetch(BASE + '/api/ideas/vote', { method: 'POST', headers: ida.H, body: JSON.stringify({ ideaId: A.id }) })).status, 400, 'no self-votes');
  assert.equal((await fetch(BASE + '/api/ideas/vote', { method: 'POST', headers: ivan.H, body: JSON.stringify({ ideaId: A.id }) })).status, 200);
  const ivanBoard = await json(await fetch(BASE + '/api/ideas/board', { headers: ivan.H }));
  assert.ok(ivanBoard.voting.slate.find(s => s.id === A.id)?.myVote, 'voter sees their vote');
  assert.ok((await json(await fetch(BASE + '/api/ideas/board', { headers: ida.H }))).voting.slate.find(s => s.id === A.id)?.mine, 'author sees “yours” instead of a vote button');

  // Announce: SM/GM/admin only; the author is revealed ONLY now.
  assert.equal((await fetch(BASE + '/api/ideas/announce', { method: 'POST', headers: ivan.H, body: '{}' })).status, 403);
  const win = await json(await api('/api/ideas/announce', { method: 'POST' }));
  assert.equal(win.id, A.id);
  assert.equal(win.votes, 1);
  const after = await json(await api('/api/ideas/board'));
  const crowned = after.winners.find(w => w.id === A.id);
  assert.equal(crowned.author, 'Ida Ideas', 'the author is finally revealed and credited');
  assert.equal((await api('/api/ideas/announce', { method: 'POST' })).status, 400, 'no double announcement for the same slate');

  // Implementation tracking with the report-back.
  assert.equal((await api('/api/ideas/' + B.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'implemented' }) })).status, 400, 'only weekly winners track implementation');
  await api('/api/ideas/' + A.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'in_progress', note: 'bins ordered, ETA Friday' }) });
  await api('/api/ideas/' + A.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'implemented', note: 'kitting bins live at Build — walk eliminated' }) });
  const done = (await json(await api('/api/ideas/board'))).winners.find(w => w.id === A.id);
  assert.equal(done.status, 'implemented');
  assert.match(done.implementedNote, /kitting bins/, 'the report-back rides with the winner');
});

test('monthly champion: weekly winners accumulate, the month vote crowns BY NAME and takes the spotlight', async () => {
  const mk = async name => {
    const u = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name, titles: ['Idea Probe'], password: 'ideaPw12' }) }));
    const l = await json(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'ideaPw12' }) }));
    return { id: u.id, H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.token } };
  };
  const mia = await mk('Mia Monthly'), milo = await mk('Milo Champion');

  // A second weekly winner (C) joins A from the weekly test on the monthly slate.
  const C = await (await fetch(BASE + '/api/ideas', { method: 'POST', headers: milo.H, body: JSON.stringify({ text: 'Shadow boards at every station so tools stop walking off', category: 'Shop life' }) })).json();
  await api('/api/ideas/' + C.id + '/daily-winner', { method: 'POST' });
  assert.equal((await fetch(BASE + '/api/ideas/vote', { method: 'POST', headers: mia.H, body: JSON.stringify({ ideaId: C.id }) })).status, 200);
  await api('/api/ideas/announce', { method: 'POST' });

  const b1 = await json(await api('/api/ideas/board'));
  assert.equal(b1.announced.kind, 'weekly', 'before the month closes, the weekly winner holds the spotlight');
  assert.equal(b1.announced.id, C.id);
  assert.equal(b1.monthlyVoting.open, true);
  assert.ok(b1.monthlyVoting.slate.length >= 2, 'the month\'s weekly winners accumulate on the ballot');
  assert.ok(b1.monthlyVoting.slate.every(s => typeof s.author === 'string' && s.author.length), 'monthly candidates show names — weekly winners are already public');

  // No self-votes; most votes wins (C: 2, A: 1).
  assert.equal((await fetch(BASE + '/api/ideas/vote-month', { method: 'POST', headers: milo.H, body: JSON.stringify({ ideaId: C.id }) })).status, 400, 'author cannot vote for their own');
  const A = b1.monthlyVoting.slate.find(s => s.id !== C.id);
  assert.equal((await fetch(BASE + '/api/ideas/vote-month', { method: 'POST', headers: milo.H, body: JSON.stringify({ ideaId: A.id }) })).status, 200, 'he can vote for a rival');
  assert.equal((await fetch(BASE + '/api/ideas/vote-month', { method: 'POST', headers: mia.H, body: JSON.stringify({ ideaId: C.id }) })).status, 200);
  assert.equal((await api('/api/ideas/vote-month', { method: 'POST', body: JSON.stringify({ ideaId: C.id }) })).status, 200); // admin's vote → C leads 2–1

  assert.equal((await fetch(BASE + '/api/ideas/announce-month', { method: 'POST', headers: mia.H, body: '{}' })).status, 403, 'crowning is SM/GM/admin');
  const crown = await json(await api('/api/ideas/announce-month', { method: 'POST' }));
  assert.equal(crown.id, C.id);
  assert.equal(crown.votes, 2);
  assert.equal(crown.author, 'Milo Champion', 'the monthly champion is announced BY NAME');

  const b2 = await json(await api('/api/ideas/board'));
  assert.equal(b2.announced.kind, 'monthly', 'the monthly champion replaces the weekly winner in the spotlight');
  assert.equal(b2.announced.id, C.id);
  assert.equal(b2.announced.author, 'Milo Champion');
  assert.ok(b2.winners.find(w => w.id === C.id).monthlyWinner, 'history carries the monthly crown');
  assert.equal((await api('/api/ideas/announce-month', { method: 'POST' })).status, 400, 'the month closes once');
  assert.equal((await api('/api/ideas/' + C.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'in_progress', note: 'boards being cut' }) })).status, 200, 'implementation tracking follows the champion');
});

test('recognition wins: Constitution behaviors required, "name the behavior" guard, ideas bridge, SM health', async () => {
  const meta = await json(await api('/api/wins'));
  assert.deepEqual(meta.categories, ['Quality catch', 'Safety intervention', 'Cost-saving idea', 'Helping a teammate',
    'Process improvement', 'Cross-training', 'Mentoring', 'Customer compliment'], 'the eight celebrated behaviors');

  const wanda = await json(await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Wanda Weld', titles: ['Idea Probe'], password: 'winsPw12' }) }));
  const post = body => api('/api/wins', { method: 'POST', body: JSON.stringify(body) });

  // Tied to the Constitution: a win must name one of the eight behaviors.
  assert.equal((await post({ scope: 'department', target: 'Production', title: 'Shipped ten trailers with zero defects this week' })).status, 400, 'category required');
  assert.equal((await post({ scope: 'department', target: 'Production', title: 'Shipped ten trailers with zero defects this week', category: 'Vibes' })).status, 400, 'only Constitution behaviors count');
  // Specific: "great job, Maria" teaches nobody.
  assert.equal((await post({ scope: 'individual', target: wanda.id, title: 'Great job, Wanda!!!', category: 'Quality catch' })).status, 400, 'name the behavior, not just the person');
  const w1 = await json(await post({ scope: 'individual', target: wanda.id, title: 'Caught a miswired brake controller before the unit left Finish', category: 'Quality catch' }));
  const wall = (await json(await api('/api/wins'))).wins;
  const mine = wall.find(w => w.id === w1.id);
  assert.equal(mine.category, 'Quality catch');
  assert.equal(mine.targetLabel, 'Wanda Weld');

  // Ideas → wins bridge: implementing the monthly champion auto-posts a win crediting the author BY NAME.
  const board = await json(await api('/api/ideas/board'));
  assert.equal(board.announced.kind, 'monthly');
  assert.equal((await api('/api/ideas/' + board.announced.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'implemented', note: 'shadow boards hung at every station' }) })).status, 200);
  const bridged = () => api('/api/wins').then(json).then(d => d.wins.filter(w => w.category === 'Process improvement' && w.targetLabel === 'Milo Champion'));
  const b1 = await bridged();
  assert.equal(b1.length, 1, 'implemented idea posts exactly one win for the author');
  assert.match(b1[0].title, /shadow boards/i, 'the win names the behavior — the idea itself');
  assert.equal((await api('/api/ideas/' + board.announced.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'implemented' }) })).status, 200);
  assert.equal((await bridged()).length, 1, 're-marking implemented does not duplicate the win');

  // Recognition health on the SM dashboard: frequency + the month's behavior mix.
  const rec = (await json(await api('/api/shopdash'))).recognition;
  assert.equal(rec.daysSinceLastWin, 0, 'a win was posted today');
  assert.ok(rec.monthTotal >= 2);
  assert.ok(rec.byCategory['Quality catch'] >= 1 && rec.byCategory['Process improvement'] >= 1);
  assert.ok(!rec.missing.includes('Quality catch'), 'celebrated behaviors leave the missing list');
  assert.ok(rec.missing.includes('Mentoring'), 'uncelebrated behaviors are called out');

  // The Monday digest builds with the wins section in it (dry run renders the full email).
  const dry = await json(await api('/api/admin/digest/send', { method: 'POST', body: JSON.stringify({ dryRun: true }) }));
  assert.match(dry.subject, /weekly digest/i, 'digest still builds with the recognition block');
});

test('guarded reprints: reason required, permanent register, requeue with badge, MSO needs a buyer', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/print-queue/reprint', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: '{}' })).status, 403, 'sales cannot reprint');
  assert.equal((await fetch(BASE + '/api/print/unit-history?q=x', { headers: { Authorization: 'Bearer ' + sales } })).status, 403, 'sales cannot read print history');
  assert.equal((await api('/api/print/unit-history?q=NOPEVIN')).status, 404, 'unknown VIN 404s');

  // The unit whose VIN label was printed earlier in the suite — look it up by VIN.
  const h = await json(await api('/api/print/unit-history?q=BLTTESTVIN0000099'));
  assert.equal(h.unitId, vinUnitId, 'history resolves the unit by VIN');
  assert.ok(h.jobs.find(j => j.kind === 'vin' && j.status === 'printed'), 'VIN label shows as printed');

  // Reason is mandatory; a real reason requeues the printed job and registers the event.
  assert.equal((await api('/api/print-queue/reprint', { method: 'POST', body: JSON.stringify({ unitId: vinUnitId, kind: 'vin' }) })).status, 400, 'no reason -> refused');
  assert.equal((await api('/api/print-queue/reprint', { method: 'POST', body: JSON.stringify({ unitId: vinUnitId, kind: 'vin', reason: 'x' }) })).status, 400, 'trivial reason -> refused');
  const rp = await json(await api('/api/print-queue/reprint', { method: 'POST', body: JSON.stringify({ unitId: vinUnitId, kind: 'vin', reason: 'label damaged during install (smoke test)' }) }));
  assert.equal(rp.requeued, true);
  assert.equal(rp.reprintCount, 1);
  const q1 = await json(await api('/api/print-queue?kind=vin'));
  const job = q1.find(j => j.unitId === vinUnitId);
  assert.ok(job, 'reprint is back in the queue');
  assert.equal(job.reprintCount, 1, 'queue row carries the reprint badge count');
  assert.match(job.reprintReason, /damaged/, 'queue row carries the reason');
  assert.equal((await api('/api/print-queue/reprint', { method: 'POST', body: JSON.stringify({ unitId: vinUnitId, kind: 'vin', reason: 'double request should fail' }) })).status, 400, 'already queued -> refused');
  const h2 = await json(await api('/api/print/unit-history?q=' + vinUnitId));
  assert.ok(h2.reprints.length >= 1 && /damaged/.test(h2.reprints[0].reason), 'permanent reprint register records the event');
  await api('/api/print-queue/' + job.jobId + '/printed', { method: 'POST' }); // leave the queue clean

  // An MSO can never reprint for an unsold unit — it names the buyer.
  const stock = await json(await api('/api/orders/stock', { method: 'POST', body: JSON.stringify({ modelId: 'UT7X16T', qty: 1 }) }));
  await api('/api/orders/' + stock.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Build' }) });
  const unit = (await json(await api('/api/trailers'))).registry.find(t => t.orderId === stock.id);
  const denied = await api('/api/print-queue/reprint', { method: 'POST', body: JSON.stringify({ unitId: unit.id, kind: 'mso', reason: 'trying to reprint an unsold MSO' }) });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /buyer/i, 'refusal explains the MSO names the buyer');
});

test('NHTSA vPIC verdict logic: clean, check-digit failure, unregistered WMI, wrong year', async () => {
  const { evaluateNhtsa } = await import('../src/vin.js');
  // vin position 10 = 'T' -> model year 2026
  const vin = '7XJBB3236TS001714';
  const clean = evaluateNhtsa({ ErrorCode: '0', ErrorText: '0 - VIN decoded clean. Check Digit (9th position) is correct',
    Make: 'BUILT', Manufacturer: 'BUILT MANUFACTURING LLC', ModelYear: '2026', VehicleType: 'TRAILER' }, vin);
  assert.equal(clean.ok, true);
  assert.match(clean.note, /clean/i);
  const badDigit = evaluateNhtsa({ ErrorCode: '1', ErrorText: '1 - Check Digit (9th position) does not calculate properly',
    Manufacturer: 'BUILT MANUFACTURING LLC', ModelYear: '2026', VehicleType: 'TRAILER' }, vin);
  assert.equal(badDigit.ok, false);
  assert.match(badDigit.note, /check digit/i);
  const unregistered = evaluateNhtsa({ ErrorCode: '7', ErrorText: '7 - Manufacturer is not registered', Manufacturer: '', ModelYear: '' }, vin);
  assert.equal(unregistered.ok, false);
  assert.match(unregistered.note, /WMI registered with NHTSA/i);
  const wrongYear = evaluateNhtsa({ ErrorCode: '0', ErrorText: '0 - VIN decoded clean',
    Manufacturer: 'BUILT MANUFACTURING LLC', ModelYear: '2024', VehicleType: 'TRAILER' }, vin);
  assert.equal(wrongYear.ok, false);
  assert.match(wrongYear.note, /2024.*2026/);
  const wrongType = evaluateNhtsa({ ErrorCode: '0', ErrorText: '0 - VIN decoded clean',
    Manufacturer: 'BUILT MANUFACTURING LLC', ModelYear: '2026', VehicleType: 'PASSENGER CAR' }, vin);
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.note, /TRAILER/);
});

test('NHTSA endpoints: OM/GM/Admin only; disabled cleanly in hermetic env', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/vin/nhtsa-check', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: '{}' })).status, 403, 'sales cannot run NHTSA checks');
  assert.equal((await fetch(BASE + '/api/vin/nhtsa-failures', { headers: { Authorization: 'Bearer ' + sales } })).status, 403, 'sales cannot read failures');
  const r = await json(await api('/api/vin/nhtsa-check', { method: 'POST', body: JSON.stringify({ all: true }) }));
  assert.equal(r.skipped, 'NHTSA checks disabled', 'NHTSA_DISABLED short-circuits (no network in tests)');
  const failures = await json(await api('/api/vin/nhtsa-failures'));
  assert.ok(Array.isArray(failures), 'failures list is an array');
  const q = await json(await api('/api/print-queue?kind=vin'));
  for (const j of q) assert.ok('nhtsaOk' in j, 'queue rows carry the NHTSA verdict');
});

test('VIN settings: serial counter is settable but forward-only (no collision with paper VINs)', async () => {
  const cur = (await json(await api('/api/trailers'))).config;
  assert.ok(cur.nextSerial >= 1, 'config exposes the next serial');
  const bumped = await json(await api('/api/trailers/config', { method: 'PUT', body: JSON.stringify({ nextSerial: cur.nextSerial + 4000 }) }));
  assert.equal(bumped.nextSerial, cur.nextSerial + 4000, 'serial jumps forward');
  assert.equal((await api('/api/trailers/config', { method: 'PUT', body: JSON.stringify({ nextSerial: 1 }) })).status, 400, 'rewinding the counter is refused');
  assert.equal((await api('/api/trailers/config', { method: 'PUT', body: JSON.stringify({ nextSerial: 10000000 }) })).status, 400, 'out-of-range serial refused');
});

test('VIN generation follows the filed Part 565 scheme: VDS, per-year serial, check digit', async () => {
  const { computeCheckDigit, vinYear } = await import('../src/vin.js');
  // UT7X16T carries the known-real specs from the seed (Utility, 19 ft, tandem) — the same
  // numbers as the physical MSO sample (7XJBU19*2*...).
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'VIN Scheme Test Co', kind: 'Dealership', allowed: ['Utility'] }) }));
  const o = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: 'UT7X16T', qty: 2, due: '2026-12-15' }) }));
  const before = (await json(await api('/api/trailers'))).config.nextSerial;
  await api('/api/orders/' + o.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Build' }) }); // entering Build issues VINs
  const units = (await json(await api('/api/trailers'))).registry.filter(t => t.orderId === o.id);
  assert.equal(units.length, 2, 'both units got VINs');
  const year = new Date().getFullYear();
  for (const u of units) {
    const v = u.vin;
    assert.equal(v.length, 17);
    assert.equal(v.slice(0, 3), 'BLT', 'WMI (test placeholder)');
    assert.equal(v[3], 'B', 'pos 4: ball hitch');
    assert.equal(v[4], 'U', 'pos 5: utility body');
    assert.equal(v.slice(5, 7), '19', 'pos 6-7: 19 ft exactly like the MSO sample');
    assert.equal(v[7], '2', 'pos 8: tandem = 2 axles');
    assert.equal(v[8], computeCheckDigit(v), 'pos 9: check digit verifies independently');
    assert.equal(vinYear(v), year, 'pos 10: current model year');
    assert.equal(v[10], 'A', 'pos 11: plant (test placeholder)');
    assert.match(v.slice(11), /^\d{6}$/, 'pos 12-17: six-digit serial');
  }
  const serials = units.map(u => Number(u.vin.slice(11))).sort((a, b) => a - b);
  assert.equal(serials[1], serials[0] + 1, 'serials are sequential');
  assert.equal((await json(await api('/api/trailers'))).config.nextSerial, before + 2, 'per-year counter advanced by 2');

  // A model missing its Length cannot get a VIN — the error says exactly what to fill in.
  await api('/api/models/BBQ1/specs', { method: 'PATCH', body: JSON.stringify({ hitchCode: 'B', bodyCode: 'G', axles: 1, lengthFt: '' }) });
  const cust2 = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'VIN Scheme BBQ Co', kind: 'Dealership', allowed: ['BBQ'] }) }));
  const o2 = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust2.id, modelId: 'BBQ1', qty: 1 }) }));
  const r = await api('/api/trailers/assign', { method: 'POST', body: JSON.stringify({ orderId: o2.id }) });
  assert.equal(r.status, 400, 'VIN refused while specs are incomplete');
  assert.match((await r.json()).error, /Length.*print specs/i, 'error names the missing field and where to fix it');
  await api('/api/models/BBQ1/specs', { method: 'PATCH', body: JSON.stringify({ hitchCode: 'B', bodyCode: 'G', axles: 1, lengthFt: 12 }) });
  assert.equal((await api('/api/trailers/assign', { method: 'POST', body: JSON.stringify({ orderId: o2.id }) })).status, 200, 'VIN issues once the spec is filled');
});

test('print specs + print-data: the numbers the VIN label and MSO carry', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/print-specs', { headers: { Authorization: 'Bearer ' + sales } })).status, 403, 'specs are OM/GM/Admin only');

  const specs = await json(await api('/api/print-specs'));
  assert.ok(specs.length >= 1 && specs[0].id, 'every model listed');
  const unit = await json(await api('/api/trailers/' + vinUnitId + '/print-data'));
  const modelId = unit.modelId;
  assert.equal((await api('/api/models/' + encodeURIComponent(modelId) + '/specs', { method: 'PATCH',
    body: JSON.stringify({ gvwrLbs: 10500, emptyWeightLbs: 2000, tire: '255', rim: 'R18', tirePsi: 80, lengthFt: 19 }) })).status, 200);
  const after = (await json(await api('/api/print-specs'))).find(m => m.id === modelId);
  assert.equal(after.gvwrLbs, 10500);
  assert.equal(after.lengthFt, 19);

  const pd = await json(await api('/api/trailers/' + vinUnitId + '/print-data'));
  assert.equal(pd.vin, 'BLTTESTVIN0000099');
  assert.equal(pd.gvwrLbs, 10500);
  assert.equal(pd.cargoMaxLbs, 8500, 'cargo max = GVWR - empty weight');
  assert.equal(pd.tire, '255');
  assert.equal(pd.tirePsi, 80);
  assert.ok(Number.isInteger(pd.year) && pd.year >= 2010, 'model year decoded from the VIN');
  assert.ok(pd.dealer && pd.dealer.name, 'MSO buyer block resolves from the order');
  assert.equal((await api('/api/trailers/NOPE/print-data')).status, 404, 'unknown unit 404s');
  assert.equal((await api('/api/models/NOPE/specs', { method: 'PATCH', body: '{}' })).status, 404, 'unknown model 404s');
});

test('staff users: any user can set their OWN email without admin (self-service)', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token; // Angela Ruiz — Sales, editor tier, NOT admin
  const hdrs = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales };
  // Editing another user is (still) admin-only — the path that used to be the ONLY way to set email.
  const users = await json(await api('/api/users'));
  const other = users.find(u => u.username !== 'aruiz');
  assert.equal((await fetch(BASE + '/api/users/' + other.id, { method: 'PATCH', headers: hdrs, body: JSON.stringify({ email: 'x@y.test' }) })).status, 403, 'editing others still admin-only');
  // But setting your OWN email works for anyone.
  assert.equal((await fetch(BASE + '/api/users/me/email', { method: 'POST', headers: hdrs, body: JSON.stringify({ email: 'not-an-email' }) })).status, 400, 'bad format rejected');
  const ok = await fetch(BASE + '/api/users/me/email', { method: 'POST', headers: hdrs, body: JSON.stringify({ email: 'angela@builttrailers.app' }) });
  assert.equal(ok.status, 200);
  const me = users.find(u => u.username === 'aruiz');
  const after = (await json(await api('/api/users'))).find(u => u.id === me.id);
  assert.equal(after.email, 'angela@builttrailers.app', 'self-set email persisted');
  // Login payload now carries it, so the UI can prefill "My email".
  const relog = await json(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) }));
  assert.equal(relog.user.email, 'angela@builttrailers.app');
});

test('staff users: email is stored, returned, and editable', async () => {
  const r = await api('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Email Test User', titles: ['Sales'], email: 'emailtest@builttrailers.app' }) });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  let u = (await json(await api('/api/users'))).find(x => x.id === id);
  assert.equal(u.email, 'emailtest@builttrailers.app');
  await api('/api/users/' + id, { method: 'PATCH', body: JSON.stringify({ email: 'changed@builttrailers.app' }) });
  u = (await json(await api('/api/users'))).find(x => x.id === id);
  assert.equal(u.email, 'changed@builttrailers.app');
});

test('global search: finds orders, VINs, customers, and parts; gated by auth', async () => {
  assert.equal((await fetch(BASE + '/api/search?q=BLT')).status, 401, 'unauthenticated rejected');
  const short = await json(await api('/api/search?q=B'));
  assert.equal(short.units.length, 0, 'under 2 chars returns nothing');
  const byVin = await json(await api('/api/search?q=BLTTESTVIN0000099'));
  assert.equal(byVin.units.length, 1, 'VIN found');
  assert.ok(byVin.units[0].orderId, 'VIN result carries its order');
  const anyOrder = (await json(await api('/api/orders'))).orders[0];
  const byOrder = await json(await api('/api/search?q=' + encodeURIComponent(anyOrder.id)));
  assert.ok(byOrder.orders.some(o => o.id === anyOrder.id), 'order found by exact id');
  const byCust = await json(await api('/api/search?q=ProShop')); // boot-seeded dealer network
  assert.ok(byCust.customers.length >= 1, 'customer name matches');
  const byPart = await json(await api('/api/search?q=BUY-'));
  assert.ok(byPart.parts.length >= 1, 'parts match');
});

test('shop floor: station page + PIN-gated stage advance (full flow)', async () => {
  // The VIN-corrected unit from the print tests — find its unit + order via search (dogfood).
  const s = await json(await api('/api/search?q=BLTTESTVIN0000099'));
  const unit = s.units[0];
  assert.ok(unit?.id && unit?.orderId, 'unit + order resolved');

  // Read-only scan before any PIN exists
  let page = await (await fetch(BASE + '/u/' + unit.id)).text();
  assert.match(page, /BLTTESTVIN0000099/, 'station page shows the VIN');
  assert.match(page, /station view/i, 'station layout rendered');
  assert.match(page, /aren't enabled/i, 'no PIN -> floor updates disabled hint');

  // Advance attempts before a PIN is set -> 503
  const noPin = await fetch(BASE + '/u/' + unit.id + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }) });
  assert.equal(noPin.status, 503, 'unconfigured floor updates are off');

  // PIN admin: sales cannot set it; bad format rejected; admin sets it
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/admin/shop-pin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: JSON.stringify({ pin: '4321' }) })).status, 403, 'sales cannot set the PIN');
  assert.equal((await api('/api/admin/shop-pin', { method: 'POST', body: JSON.stringify({ pin: 'abc' }) })).status, 400, 'non-digit PIN rejected');
  assert.equal((await api('/api/admin/shop-pin', { method: 'POST', body: JSON.stringify({ pin: '7788' }) })).status, 200);
  assert.equal((await json(await api('/api/admin/shop-pin'))).set, true, 'status reports PIN set');

  // Page now offers the action; wrong PIN 401
  page = await (await fetch(BASE + '/u/' + unit.id)).text();
  assert.match(page, /Mark Finish complete/i, 'action button rendered for the current stage');
  const bad = await fetch(BASE + '/u/' + unit.id + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0000', worker: 'JT' }) });
  assert.equal(bad.status, 401, 'wrong PIN rejected');

  // The QC gate: even with the right PIN, Finish -> Ready is blocked until the unit passes QC
  const gated = await fetch(BASE + '/u/' + unit.id + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7788', worker: 'JT' }) });
  assert.equal(gated.status, 400, 'Ready is gated on QC');
  assert.match((await gated.json()).error, /QC checklist/i, 'gate says why');

  // The checklist: any staff can read it; only an admin can edit it
  const cl = await json(await api('/api/qc/checklist'));
  assert.ok(Array.isArray(cl.items) && cl.items.length >= 3, 'default checklist present');
  assert.equal((await fetch(BASE + '/api/qc/checklist', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: JSON.stringify({ items: ['x'] }) })).status, 403, 'sales cannot edit the checklist');
  assert.equal((await api('/api/qc/checklist', { method: 'POST', body: JSON.stringify({ items: [] }) })).status, 400, 'empty checklist rejected');
  assert.equal((await api('/api/qc/checklist', { method: 'POST', body: JSON.stringify({ items: ['Lights work', 'Final visual pass'] }) })).status, 200);
  assert.deepEqual((await json(await api('/api/qc/checklist'))).items, ['Lights work', 'Final visual pass'], 'edited checklist round-trips');

  // Pass QC (photo included) as signed-in staff — must confirm the checklist
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await api('/api/trailers/' + unit.id + '/qc', { method: 'POST', body: JSON.stringify({ photos: [px] }) })).status, 400, 'unconfirmed QC rejected');
  assert.equal((await api('/api/trailers/' + unit.id + '/qc', { method: 'POST', body: JSON.stringify({ confirmed: true, photos: [px], note: 'smoke QC' }) })).status, 200);
  const det = await json(await api('/api/trailers/' + unit.id + '/detail'));
  assert.ok(det.buildLog.find(s => s.step === 'QC')?.done, 'QC build step stamped');
  assert.ok((det.photos || []).length >= 1, 'unit photo attached');

  // With QC passed, the same PIN advance now succeeds: Finish -> Ready
  const ok = await fetch(BASE + '/u/' + unit.id + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7788', worker: 'JT' }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).stage, 'Ready');
  assert.equal((await json(await api('/api/orders/' + unit.orderId))).stage, 'Ready', 'order really moved (same path as desktop)');

  // Ready is past the floor's stages -> further advances are office-only
  const past = await fetch(BASE + '/u/' + unit.id + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '7788' }) });
  assert.equal(past.status, 400, 'non-floor stage rejected');

  // Clearing the PIN turns floor updates back off
  await api('/api/admin/shop-pin', { method: 'POST', body: JSON.stringify({ pin: '' }) });
  assert.equal((await json(await api('/api/admin/shop-pin'))).set, false);
});

test('owner reminders: admin-only run endpoint, dry-run shape, unconfigured-email skip', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/admin/reminders/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: '{}' })).status, 403, 'sales cannot run reminders');
  const dry = await json(await api('/api/admin/reminders/run', { method: 'POST', body: JSON.stringify({ dryRun: true }) }));
  assert.equal(dry.dryRun, true);
  assert.equal(typeof dry.expiryEligible, 'number');
  assert.ok(Array.isArray(dry.expiry) && Array.isArray(dry.maintenance), 'dry run lists who would be emailed');
  const real = await json(await api('/api/admin/reminders/run', { method: 'POST', body: '{}' }));
  assert.equal(real.skipped, 'email not configured', 'real run without RESEND_API_KEY skips safely');
});

test('weekly digest: admin-only send endpoint, dry-run recipients, unconfigured-email skip', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/admin/digest/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: '{}' })).status, 403, 'sales cannot send the digest');
  const dry = await json(await api('/api/admin/digest/send', { method: 'POST', body: JSON.stringify({ dryRun: true }) }));
  assert.equal(dry.dryRun, true);
  assert.match(dry.subject, /weekly digest/i, 'digest subject built from the scorecard');
  assert.ok(Array.isArray(dry.recipients), 'dry run lists who would be emailed');
  const real = await json(await api('/api/admin/digest/send', { method: 'POST', body: '{}' }));
  assert.equal(real.skipped, 'email not configured', 'real send without RESEND_API_KEY skips safely');
});

test('owner: full registration (phone + full address) succeeds and is visible to staff', async () => {
  const r = await oapi('/api/owner/register', { method: 'POST', body: JSON.stringify({
    email: 'fulladdr@x.test', password: 'ownerpass1', name: 'Fully Addressed',
    vin: 'BLTTESTVIN0000099', ownerName: 'Fully Addressed', saleDate: new Date().toISOString().slice(0, 10),
    phone: '555-987-6543', warrantyAddress: '742 Evergreen Terrace', city: 'Springfield', state: 'ID', zip: '83501' }) });
  assert.equal(r.status, 200);
  const reg = (await r.json()).registration;
  assert.equal(reg.status, 'pending', 'unverified owner submission awaits staff review');

  const pending = await json(await api('/api/warranty/registrations/pending'));
  const mine = pending.find(p => p.vin === 'BLTTESTVIN0000099');
  assert.ok(mine, 'staff can see the new registration');
  assert.equal(mine.phone, '555-987-6543');
  assert.equal(mine.address, '742 Evergreen Terrace');
  assert.equal(mine.city, 'Springfield');
  assert.equal(mine.state, 'ID');
  assert.equal(mine.zip, '83501');
});

test('margin report: approved sale price rolls up by model, dealer, and month', async () => {
  const unit = (await json(await api('/api/search?q=BLTTESTVIN0000099'))).units[0];
  const approve = await api('/api/warranty/registrations/' + unit.id + '/review',
    { method: 'POST', body: JSON.stringify({ decision: 'approve', salePrice: 15000, accessories: 'Bimini top, spare tire' }) });
  assert.equal(approve.status, 200);
  const m = await json(await api('/api/warranty/margins'));
  assert.ok(m.byModel.length >= 1 && m.byModel.some(x => x.n >= 1 && x.avgSale > 0), 'by-model rollup has the sale');
  assert.ok(Array.isArray(m.byDealer) && m.byDealer.length >= 1, 'by-dealer rollup present');
  assert.ok(m.byDealer.every(d => typeof d.avgMargin === 'number' && typeof d.totalMargin === 'number'), 'dealer rows carry margin figures');
  const thisMonth = new Date().toISOString().slice(0, 7);
  assert.ok(m.byMonth.some(x => x.month === thisMonth && x.n >= 1), 'monthly trend includes this month');
});

test('warranty report: claim costs roll up by model (with claim rate) and by part', async () => {
  const unit = (await json(await api('/api/search?q=BLTTESTVIN0000099'))).units[0];
  const open = await api('/api/warranty/claims', { method: 'POST', body: JSON.stringify({
    trailerId: unit.id, issue: 'jack stand cracked', laborCost: 100, shippingCost: 25,
    parts: [{ partId: 'BUY-JCK-001', qty: 2 }] }) });
  assert.equal(open.status, 200);
  const s = await json(await api('/api/warranty/summary'));
  assert.ok(s.totalClaims >= 1 && s.totalCost > 0, 'totals include the claim');
  const mdl = s.byModel.find(x => x.claims >= 1);
  assert.ok(mdl, 'by-model rollup has the claim');
  assert.ok(mdl.unitsBuilt >= 1 && mdl.claimRatePct != null && mdl.claimRatePct > 0, 'claim rate computed from units built');
  assert.ok(typeof mdl.avgCost === 'number' && mdl.avgCost > 0, 'avg cost per claim computed');
  const part = (s.byPart || []).find(p => p.partId === 'BUY-JCK-001');
  assert.ok(part, 'failed part appears in the by-part rollup');
  assert.equal(part.qty, 2, 'quantity replaced tallied');
  assert.ok(part.cost > 0, 'part cost priced from Parts Master');
  assert.equal(part.claims, 1, 'distinct claims counted');
});

test('performance: scorecard has KPIs vs targets, cycle data from real stage moves, and owned recommendations', async () => {
  const d = await json(await api('/api/performance'));
  assert.ok(Array.isArray(d.kpis) && d.kpis.length >= 5, 'KPI list present');
  for (const k of d.kpis) assert.ok(['ok', 'warn', 'miss', 'nodata', 'info'].includes(k.status), 'each KPI scored');
  assert.equal(d.cycles.length, 4, 'all four production stages tracked');
  assert.ok(d.completions.completed90 >= 1, 'stage advances in this suite produced completion data');
  assert.ok(d.recommendations.length >= 1 && d.recommendations.every(r => r.owner && r.text && r.link), 'recommendations are owned and actionable');
  assert.ok(d.targets.onTimePct > 0, 'targets loaded with defaults');
  // Gate: Sales (sections reset to orders+parts earlier in the suite, no performance section after replace)
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/performance', { headers: { Authorization: 'Bearer ' + sales } })).status, 403, 'section-gated');
  // Expectations are editable (admin) and persist
  assert.equal((await fetch(BASE + '/api/performance/targets', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: JSON.stringify({ onTimePct: 50 }) })).status, 403, 'targets admin-only');
  await api('/api/performance/targets', { method: 'POST', body: JSON.stringify({ onTimePct: 95, staleWipDays: 3 }) });
  const after = await json(await api('/api/performance'));
  assert.equal(after.targets.onTimePct, 95);
  assert.equal(after.targets.staleWipDays, 3);
  assert.equal(after.targets.maxClaimRatePct, d.targets.maxClaimRatePct, 'unspecified targets unchanged');
});

test('replenishment push: Shop Manager inbox gets targeted order/build items from MRP', async () => {
  // A part below its reorder level with no stock = MRP shortage
  const part = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Push Test Gusset', cost: 3, reorder: 5 }) }));
  const mr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) });
  const shopMgr = (await mr.json()).token; // Maria Chen — Shop Manager title
  assert.ok(shopMgr, 'shop manager login succeeded');
  const inbox = await json(await fetch(BASE + '/api/inbox', { headers: { Authorization: 'Bearer ' + shopMgr } }));
  const repl = inbox.items.find(i => ['order_now', 'build_now', 'replenish_soon'].includes(i.key));
  assert.ok(repl, 'Shop Manager receives a replenishment push');
  assert.equal(repl.link, 'predict', 'push links to Predictive Ordering');
  const perf = inbox.items.find(i => i.key === 'perf_miss');
  if (perf) assert.equal(perf.link, 'performance', 'performance misses link to the Performance screen');
  void part;
});

test('last-admin guard: every admin but me can be demoted, but never the final one', async () => {
  const me = (await json(await api('/api/auth/me'))).user;
  const users = await json(await api('/api/users'));
  const otherAdmins = users.filter(u => u.role === 'admin' && u.active !== false && u.id !== me.id);
  const saved = otherAdmins.map(u => ({ id: u.id, titles: (u.titles && u.titles.length) ? u.titles : [u.title].filter(Boolean) }));
  // Demote every other admin (allowed — an admin still remains: me)
  for (const u of otherAdmins) {
    const r = await api('/api/users/' + u.id, { method: 'PATCH', body: JSON.stringify({ titles: ['Sales'] }) });
    assert.equal(r.status, 200, `demoting ${u.id} allowed while another admin remains`);
  }
  // Now I'm the last admin — demoting me must be refused
  const lastR = await api('/api/users/' + me.id, { method: 'PATCH', body: JSON.stringify({ titles: ['Sales'] }) });
  assert.equal(lastR.status, 400, 'demoting the last admin refused');
  assert.match((await lastR.json()).error, /last admin/i);
  const stillMe = (await json(await api('/api/users'))).find(u => u.id === me.id);
  assert.equal(stillMe.role, 'admin', 'I remain admin');
  // Restore the demoted admins (titles drive the tier back up)
  for (const s of saved) {
    const r = await api('/api/users/' + s.id, { method: 'PATCH', body: JSON.stringify({ titles: s.titles }) });
    assert.equal(r.status, 200);
  }
  const after = await json(await api('/api/users'));
  for (const s of saved) assert.equal(after.find(u => u.id === s.id).role, 'admin', `${s.id} restored to admin`);
});

test('lean/QRM: WIP limits breach pushes SM, andon flows QR->board->resolve->Pareto, MCT computed', async () => {
  // -- WIP limits: two orders into Scheduled, cap at 1 -> violation + recommendation
  const model = (await json(await api('/api/models')))[0];
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'QRM Test Dealer', kind: 'Dealership' }) }));
  await api('/api/customers/' + cust.id + '/types', { method: 'PATCH', body: JSON.stringify({ type: model.category, on: true }) });
  const o1 = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  const o2 = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  await api('/api/orders/' + o1.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Scheduled' }) });
  await api('/api/orders/' + o2.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Scheduled' }) });
  await api('/api/wip-limits', { method: 'POST', body: JSON.stringify({ 'Scheduled': 1 }) });
  const board = await json(await api('/api/orders'));
  assert.equal(board.wipLimits['Scheduled'], 1, 'limit rides the board payload');
  let sc = await json(await api('/api/performance'));
  assert.ok(sc.wip.violations.some(v => v.stage === 'Scheduled' && v.count >= 2 && v.limit === 1), 'breach detected');
  assert.ok(sc.recommendations.some(r => r.owner === 'Shop Manager' && r.text.includes('WIP over limit in Scheduled')), 'breach pushed as an owned recommendation');

  // -- MCT: this suite's own stage moves produced completions; white-space rows for all stages
  assert.ok(Array.isArray(sc.mct.whiteSpace) && sc.mct.whiteSpace.length === 4, 'white-space table covers the four production stages');
  assert.ok(sc.mct.orders.length >= 1 && typeof sc.mct.avgMctDays === 'number', 'MCT computed from real completions');

  // -- Andon: PIN-gated raise from the station page -> board flag -> inbox -> resolve -> Pareto
  await api('/api/admin/shop-pin', { method: 'POST', body: JSON.stringify({ pin: '4455' }) });
  const unit = (await json(await api('/api/search?q=BLTTESTVIN0000099'))).units[0];
  const bad = await fetch(BASE + '/u/' + unit.id + '/problem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0000', reason: 'Machine down' }) });
  assert.equal(bad.status, 401, 'wrong PIN rejected');
  const raise = await fetch(BASE + '/u/' + unit.id + '/problem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '4455', worker: 'JT', reason: 'Waiting on parts', note: 'no axles' }) });
  assert.equal(raise.status, 200);
  const { id: andonId, orderId } = await raise.json();
  assert.equal((await json(await api('/api/orders'))).orders.find(o => o.id === orderId).andonOpen, 1, 'board card flagged 🔴');
  assert.match(await (await fetch(BASE + '/u/' + unit.id)).text(), /Problem open/i, 'station page shows the open-problem banner');
  const mr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) });
  const inbox = await json(await fetch(BASE + '/api/inbox', { headers: { Authorization: 'Bearer ' + (await mr.json()).token } }));
  assert.ok(inbox.items.some(i => i.key === 'andon'), 'Shop Manager inbox carries the open problem');
  const detail = await json(await api('/api/orders/' + orderId));
  assert.ok(detail.andons.some(a => a.id === andonId && !a.resolved), 'order detail lists it');
  assert.equal((await api('/api/andon/' + andonId + '/resolve', { method: 'POST', body: JSON.stringify({ resolution: 'axles arrived' }) })).status, 200);
  assert.equal((await json(await api('/api/orders'))).orders.find(o => o.id === orderId).andonOpen, 0, 'flag clears on resolve');
  sc = await json(await api('/api/performance'));
  assert.ok(sc.andon.pareto.some(p => p.reason === 'Waiting on parts' && p.events >= 1 && p.blockedHours >= 0), 'blocker Pareto tallies the event');
  // cleanup so later tests see a quiet shop
  await api('/api/admin/shop-pin', { method: 'POST', body: JSON.stringify({ pin: '' }) });
  await api('/api/wip-limits', { method: 'POST', body: '{}' });
});

test('station QR: a signed-in staff session IS the identity — no PIN, real name attributed', async () => {
  // The shop PIN was cleared by the previous test, so the PIN path would 503 — a session still works.
  const unit = (await json(await api('/api/search?q=BLTTESTVIN0000099'))).units[0];
  const r = await fetch(BASE + '/u/' + unit.id + '/problem', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ reason: 'Rework needed', note: 'session identity test' }) });
  assert.equal(r.status, 200, 'signed-in session accepted with no PIN configured at all');
  const detail = await json(await api('/api/orders/' + unit.orderId));
  const prob = detail.andons.find(a => a.note === 'session identity test');
  assert.ok(prob, 'problem recorded');
  assert.match(prob.raisedBy || '', /Soelberg/, 'attributed to the ACCOUNT name, not typed initials');
  await api('/api/andon/' + prob.id + '/resolve', { method: 'POST', body: JSON.stringify({ resolution: 'test cleanup' }) });
});

test('daily stand-up: generate -> gate -> approve -> mid-day reset -> stage auto-completes -> effectiveness', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const ws = (await json(await api('/api/workstations')))[0];
  assert.ok(ws, 'labor routing provides workstations');
  const users = await json(await api('/api/users'));
  const maria = users.find(u => u.username === 'mchen');
  await api('/api/users/' + maria.id, { method: 'PATCH', body: JSON.stringify({ workstation: ws }) });

  // An order sitting in Build (routing rows default to the Build stage) = plannable work.
  const model = (await json(await api('/api/models')))[0];
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Standup Test Dealer', kind: 'Dealership' }) }));
  await api('/api/customers/' + cust.id + '/types', { method: 'PATCH', body: JSON.stringify({ type: model.category, on: true }) });
  const ord = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  await api('/api/orders/' + ord.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Build' }) });

  // Sales can't run the plan; the Shop Manager can.
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/standup/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: '{}' })).status, 403, 'plan management is SM/GM-only');
  const mr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) });
  const smh = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await mr.json()).token };

  const gen = await json(await fetch(BASE + '/api/standup/generate', { method: 'POST', headers: smh, body: JSON.stringify({ date: today }) }));
  assert.ok(gen.created >= 1, 'plan proposed from the production queue');
  const gen2 = await json(await fetch(BASE + '/api/standup/generate', { method: 'POST', headers: smh, body: JSON.stringify({ date: today }) }));
  assert.equal(gen2.created, 0, 're-generating fills gaps only — no duplicates');

  let plan = await json(await fetch(BASE + '/api/standup?date=' + today, { headers: smh }));
  const buildTask = plan.tasks.find(t => t.orderId === ord.id && t.stage === 'Build');
  assert.ok(buildTask, 'the Build-stage order became a task');
  assert.ok(buildTask.workstation, 'task carries its workstation from the routing');

  const ap = await json(await fetch(BASE + '/api/standup/approve', { method: 'POST', headers: smh, body: JSON.stringify({ date: today }) }));
  assert.ok(ap.approved >= 1, 'SM approved the day');
  // Mid-day reset: reassign to Maria + resize the estimate.
  assert.equal((await fetch(BASE + '/api/standup/task/' + buildTask.id, { method: 'PATCH', headers: smh, body: JSON.stringify({ userId: maria.id, estHours: 3.5 }) })).status, 200);

  const my = await json(await fetch(BASE + '/api/standup/me?date=' + today, { headers: smh }));
  assert.ok(my.goal >= 1 && my.tasks.some(t => t.orderId === ord.id), 'My Day shows the goal');
  assert.equal(my.done, 0, 'nothing done yet');

  // Completing the REAL stage checks the task off automatically.
  await api('/api/orders/' + ord.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Paint/Powder Coat' }) });
  const my2 = await json(await fetch(BASE + '/api/standup/me?date=' + today, { headers: smh }));
  const doneTask = my2.tasks.find(t => t.orderId === ord.id);
  assert.ok(doneTask.done && doneTask.completedVia === 'stage', 'stage completion auto-checked the task');
  assert.ok(my2.done >= 1, 'goal-vs-actual moved');

  // The day is logged for reporting: per-employee effectiveness row exists.
  const rep = await json(await api('/api/standup/report?days=7'));
  const row = rep.find(r => r.userId === maria.id && r.date === today);
  assert.ok(row && row.assigned >= 1 && row.done >= 1 && row.donePct != null, 'effectiveness recorded per employee per day');
});

test('performance-calibrated plan + My Station + per-VIN build log stamping', async () => {
  const users = await json(await api('/api/users'));
  const maria = users.find(u => u.username === 'mchen');
  const ws = maria.workstation; // set by the stand-up test
  assert.ok(ws, 'Maria has a workstation');

  // Past performance -> calibrated suggestion: yesterday Maria completed 5h of assigned work.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const mr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) });
  const login = await mr.json();
  assert.equal(login.user.workstation, ws, 'login payload carries the workstation (drives the floor landing page)');
  const smh = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  for (const est of [3, 2]) {
    const t = await json(await fetch(BASE + '/api/standup/task', { method: 'POST', headers: smh,
      body: JSON.stringify({ date: yesterday, description: `calibration seed ${est}h`, estHours: est, userId: maria.id }) }));
    await fetch(BASE + '/api/standup/task/' + t.id + '/complete', { method: 'POST', headers: smh });
  }
  const plan = await json(await fetch(BASE + '/api/standup?date=' + new Date().toISOString().slice(0, 10), { headers: smh }));
  const wMaria = plan.workers.find(w => w.id === maria.id);
  assert.equal(wMaria.capacity, 5.5, 'suggested load = trailing 5h/day completed × 1.1 stretch');
  assert.equal(wMaria.trailingDonePct, 100, 'trailing completion % rides along for the SM');

  // My Station: an order sitting at her station's stage, complete it from the app — no scan, no PIN.
  const model = (await json(await api('/api/models')))[0];
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Station Test Dealer', kind: 'Dealership' }) }));
  await api('/api/customers/' + cust.id + '/types', { method: 'PATCH', body: JSON.stringify({ type: model.category, on: true }) });
  const ord = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  await api('/api/orders/' + ord.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Build' }) }); // VINs auto-assign here
  const st = await json(await fetch(BASE + '/api/mystation', { headers: smh }));
  assert.equal(st.workstation, ws);
  assert.equal(st.stage, 'Build', 'station maps to its routing stage');
  const mine = st.orders.find(o => o.id === ord.id);
  assert.ok(mine && mine.units.length === 1 && mine.units[0].vin, 'station queue lists the order with its VIN');

  const done = await json(await fetch(BASE + '/u/' + mine.units[0].id + '/advance', { method: 'POST', headers: smh, body: '{}' }));
  assert.equal(done.stage, 'Paint/Powder Coat');
  assert.equal(done.as, 'Maria Chen', 'completion credited to her session, no PIN involved');

  // The per-VIN build log auto-stamped with the verified actor — what a warranty claim will show.
  const detail = await json(await api('/api/trailers/' + mine.units[0].id + '/detail'));
  const stamped = detail.buildLog.filter(s => ['Parts', 'Bending'].includes(s.step) && s.done);
  assert.equal(stamped.length, 2, 'Build completion stamped Parts + Bending on the VIN');
  for (const s of stamped) assert.equal(s.by, 'Maria Chen', 'each step attributed to the verified account');
});

test('schedules drive the plan, 60-second day verification, and the workstation registry', async () => {
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const nextDow = t => { let s = new Date().toISOString().slice(0, 10);
    do { s = addDays(s, 1); } while (new Date(s + 'T12:00:00').getDay() !== t); return s; };
  const today = new Date().toISOString().slice(0, 10);

  const users = await json(await api('/api/users'));
  const maria = users.find(u => u.username === 'mchen');
  const mr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) });
  const mlogin = await mr.json();
  const smh = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mlogin.token };

  // Self-service weekly schedule: Mon–Thu, 10-hour days (the shop standard).
  assert.equal((await fetch(BASE + '/api/users/me/schedule', { method: 'POST', headers: smh, body: JSON.stringify({ days: [] }) })).status, 400, 'empty week rejected');
  const sch = await json(await fetch(BASE + '/api/users/me/schedule', { method: 'POST', headers: smh, body: JSON.stringify({ days: [1, 2, 3, 4], hours: 10, start: '06:00' }) }));
  assert.deepEqual(sch.schedule.days, [1, 2, 3, 4]);
  assert.equal(sch.schedule.hours, 10);
  const relog = await json(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) }));
  assert.equal(relog.user.schedule.hours, 10, 'login payload carries the parsed schedule');

  // Schedule-aware assignment: a Build order planned on SATURDAY leaves her work unassigned
  // (she's Mon–Thu); the same work planned on MONDAY auto-assigns to her.
  const model = (await json(await api('/api/models')))[0];
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Schedule Test Dealer', kind: 'Dealership' }) }));
  await api('/api/customers/' + cust.id + '/types', { method: 'PATCH', body: JSON.stringify({ type: model.category, on: true }) });
  const ord = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: cust.id, modelId: model.id, qty: 1 }) }));
  await api('/api/orders/' + ord.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Build' }) });
  const sat = nextDow(6), mon = nextDow(1);
  await fetch(BASE + '/api/standup/generate', { method: 'POST', headers: smh, body: JSON.stringify({ date: sat }) });
  const satPlan = await json(await fetch(BASE + '/api/standup?date=' + sat, { headers: smh }));
  const satTask = satPlan.tasks.find(t => t.orderId === ord.id && t.stage === 'Build');
  assert.ok(satTask && satTask.userId === null, 'Saturday: her station work lands unassigned (day off)');
  assert.equal(satPlan.workers.find(w => w.id === maria.id).scheduledToday, false, 'board marks her OFF that day');
  await fetch(BASE + '/api/standup/generate', { method: 'POST', headers: smh, body: JSON.stringify({ date: mon }) });
  const monPlan = await json(await fetch(BASE + '/api/standup?date=' + mon, { headers: smh }));
  const monTask = monPlan.tasks.find(t => t.orderId === ord.id && t.stage === 'Build');
  assert.equal(monTask.userId, maria.id, 'Monday: the same work auto-assigns to her');

  // The 60-second verification: confirm the day, checking off what actually got done.
  const t = await json(await fetch(BASE + '/api/standup/task', { method: 'POST', headers: smh,
    body: JSON.stringify({ date: today, description: 'verification target', estHours: 1, userId: maria.id }) }));
  const ver = await json(await fetch(BASE + '/api/standup/verify', { method: 'POST', headers: smh,
    body: JSON.stringify({ date: today, completeIds: [t.id], note: 'waited on axles 1h' }) }));
  assert.ok(ver.verifiedAt, 'day stamped verified');
  assert.ok(ver.tasks.find(x => x.id === t.id).done, 'checked task completed via verification');
  const rep = await json(await api('/api/standup/report?days=3'));
  assert.equal(rep.find(r => r.userId === maria.id && r.date === today)?.verified, true, 'report shows the day as verified');

  // Workstation registry: add Sub-Assembly mapped to Build; it powers My Station immediately.
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  assert.equal((await fetch(BASE + '/api/workstations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await sr.json()).token }, body: JSON.stringify({ name: 'Sub-Assembly', stage: 'Build' }) })).status, 403, 'adding stations is admin-only');
  assert.equal((await api('/api/workstations', { method: 'POST', body: JSON.stringify({ name: 'Sub-Assembly', stage: 'Build' }) })).status, 200);
  assert.ok((await json(await api('/api/workstations'))).includes('Sub-Assembly'), 'station list includes the new bench');
  const prevWs = maria.workstation;
  await api('/api/users/' + maria.id, { method: 'PATCH', body: JSON.stringify({ workstation: 'Sub-Assembly' }) });
  const st = await json(await fetch(BASE + '/api/mystation', { headers: smh }));
  assert.equal(st.stage, 'Build', 'registry stage powers My Station for the new bench');
  await api('/api/users/' + maria.id, { method: 'PATCH', body: JSON.stringify({ workstation: prevWs }) }); // restore
});

test('my work: trailers by step + made parts by part number + tasks, over any window', async () => {
  const users = await json(await api('/api/users'));
  const maria = users.find(u => u.username === 'mchen');
  const mr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) });
  const smh = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await mr.json()).token };

  // Log made parts: goes into stock AND onto her record by part number; Buy parts refused.
  const part = await json(await api('/api/parts', { method: 'POST', body: JSON.stringify({ name: 'Bunkboard, Carpeted 8ft', cost: 22 }) }));
  const before = (await json(await api('/api/parts'))).find(p => p.id === part.id).onHand;
  const built = await fetch(BASE + '/api/parts/' + part.id + '/built', { method: 'POST', headers: smh, body: JSON.stringify({ qty: 3, note: 'bench run' }) });
  assert.equal(built.status, 200);
  assert.equal((await built.json()).onHand, before + 3, 'built parts entered stock');
  const buyPart = (await json(await api('/api/parts'))).find(p => p.type === 'P');
  assert.equal((await fetch(BASE + '/api/parts/' + buyPart.id + '/built', { method: 'POST', headers: smh, body: JSON.stringify({ qty: 1 }) })).status, 400, 'Buy parts are not "built"');

  // Her record (year to date by default): step completions with VIN+model, the parts, her tasks.
  const w = await json(await fetch(BASE + '/api/mywork', { headers: smh }));
  assert.equal(w.user, 'Maria Chen');
  const partsRow = w.partsBuilt.find(p => p.partId === part.id);
  assert.ok(partsRow && partsRow.qty === 3, 'made parts grouped by part number');
  const anyStep = w.steps.find(s => ['Parts', 'Bending'].includes(s.step));
  assert.ok(anyStep && anyStep.items[0].vin, 'trailer step completions listed with VINs (from her My Station completion)');
  assert.ok(w.totals.unitsTouched >= 1 && w.totals.tasksDone >= 1, 'totals aggregate steps and tasks');

  // Windows are real: a future-only range shows nothing.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const empty = await json(await fetch(BASE + '/api/mywork?from=' + tomorrow + '&to=' + tomorrow, { headers: smh }));
  assert.equal(empty.totals.partsQty + empty.totals.stepStamps + empty.totals.tasksDone, 0, 'range filters apply');

  // Only SM/GM/admin may view someone else's record.
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const salesTok = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/mywork?userId=' + maria.id, { headers: { Authorization: 'Bearer ' + salesTok } })).status, 403, 'peers cannot browse each other');
  const asMgr = await json(await fetch(BASE + '/api/mywork?userId=' + users.find(u => u.username === 'aruiz').id, { headers: smh }));
  assert.equal(asMgr.user, 'Angela Ruiz', 'Shop Manager can review any employee');
});

test('time survey: triggers on accumulated work, collects minutes, audits BOM labor + part costs', async () => {
  const mr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'mchen', password: 'built2026' }) });
  const smh = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await mr.json()).token };

  // Maria's unsurveyed work so far: 2 build-step stamps + 1 made-parts entry = 3 ≥ threshold(3).
  const p = await json(await fetch(BASE + '/api/timesurvey/pending', { headers: smh }));
  assert.equal(p.due, true, 'enough accumulated work triggers the survey');
  const stageLine = p.stages.find(s => s.stage === 'Build');
  assert.ok(stageLine && stageLine.stepIds.length >= 2, 'welded work grouped per order-stage');
  assert.ok(stageLine.prefillMinutes > 0, 'prefilled from the BOM routing');
  assert.match(stageLine.description, /Welded/i, 'reads like a human wrote it');
  const partLine = p.parts.find(x => x.qty === 3);
  assert.ok(partLine, 'the bunkboard build is listed');

  // Fill it out: welded 1.5h, bunkboards 45m, plus an "other" line.
  const sub = await fetch(BASE + '/api/timesurvey', { method: 'POST', headers: smh, body: JSON.stringify({ lines: [
    { kind: 'stage', stepIds: stageLine.stepIds, orderId: stageLine.orderId, stage: stageLine.stage,
      modelId: stageLine.modelId, qty: stageLine.units, description: stageLine.description, minutes: 90 },
    { kind: 'part', logId: partLine.logId, description: partLine.description, minutes: 45 },
    { kind: 'other', description: 'shop cleanup', minutes: 30 },
  ] }) });
  assert.equal(sub.status, 200);
  assert.equal((await sub.json()).totalMinutes, 165, 'all hours accounted');

  // Asked exactly once: nothing pending anymore.
  const p2 = await json(await fetch(BASE + '/api/timesurvey/pending', { headers: smh }));
  assert.equal(p2.due, false);
  assert.equal(p2.stages.length + p2.parts.length, 0, 'covered items are stamped');

  // The payoff: actuals vs BOM by model+stage, and made-part minutes -> implied labor cost.
  const acc = await json(await api('/api/labor-accuracy'));
  const st = acc.byStage.find(s => s.modelId === stageLine.modelId && s.stage === 'Build');
  assert.ok(st, 'stage accuracy row exists');
  assert.equal(st.actualHoursPerUnit, 1.5, '90 min / 1 unit = 1.5h actual');
  assert.ok(st.bomHoursPerUnit > 0 && st.variancePct != null, 'compared against the routing');
  const pt = acc.byPart.find(x => x.partId === partLine.partId);
  assert.equal(pt.minutesPerUnit, 15, '45 min / 3 units');
  assert.ok(pt.impliedLaborPerUnit > 0 && typeof pt.currentCost === 'number', 'implied labor $ vs current part cost');

  // Section-gated like the rest of Performance.
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  assert.equal((await fetch(BASE + '/api/labor-accuracy', { headers: { Authorization: 'Bearer ' + (await sr.json()).token } })).status, 403);
});

test('order timeline: placed + stage completions with names and shop-floor initials', async () => {
  const unit = (await json(await api('/api/search?q=BLTTESTVIN0000099'))).units[0];
  const o = await json(await api('/api/orders/' + unit.orderId));
  assert.ok(Array.isArray(o.timeline) && o.timeline.length >= 2, 'timeline present');
  assert.equal(o.timeline[0].event, 'Order placed', 'starts at order placement');
  assert.ok(o.timeline.some(t => /complete$/.test(t.event)), 'stage completions listed');
  const floor = o.timeline.find(t => t.by === 'shop floor: JT');
  assert.ok(floor, 'the QR-scan stage completion carries the worker initials');
});

test('backup: admin-only, dumps every table to a gzipped rolling file', async () => {
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/admin/backup/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: '{}' })).status, 403, 'backup is admin-only');
  const r = await json(await api('/api/admin/backup/run', { method: 'POST', body: '{}' }));
  assert.equal(r.ok, true);
  assert.equal(r.destination, 'local', 'no R2 in tests -> local fallback');
  assert.ok(r.tables >= 30 && r.rows > 100, `dumped the whole database (${r.tables} tables, ${r.rows} rows)`);
  assert.match(r.key, /builttrailers-daily-\d\d\.json\.gz$/, 'rolling day-of-month filename');
  assert.ok(existsSync(r.key), 'backup file actually written');
  assert.ok(r.warning, 'local copy warns it is not off-site');
});

test('customer merge: repoints orders + backfills details + deletes the duplicate; gated', async () => {
  // Two customers — the duplicate holds an order, an authorized type, and an address.
  const dup = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Merge Dup Co', kind: 'Dealership', address: '1 Dup St', city: 'Provo', state: 'UT', zip: '84601' }) }));
  const survivor = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Merge Survivor Co', kind: 'Dealership' }) }));
  const model = (await json(await api('/api/models')))[0];
  await api('/api/customers/' + dup.id + '/types', { method: 'PATCH', body: JSON.stringify({ type: model.category, on: true }) });
  const order = await json(await api('/api/orders', { method: 'POST', body: JSON.stringify({ customerId: dup.id, modelId: model.id, qty: 1 }) }));
  assert.ok(order.id, 'order created for the duplicate');

  // Gates: sales can't merge; self-merge and missing target rejected.
  const sr = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) });
  const sales = (await sr.json()).token;
  assert.equal((await fetch(BASE + '/api/customers/' + dup.id + '/merge', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sales }, body: JSON.stringify({ into: survivor.id }) })).status, 403, 'sales cannot merge');
  assert.equal((await api('/api/customers/' + dup.id + '/merge', { method: 'POST', body: JSON.stringify({ into: dup.id }) })).status, 400, 'self-merge rejected');
  assert.equal((await api('/api/customers/' + dup.id + '/merge', { method: 'POST', body: '{}' })).status, 400, 'missing target rejected');

  // The merge itself.
  const r = await api('/api/customers/' + dup.id + '/merge', { method: 'POST', body: JSON.stringify({ into: survivor.id }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).moved.orders, 1, 'one order repointed');

  const customers = await json(await api('/api/customers'));
  assert.ok(!customers.find(c => c.id === dup.id), 'duplicate deleted');
  const kept = customers.find(c => c.id === survivor.id);
  assert.equal(kept.address, '1 Dup St', 'missing details backfilled from the duplicate');
  assert.ok(kept.allowed.includes(model.category), 'authorized trailer types carried over');
  const movedOrder = await json(await api('/api/orders/' + order.id));
  assert.equal(movedOrder.customer, 'Merge Survivor Co', 'order now belongs to the survivor');
  assert.equal((await api('/api/customers/' + dup.id + '/merge', { method: 'POST', body: JSON.stringify({ into: survivor.id }) })).status, 404, 'merged-away customer is gone');
});

test('traveler: build sheet returns unit data + a QR, and /u/:id resolves the unit', async () => {
  const tr = await api(`/api/trailers/${vinUnitId}/traveler`);
  assert.equal(tr.status, 200);
  const d = await tr.json();
  assert.equal(d.unitId, vinUnitId);
  assert.ok(d.qr && d.qr.startsWith('data:image'), 'QR data URL present');
  assert.ok(Array.isArray(d.stagesDone), 'build stages included');
  const pu = await fetch(BASE + `/u/${vinUnitId}`);
  assert.equal(pu.status, 200);
  assert.match(await pu.text(), /BUILT/, 'public unit page renders');
});

test('boat builder: catalog seeds Nautique boats + option groups (idempotent at boot)', async () => {
  const cat = await json(await api('/api/boat-catalog'));
  assert.ok(cat.makes.some(m => m.name === 'Nautique'), 'Nautique make seeded');
  const g23 = cat.boats.find(b => b.id === 'NQ-G23');
  assert.ok(g23 && g23.base_model_id === 'G23TR', 'G23 maps to base trailer G23TR');
  const brakes = cat.groups.find(g => g.id === 'brakes');
  assert.ok(brakes && brakes.choices.find(c => c.id === 'brk_eoh' && c.is_default), 'EOH is the default brake');
  assert.equal(cat.groups.find(g => g.id === 'wheels').choices.length, 3, 'three wheel choices');
  const flake = cat.groups.find(g => g.id === 'paint_color').choices.find(c => /metal flake/i.test(c.name));
  assert.ok(flake.parts.some(p => p.part_id === 'BUY-FLK-001'), 'a flake color adds the flake additive part');
});

test('boat builder: validate, reconcile BOM (no double-count), and submit', async () => {
  const full = { axle_count: 'ac_triple', axle_type: 'axle_torsion', brakes: 'brk_eoh', paint_style: 'paint_single', paint_color: 'color_mystic_white', wheels: 'wheel_std', fender_style: 'fender_squared', winch: 'winch_dl_single', winch_stand: 'winch_f2' };
  // missing required selections → invalid
  let r = await json(await api('/api/boat-build/preview', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G23', selections: {} }) }));
  assert.equal(r.ok, false, 'empty config is invalid');
  // axle count follows the boat: a single axle on a 23 ft boat is rejected
  assert.equal((await json(await api('/api/boat-build/preview', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G23', selections: { ...full, axle_count: 'ac_single' } }) }))).ok, false, 'single axle invalid on a 23ft boat');
  // full config → valid; G23's base trailer is already torsion, so torsion adds NO axle delta
  r = await json(await api('/api/boat-build/preview', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G23', selections: full }) }));
  assert.equal(r.ok, true, 'full config valid');
  assert.ok(!r.bom.deltas.find(d => d.part_id === 'BUY-AXL-3500T'), 'no torsion delta when base is already torsion');
  assert.ok(r.bom.deltas.find(d => d.part_id === 'BUY-BRK-EOH' && d.qty === 1), 'EOH brake kit added (base has no brakes)');
  assert.ok(r.bom.deltas.find(d => d.part_id === 'BUY-WNC-DLS' && d.qty === 1), 'DL single-speed winch added');
  assert.ok(r.bom.deltas.find(d => d.part_id === 'BUY-WNC-002' && d.qty === -1), 'base strap winch swapped out for the DL winch');
  // GS20 base is sprung → choosing torsion swaps the axle parts out
  const g = await json(await api('/api/boat-build/preview', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-GS20', selections: { ...full, axle_count: 'ac_tandem' } }) }));
  assert.ok(g.bom.deltas.find(d => d.part_id === 'BUY-AXL-3500T' && d.qty === 1), 'GS20 gains a torsion axle');
  assert.ok(g.bom.deltas.find(d => d.part_id === 'BUY-AXL-3500' && d.qty === -1), 'GS20 drops the sprung axle');
  assert.ok(g.bom.deltas.find(d => d.part_id === 'BUY-SPR-3500' && d.qty === -2), 'GS20 drops the leaf springs');
  // two-tone without a fender color → invalid
  const tt = await json(await api('/api/boat-build/preview', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G23', selections: { ...full, paint_style: 'paint_twotone' } }) }));
  assert.equal(tt.ok, false, 'two-tone requires a fender color');
  // submit creates a Quote order
  const s = await json(await api('/api/boat-build/submit', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G23', year: 2025, qty: 1, selections: full }) }));
  assert.ok(s.orderId && s.orderId.startsWith('SO-'), 'configured order created');
});

test('boat builder: dealer configurator endpoints require dealer auth', async () => {
  assert.equal((await fetch(BASE + '/api/dealer/boat-catalog')).status, 401, 'dealer catalog needs auth');
  assert.equal((await fetch(BASE + '/api/dealer/boat-build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'dealer submit needs auth');
  assert.equal((await fetch(BASE + '/api/dealer/orders/SO-1/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'dealer withdraw needs auth');
  assert.equal((await fetch(BASE + '/api/dealer/orders/SO-1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'dealer edit needs auth');
});

test('boat builder: order spec returns the config + resolved BOM (production view)', async () => {
  const full = { axle_count: 'ac_tandem', axle_type: 'axle_torsion', brakes: 'brk_disc', paint_style: 'paint_single', paint_color: 'color_jet_black', wheels: 'wheel_prem', fender_style: 'fender_squared', winch: 'winch_dl_dual', winch_stand: 'winch_f2', nonskid_mat: 'mat_titanium' };
  const s = await json(await api('/api/boat-build/submit', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-GS20', year: 2025, qty: 1, selections: full }) }));
  const spec = await json(await api('/api/orders/' + s.orderId + '/build'));
  assert.equal(spec.boat_model, 'Super Air Nautique GS20');
  assert.ok(spec.options.find(o => o.choice_name === 'Disc'), 'chosen options captured');
  assert.ok(spec.bom.find(p => p.part_id === 'BUY-WHL-PREM'), 'premium wheels in resolved BOM');
  assert.ok(spec.bom.find(p => p.part_id === 'BUY-BRK-DISC'), 'disc brakes in resolved BOM');
  assert.ok(!spec.bom.find(p => p.part_id === 'BUY-WHL-001'), 'standard wheels swapped out of the BOM');
  assert.ok(spec.bom.find(p => p.part_id === 'BUY-MAT-TIGREY'), 'chosen non-skid mat in the resolved BOM');
});

test('orders: edit details, reject + restore, and re-configure a boat build', async () => {
  const sel = { axle_count: 'ac_triple', axle_type: 'axle_sprung', brakes: 'brk_eoh', paint_style: 'paint_single', paint_color: 'color_mystic_white', wheels: 'wheel_std', fender_style: 'fender_squared', winch: 'winch_dl_single', winch_stand: 'winch_f2' };
  const oid = (await json(await api('/api/boat-build/submit', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G25', year: 2026, qty: 1, selections: sel }) }))).orderId;
  // edit details
  assert.equal((await api('/api/orders/' + oid, { method: 'PATCH', body: JSON.stringify({ due: '2026-09-01', note: 'rush' }) })).status, 200);
  assert.equal((await json(await api('/api/orders/' + oid))).note, 'rush', 'note saved');
  // re-configure: standard -> premium wheels lands in the resolved BOM
  await api('/api/orders/' + oid + '/boat-build', { method: 'POST', body: JSON.stringify({ selections: { ...sel, wheels: 'wheel_prem' } }) });
  assert.ok((await json(await api('/api/orders/' + oid + '/build'))).bom.find(p => p.part_id === 'BUY-WHL-PREM'), 're-config updated the BOM');
  // reject -> off the board, then restore -> back to Quote
  assert.equal((await api('/api/orders/' + oid + '/cancel', { method: 'POST', body: JSON.stringify({ reason: 'test reject' }) })).status, 200);
  const cancelled = await json(await api('/api/orders/' + oid));
  assert.equal(cancelled.stage, 'Cancelled');
  assert.equal(cancelled.cancelReason, 'test reject');
  assert.equal((await json(await api('/api/orders/' + oid + '/uncancel', { method: 'POST' }))).stage, 'Quote', 'restored to Quote');
});

test('public dealer feed: token-gated, returns only public-safe fields', async () => {
  assert.equal((await fetch(BASE + '/api/public/dealers')).status, 401, 'no token rejected');
  assert.equal((await fetch(BASE + '/api/public/dealers', { headers: { Authorization: 'Bearer nope' } })).status, 401, 'wrong token rejected');
  const r = await fetch(BASE + '/api/public/dealers', { headers: { Authorization: 'Bearer test-feed-token' } });
  assert.equal(r.status, 200, 'correct token accepted');
  const body = await r.json();
  assert.ok(Array.isArray(body.dealers) && body.dealers.length >= 1, 'returns { dealers: [...] }');
  const d = body.dealers[0];
  for (const f of ['name', 'address', 'city', 'state', 'zip', 'phone', 'lat', 'lng', 'status']) assert.ok(f in d, 'includes ' + f);
  assert.equal(d.status, 'active');
  for (const f of ['contact', 'rep_id', 'rep', 'id', 'is_test', 'kind']) assert.ok(!(f in d), 'no internal field ' + f);
});

test('dealer signup now requires a dealership address', async () => {
  const r = await fetch(BASE + '/api/dealer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'noaddr@x.test', password: 'secret1', name: 'No Addr', dealershipName: 'No Addr Co' }) });
  assert.equal(r.status, 400, 'missing address rejected');
  assert.match((await r.json()).error, /address/i);
});

test('dealer: forgot-password always returns ok (no account enumeration)', async () => {
  const known = await fetch(BASE + '/api/dealer/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'noaddr@x.test' }) });
  const unknown = await fetch(BASE + '/api/dealer/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@nowhere.test' }) });
  assert.equal(known.status, 200); assert.equal(unknown.status, 200);
  assert.equal((await known.json()).ok, true); assert.equal((await unknown.json()).ok, true);
});

test('dealer: reset with an invalid token is rejected', async () => {
  const r = await fetch(BASE + '/api/dealer/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'bogus-token', password: 'newpass12' }) });
  assert.equal(r.status, 400);
});

test('dealer: logged-in change-password rejects wrong current password, then works', async () => {
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'CP Test Dealership', kind: 'Dealership' }) }));
  await fetch(BASE + '/api/dealer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'cptest@x.test', password: 'origPw1', name: 'CP Test', dealershipName: 'CP Test Dealership', address: '1 Main St', city: 'Provo', state: 'UT', zip: '84601' }) });
  const pending = await json(await api('/api/dealers/pending'));
  const signup = pending.find(d => d.email === 'cptest@x.test');
  await api('/api/dealers/' + signup.id + '/approve', { method: 'POST', body: JSON.stringify({ customerId: cust.id }) });
  const login = await json(await fetch(BASE + '/api/dealer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'cptest@x.test', password: 'origPw1' }) }));
  const dHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const wrong = await fetch(BASE + '/api/dealer/change-password', { method: 'POST', headers: dHeaders, body: JSON.stringify({ currentPassword: 'nope', newPassword: 'newPw123' }) });
  assert.equal(wrong.status, 400, 'wrong current password rejected');
  const ok = await fetch(BASE + '/api/dealer/change-password', { method: 'POST', headers: dHeaders, body: JSON.stringify({ currentPassword: 'origPw1', newPassword: 'newPw123' }) });
  assert.equal(ok.status, 200);
  const oldLogin = await fetch(BASE + '/api/dealer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'cptest@x.test', password: 'origPw1' }) });
  assert.equal(oldLogin.status, 401, 'old password no longer works');
  const newLogin = await fetch(BASE + '/api/dealer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'cptest@x.test', password: 'newPw123' }) });
  assert.equal(newLogin.status, 200, 'new password works');
});

test('dealer stock: list, request, staff approve sells the order and declines rivals', async () => {
  // Two dealerships authorized for the same trailer type, both wanting the same stock build.
  const models = await json(await api('/api/models'));
  const model = models[0];
  const mkDealer = async (n) => {
    const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: `Stock Test Dealership ${n}`, kind: 'Dealership', allowed: [model.category] }) }));
    await fetch(BASE + '/api/dealer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `stock${n}@x.test`, password: 'stockPw1', name: `Stock ${n}`, dealershipName: `Stock Test Dealership ${n}`, address: '1 Main St', city: 'Provo', state: 'UT', zip: '84601' }) });
    const signup = (await json(await api('/api/dealers/pending'))).find(d => d.email === `stock${n}@x.test`);
    await api('/api/dealers/' + signup.id + '/approve', { method: 'POST', body: JSON.stringify({ customerId: cust.id }) });
    const login = await json(await fetch(BASE + '/api/dealer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `stock${n}@x.test`, password: 'stockPw1' }) }));
    return { cust, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token } };
  };
  const d1 = await mkDealer(1), d2 = await mkDealer(2);

  // One stock build finished (Ready — no units yet, so the QC gate passes trivially), one still queued.
  const ready = await json(await api('/api/orders/stock', { method: 'POST', body: JSON.stringify({ modelId: model.id, qty: 1 }) }));
  await api('/api/orders/' + ready.id + '/stage', { method: 'PATCH', body: JSON.stringify({ stage: 'Ready' }) });
  const coming = await json(await api('/api/orders/stock', { method: 'POST', body: JSON.stringify({ modelId: model.id, qty: 2, due: '2026-11-01' }) }));

  const list = await json(await fetch(BASE + '/api/dealer/stock', { headers: d1.headers }));
  assert.ok(list.available.find(x => x.id === ready.id), 'finished stock build listed as available now');
  assert.ok(list.coming.find(x => x.id === coming.id), 'queued stock build listed as coming soon');

  // Both dealers request the finished one; duplicates rejected.
  assert.equal((await fetch(BASE + '/api/dealer/stock/' + ready.id + '/request', { method: 'POST', headers: d1.headers, body: JSON.stringify({ note: 'we have a buyer' }) })).status, 200);
  assert.equal((await fetch(BASE + '/api/dealer/stock/' + ready.id + '/request', { method: 'POST', headers: d1.headers, body: '{}' })).status, 400, 'duplicate request rejected');
  assert.equal((await fetch(BASE + '/api/dealer/stock/' + ready.id + '/request', { method: 'POST', headers: d2.headers, body: '{}' })).status, 200, 'a second dealership may also request');
  assert.equal((await json(await fetch(BASE + '/api/dealer/stock', { headers: d1.headers }))).available.find(x => x.id === ready.id).requested, true, 'dealer sees their pending request');

  // Staff approve dealership 1 — order sells to them, dealership 2's request auto-declines.
  const reqs = await json(await api('/api/stock-requests'));
  const winner = reqs.find(r => r.orderId === ready.id && r.dealership === 'Stock Test Dealership 1');
  assert.ok(winner, 'staff see the pending request with the dealership named');
  assert.equal((await api('/api/stock-requests/' + winner.id + '/decide', { method: 'POST', body: JSON.stringify({ action: 'approve' }) })).status, 200);
  const mine = await json(await fetch(BASE + '/api/dealer/orders', { headers: d1.headers }));
  assert.ok(mine.find(o => o.id === ready.id), 'order now shows in dealership 1\'s own orders');
  assert.equal((await json(await api('/api/stock-requests'))).filter(r => r.orderId === ready.id).length, 0, 'rival request auto-declined');
  assert.ok(!(await json(await fetch(BASE + '/api/dealer/stock', { headers: d2.headers }))).available.find(x => x.id === ready.id), 'sold unit gone from the other dealership\'s stock list');

  // The buyer can now track it: full stage ladder with Ready current.
  const prog = await json(await fetch(BASE + '/api/dealer/orders/' + ready.id + '/progress', { headers: d1.headers }));
  assert.equal(prog.steps.length, 6, 'six-stage ladder');
  const last = prog.steps[prog.steps.length - 1];
  assert.equal(last.stage, 'Ready');
  assert.ok(last.current && last.done && last.at, 'Ready is current, stamped with a date');
  assert.ok(prog.steps.slice(0, 5).every(s => s.done), 'earlier stages render as done');
  // ...and the other dealership cannot see someone else's order progress.
  assert.equal((await fetch(BASE + '/api/dealer/orders/' + ready.id + '/progress', { headers: d2.headers })).status, 404, 'progress is scoped to the owning dealership');
});

test('staff: reset a dealer login\'s password from Customers & Dealers (admin-assist)', async () => {
  const cust = await json(await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Admin Reset Dealership', kind: 'Dealership' }) }));
  await fetch(BASE + '/api/dealer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'adminreset@x.test', password: 'origPw1', name: 'AR Test', dealershipName: 'Admin Reset Dealership', address: '1 Main St', city: 'Provo', state: 'UT', zip: '84601' }) });
  const pending = await json(await api('/api/dealers/pending'));
  const signup = pending.find(d => d.email === 'adminreset@x.test');
  await api('/api/dealers/' + signup.id + '/approve', { method: 'POST', body: JSON.stringify({ customerId: cust.id }) });
  const accts = await json(await api('/api/customers/' + cust.id + '/dealer-accounts'));
  assert.equal(accts.length, 1, 'one login for this dealership');
  assert.equal(accts[0].email, 'adminreset@x.test');
  const reset = await api('/api/dealer-accounts/' + accts[0].id + '/reset-password', { method: 'POST', body: JSON.stringify({ password: 'staffSetPw1' }) });
  assert.equal(reset.status, 200);
  const oldLogin = await fetch(BASE + '/api/dealer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'adminreset@x.test', password: 'origPw1' }) });
  assert.equal(oldLogin.status, 401, 'old password no longer works');
  const newLogin = await fetch(BASE + '/api/dealer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'adminreset@x.test', password: 'staffSetPw1' }) });
  assert.equal(newLogin.status, 200, 'staff-set password works');
});

test('boat builder admin: office price edit flows into the catalog + pricing; boat remap; gated', async () => {
  await api('/api/boat-admin/price', { method: 'POST', body: JSON.stringify({ choiceId: 'wheel_prem', dealerPrice: 800 }) });
  const cat = await json(await api('/api/boat-catalog'));
  assert.equal(Number(cat.groups.find(g => g.id === 'wheels').choices.find(c => c.id === 'wheel_prem').dealer_price), 800, 'price persisted');
  const sel = { axle_count: 'ac_triple', axle_type: 'axle_sprung', brakes: 'brk_eoh', paint_style: 'paint_single', paint_color: 'color_mystic_white', wheels: 'wheel_prem', fender_style: 'fender_squared', winch: 'winch_dl_single', winch_stand: 'winch_f2' };
  const pv = await json(await api('/api/boat-build/preview', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G23', selections: sel }) }));
  assert.equal(pv.price.total, Number(pv.price.base) + 800, 'premium-wheel upcharge reflected in the quoted price');
  await api('/api/boat-admin/boat', { method: 'POST', body: JSON.stringify({ boatId: 'NQ-G21', baseModelId: 'GS24TR' }) });
  const cat2 = await json(await api('/api/boat-catalog'));
  assert.equal(cat2.boats.find(b => b.id === 'NQ-G21').base_model_id, 'GS24TR', 'boat base trailer remapped');
  const salesTok = (await json(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) }))).token;
  assert.equal((await fetch(BASE + '/api/boat-admin/price', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + salesTok }, body: '{}' })).status, 403, 'sales blocked from boat-builder settings');
});

test('test mode: provision flags accounts, wipe is failproof + scoped, admin-gated', async () => {
  const acc = await json(await api('/api/admin/test-accounts', { method: 'POST' }));
  assert.ok(acc.dealer.email && acc.dealer.password && acc.owner.email && acc.owner.password, 'test creds returned');
  let st = await json(await api('/api/admin/test-data'));
  assert.ok(st.customers >= 1 && st.dealers >= 1 && st.owners >= 1, 'accounts flagged as test');
  assert.equal((await fetch(BASE + '/api/admin/test-data/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}' })).status, 400, 'wipe needs the confirm token');
  const w = (await json(await api('/api/admin/test-data/wipe', { method: 'POST', body: JSON.stringify({ confirm: 'WIPE' }) }))).wiped;
  assert.ok(w.customers >= 1, 'test dealership wiped');
  assert.equal(w.orders, 0, 'no real orders touched — wipe is scoped to test data only');
  st = await json(await api('/api/admin/test-data'));
  assert.equal(st.customers + st.dealers + st.owners, 0, 'all test accounts gone after wipe');
  const salesTok = (await json(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'aruiz', password: 'built2026' }) }))).token;
  assert.equal((await fetch(BASE + '/api/admin/test-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + salesTok }, body: '{}' })).status, 403, 'non-admin blocked from test mode');
});

test('stock build: VIN still prints, but the MSO is held until the trailer is sold', async () => {
  const custs = (await json(await api('/api/customers'))).filter(c => c.active !== false && c.allowed?.length);
  const models = await json(await api('/api/models'));
  let cu, mo;
  for (const c of custs) { const m = models.find(mm => c.allowed.includes(mm.category)); if (m) { cu = c; mo = m; break; } }
  // build to stock (no customer)
  const sid = (await json(await api('/api/orders/stock', { method: 'POST', body: JSON.stringify({ modelId: mo.id, qty: 1, due: '2026-12-22' }) }))).id;
  for (const st of ['Build', 'Paint/Powder Coat', 'Finish'])
    await api(`/api/orders/${sid}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: st }) });
  let vinQ = await json(await api('/api/print-queue?kind=vin'));
  let msoQ = await json(await api('/api/print-queue?kind=mso'));
  assert.ok(vinQ.some(j => j.orderId === sid), 'VIN print queues for a stock build');
  assert.ok(!msoQ.some(j => j.orderId === sid), 'MSO is HELD for a stock build (no customer)');
  // sold: assign an authorized customer → MSO releases
  const sold = await api(`/api/orders/${sid}/customer`, { method: 'POST', body: JSON.stringify({ customerId: cu.id }) });
  assert.equal(sold.status, 200);
  assert.ok((await sold.json()).msosQueued >= 1, 'selling releases the MSO');
  msoQ = await json(await api('/api/print-queue?kind=mso'));
  assert.ok(msoQ.some(j => j.orderId === sid), 'MSO is queued once the stock trailer is sold');
});

// ---- Cycle counts ----
const partOnHand = async id => Number((await json(await api('/api/parts'))).find(x => x.id === id).onHand);
test('cycle count: pending until approved, then applies on-hand and posts the adjustment', async () => {
  const parts = await json(await api('/api/parts'));
  const p = parts[0];
  const before = Number(p.onHand);
  const counted = before + 7;
  const cc = await json(await api('/api/cycle-counts', { method: 'POST', body: JSON.stringify({ lines: [{ partId: p.id, countedQty: counted }], note: 'aisle 3' }) }));
  assert.ok(cc.id && cc.status === 'pending', 'count created pending');
  assert.equal(await partOnHand(p.id), before, 'on-hand UNCHANGED while pending');
  const ap = await api(`/api/cycle-counts/${cc.id}/approve`, { method: 'POST' });
  assert.equal(ap.status, 200);
  assert.equal((await ap.json()).status, 'posted');
  assert.equal(await partOnHand(p.id), counted, 'on-hand applied only on approval');
});

test('cycle count: reject leaves inventory unchanged', async () => {
  const p = (await json(await api('/api/parts')))[1];
  const before = Number(p.onHand);
  const cc = await json(await api('/api/cycle-counts', { method: 'POST', body: JSON.stringify({ lines: [{ partId: p.id, countedQty: before + 100 }] }) }));
  assert.equal((await api(`/api/cycle-counts/${cc.id}/reject`, { method: 'POST', body: JSON.stringify({ note: 'recount needed' }) })).status, 200);
  assert.equal(await partOnHand(p.id), before, 'on-hand unchanged after reject');
});

test('permissions: cycle counts (ops/managers) and stock orders (Sales/office) are gated', async () => {
  const tok = async u => (await (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: 'built2026' }) })).json()).token;
  const H = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const sales = await tok('aruiz');     // Sales
  const rep = await tok('mtran');       // Rep Specialist
  const office = await tok('dolsen');   // Office Manager
  const shop = await tok('tgalloway');  // Shop Specialist
  const models = await json(await api('/api/models'));
  // cycle count: Sales (not shop/office) is blocked from creating + approving
  assert.equal((await fetch(BASE + '/api/cycle-counts', { method: 'POST', headers: H(sales), body: '{"lines":[]}' })).status, 403, 'sales cannot create a cycle count');
  assert.equal((await fetch(BASE + '/api/cycle-counts/1/approve', { method: 'POST', headers: H(sales) })).status, 403, 'sales cannot approve');
  // the Shop Specialist can create a count
  const parts = await json(await api('/api/parts'));
  assert.equal((await fetch(BASE + '/api/cycle-counts', { method: 'POST', headers: H(shop), body: JSON.stringify({ lines: [{ partId: parts[0].id, countedQty: 1 }] }) })).status, 200, 'shop specialist can create a count');
  // stock orders: Rep Specialist no longer allowed; Office Manager is
  assert.equal((await fetch(BASE + '/api/orders/stock', { method: 'POST', headers: H(rep), body: JSON.stringify({ modelId: models[0].id, qty: 1 }) })).status, 403, 'rep specialist cannot create stock orders');
  assert.equal((await fetch(BASE + '/api/orders/stock', { method: 'POST', headers: H(office), body: JSON.stringify({ modelId: models[0].id, qty: 1 }) })).status, 200, 'office manager can create stock orders');
});
