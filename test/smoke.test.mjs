// Smoke tests for the critical paths: login, order → production → invoice, inventory
// valuation, parts, roles, and the QuickBooks cost preview. Boots the REAL server against a
// throwaway PGlite database (no external services), so a regression on any of these shows up
// in seconds. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_PORT || 4599);
const BASE = `http://localhost:${PORT}`;
// Hermetic env: simulated accounting, no SMS, no QuickBooks creds — tests never touch a
// real external service regardless of what's in .env.
const HERMETIC = { PORT: String(PORT), ACCOUNTING_MODE: 'simulated', SMS_ENABLED: '0',
  QBO_CLIENT_ID: '', QBO_CLIENT_SECRET: '', JWT_SECRET: 'test-secret-smoke' };

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
