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
  LOGIN_RATE_MAX: '100000', PORTAL_RATE_MAX: '100000', DEALER_FEED_TOKEN: 'test-feed-token', GEOCODE_DISABLED: '1',
  BACKUP_DIR: path.join(tmpdir(), 'bt-smoke-backups') };

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

  // Page now offers the action; wrong PIN 401; right PIN advances Finish -> Ready
  page = await (await fetch(BASE + '/u/' + unit.id)).text();
  assert.match(page, /Mark Finish complete/i, 'action button rendered for the current stage');
  const bad = await fetch(BASE + '/u/' + unit.id + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0000', worker: 'JT' }) });
  assert.equal(bad.status, 401, 'wrong PIN rejected');
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
