// Live QuickBooks Online connector — OAuth2 refresh-token flow + Invoice/Bill creation.
// Activated when ACCOUNTING_MODE=quickbooks and the QBO_* env vars are set. Until then the
// app stays in simulated mode (see accounting.js). Uses Node 20+ global fetch.
import 'dotenv/config';
import crypto from 'crypto';
import { q, one, all } from './db.js';
import { captureError } from './observability.js';

// Thrown for any Intuit auth/authorization failure so callers can prompt reconnect
export class QBOAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'QBOAuthError'; this.qboAuth = true; }
}

// Thrown when the QB feature is unavailable in the user's subscription tier
export class QBOFeatureError extends Error {
  constructor(msg, feature) { super(msg); this.name = 'QBOFeatureError'; this.qboFeature = true; this.feature = feature || null; }
}

const API_BASE  = (process.env.QBO_ENV === 'production')
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';
const MINOR = '73';

// ---- Intuit discovery document (fetched once, cached for 24 h) ----
const DISCOVERY_URL = 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration';
const DISCOVERY_URL_PROD = 'https://developer.api.intuit.com/.well-known/openid_configuration';
let discoveryCache = null;
let discoveryExp = 0;
async function discovery() {
  if (discoveryCache && Date.now() < discoveryExp) return discoveryCache;
  const url = (process.env.QBO_ENV === 'production') ? DISCOVERY_URL_PROD : DISCOVERY_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Intuit discovery fetch failed ${res.status}`);
  discoveryCache = await res.json();
  discoveryExp = Date.now() + 24 * 60 * 60 * 1000;
  return discoveryCache;
}
async function authorizationEndpoint() { return (await discovery()).authorization_endpoint; }
async function tokenEndpoint()         { return (await discovery()).token_endpoint; }
async function revocationEndpoint()    { return (await discovery()).revocation_endpoint; }

// ---- config table (auto-created; stores rotating refresh token) ----
let configTableReady = false;
async function ensureConfigTable() {
  if (configTableReady) return;
  await q(`CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    ts    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`, []);
  configTableReady = true;
}
async function getConfig(key) {
  try {
    await ensureConfigTable();
    return (await one('SELECT value FROM config WHERE key=$1', [key]))?.value ?? null;
  } catch { return null; }
}
async function setConfig(key, value) {
  try {
    await ensureConfigTable();
    await q(`INSERT INTO config(key,value,ts) VALUES ($1,$2,now())
             ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, ts=now()`, [key, value]);
  } catch {}
}

// Returns true when env vars are present — the initial requirement before any token rotation
export function qboConfigured() {
  return !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET &&
            process.env.QBO_REALM_ID  && process.env.QBO_REFRESH_TOKEN);
}

// ---- OAuth2 authorization flow (one-time admin setup) ----
export async function getAuthUrl(redirectUri) {
  const state = crypto.randomBytes(16).toString('hex');
  await setConfig('qbo_oauth_state', state);  // persisted so server restarts don't break CSRF check
  const endpoint = await authorizationEndpoint();
  return `${endpoint}?${new URLSearchParams({
    client_id:     process.env.QBO_CLIENT_ID,
    scope:         'com.intuit.quickbooks.accounting',
    redirect_uri:  redirectUri,
    response_type: 'code',
    state,
  })}`;
}

export async function exchangeCode(code, redirectUri, state, realmId) {
  const savedState = await getConfig('qbo_oauth_state');
  if (!savedState) throw new Error('No OAuth state found — restart the authorization flow');
  if (state !== savedState) throw new Error('State mismatch — possible CSRF attack; restart the authorization flow');
  await setConfig('qbo_oauth_state', '');  // consume immediately to prevent replay

  const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(await tokenEndpoint(), {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  if (!res.ok) { const b = await res.text(); throw new Error(parseQBOFault(b, `QBO token exchange ${res.status}: ${b}`)); }
  const j = await res.json();
  await setConfig('qbo_refresh_token', j.refresh_token);
  // Capture the company you just authorized so it becomes the active realm automatically.
  if (realmId) await setConfig('qbo_realm_id', String(realmId));
  return { refreshToken: j.refresh_token, accessToken: j.access_token };
}

// ---- Token management ----
let tokenCache = { access: null, exp: 0 };
let refreshInFlight = null; // single-flight guard so concurrent calls share one token refresh

async function activeRefreshToken() {
  return (await getRefreshTokenInfo()).token;
}

// Where the live refresh token comes from — the rotating DB copy first, the env var only
// as a seed fallback. Exported so the /api/qbo/test diagnostic checks the SAME token the
// app actually uses, instead of only the static env var.
export async function getRefreshTokenInfo() {
  const dbTok = await getConfig('qbo_refresh_token');
  if (dbTok) return { token: dbTok, source: 'db' };
  if (process.env.QBO_REFRESH_TOKEN) return { token: process.env.QBO_REFRESH_TOKEN, source: 'env' };
  return { token: null, source: 'none' };
}

// The active QuickBooks company (realm). Prefers the realm captured during OAuth (DB)
// over the QBO_REALM_ID env var, so whatever company you authorize becomes the active
// one — no env var to hand-set, and a stale/typo'd env value can't cause a mismatch.
export async function getRealmInfo() {
  const dbRealm = await getConfig('qbo_realm_id');
  if (dbRealm) return { realmId: dbRealm, source: 'db' };
  if (process.env.QBO_REALM_ID) return { realmId: process.env.QBO_REALM_ID, source: 'env' };
  return { realmId: null, source: 'none' };
}
export async function activeRealmId() {
  return (await getRealmInfo()).realmId;
}

async function accessToken() {
  if (tokenCache.access && Date.now() < tokenCache.exp) return tokenCache.access;
  // Single-flight: Intuit rotates AND invalidates the refresh token on every use, so two
  // simultaneous refreshes would revoke each other and 400 the connection. Concurrent callers
  // share the one in-flight refresh instead of each kicking off their own.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = await activeRefreshToken();
    if (!refreshToken) throw new QBOAuthError('No QBO refresh token — reconnect QuickBooks via Settings → Accounting');
    const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(await tokenEndpoint(), {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!res.ok) {
      const err = new QBOAuthError(`QuickBooks authorization expired — please reconnect (token refresh ${res.status})`);
      captureError(err, { area: 'qbo', op: 'token_refresh', status: res.status }); // alert: connection is down
      throw err;
    }
    const j = await res.json();
    tokenCache = { access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    await setConfig('qbo_refresh_token', j.refresh_token);  // persist the rotated token
    return tokenCache.access;
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Disconnect QuickBooks: best-effort revoke at Intuit, drop the rotating refresh token
// from the config table, and clear the cached access token. (A QBO_REFRESH_TOKEN env var,
// if set, remains as a seed — unset it in the environment for a hard disconnect.)
export async function disconnectQBO() {
  const rt = await activeRefreshToken();
  if (rt) {
    try {
      const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
      await fetch(await revocationEndpoint(), {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: rt }),
      });
    } catch { /* best-effort — clearing locally is what matters */ }
  }
  try { await ensureConfigTable(); await q("DELETE FROM config WHERE key IN ('qbo_refresh_token','qbo_realm_id')"); } catch {}
  tokenCache = { access: null, exp: 0 };
  return { ok: true };
}

// ---- API helpers ----
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Parse Intuit's structured fault response into a readable message.
// QB returns: { Fault: { type, Error: [{ Message, Detail, code, element }] } }
function parseQBOFault(raw, fallback) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const fault = j?.Fault || j?.fault;
    if (!fault) return fallback;
    const errs = fault.Error || fault.error || [];
    const parts = errs.map(e => {
      const msg    = e.Message  || e.message  || '';
      const detail = e.Detail   || e.detail   || '';
      const code   = e.code     || e.Code     || '';
      const elem   = e.element  || e.Element  || '';
      return [
        code   ? `[${code}]` : '',
        msg    ? msg : '',
        detail && detail !== msg ? ` — ${detail}` : '',
        elem   ? ` (field: ${elem})` : '',
      ].filter(Boolean).join('');
    });
    const type = fault.type || fault['@type'] || '';
    return `QuickBooks ${type ? type + ': ' : ''}${parts.join('; ') || fallback}`;
  } catch { return fallback; }
}

async function logQBOError({ method, path, status, tid, errorType, message, rawBody }) {
  try {
    await q(`INSERT INTO qbo_error_log(method,endpoint,status,intuit_tid,error_type,message,raw_body)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [method, path, status, tid || null, errorType, message.slice(0, 1000), (rawBody || '').slice(0, 4000)]);
  } catch {}  // never let logging failure break the main flow
}

export async function qboErrorLog(limit = 100) {
  return all(`SELECT id,ts,method,endpoint,status,intuit_tid,error_type,message
              FROM qbo_error_log ORDER BY ts DESC LIMIT $1`, [limit]);
}

async function call(method, path, body, { _retry401 = false, _attempt = 0 } = {}) {
  const tok = await accessToken();
  const realm = await activeRealmId();
  const res = await fetch(`${API_BASE}/v3/company/${realm}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const tid = res.headers.get('intuit_tid') || res.headers.get('intuit-tid') || '';

  // 401 — stale cached token; clear cache and retry once with a fresh access token
  if (res.status === 401 && !_retry401) {
    tokenCache = { access: null, exp: 0 };
    return call(method, path, body, { _retry401: true, _attempt });
  }

  if (!res.ok) {
    const errBody = await res.text();
    const tidSuffix = tid ? ` (intuit_tid: ${tid})` : '';

    // Auth failure — prompt reconnect
    if (res.status === 401 || res.status === 403) {
      const isAuthFail = res.status === 401 || errBody.includes('003100') || errBody.includes('ApplicationAuthorizationFailed');
      if (isAuthFail) {
        const err = new QBOAuthError(`QuickBooks authorization lost — please reconnect via Settings → Accounting → Re-authorize${tidSuffix}`);
        await logQBOError({ method, path, status: res.status, tid, errorType: 'QBOAuthError', message: err.message, rawBody: errBody });
        throw err;
      }
    }

    // Subscription/version-specific feature unavailability
    const featurePattern = /subscription|not available|upgrade your|not supported|not enabled|feature.*plan|plan.*feature/i;
    const featureCodePattern = /"code"\s*:\s*"(2\d{3}|6\d{3})"/;
    if (featurePattern.test(errBody) || featureCodePattern.test(errBody)) {
      const feature = path.split('?')[0].split('/').pop();
      const err = new QBOFeatureError(
        `This feature (${feature}) is not available in your current QuickBooks Online subscription. The transaction has been saved locally.${tidSuffix}`,
        feature
      );
      await logQBOError({ method, path, status: res.status, tid, errorType: 'QBOFeatureError', message: err.message, rawBody: errBody });
      throw err;
    }

    // 429 / 5xx — transient; exponential backoff up to 3 attempts (1 s, 2 s, 4 s)
    if ((res.status === 429 || res.status >= 500) && _attempt < 3) {
      const delay = (2 ** _attempt) * 1000 + Math.random() * 200;
      await sleep(delay);
      return call(method, path, body, { _retry401, _attempt: _attempt + 1 });
    }

    const message = parseQBOFault(errBody, `QBO ${method} ${path} ${res.status}`) + tidSuffix;
    await logQBOError({ method, path, status: res.status, tid, errorType: 'Error', message, rawBody: errBody });
    throw new Error(message);
  }
  return res.json();
}
async function query(q) {
  const r = await call('GET', `query?query=${encodeURIComponent(q)}&minorversion=${MINOR}`);
  return r.QueryResponse || {};
}

// find-or-create a Customer / Vendor by name, returning its QBO id
async function ensureCustomer(name) {
  const safe = name.replace(/'/g, "\\'");
  const found = (await query(`select Id from Customer where DisplayName = '${safe}'`)).Customer;
  if (found && found[0]) return found[0].Id;
  const created = await call('POST', `customer?minorversion=${MINOR}`, { DisplayName: name });
  return created.Customer.Id;
}
// find-or-create by DisplayName, returning the QBO Vendor Id. Exported so a newly-approved
// local vendor can be pushed the moment it goes active (see accounting.js pushVendorToQBO).
export async function ensureVendor(name) {
  const safe = name.replace(/'/g, "\\'");
  const found = (await query(`select Id from Vendor where DisplayName = '${safe}'`)).Vendor;
  if (found && found[0]) return found[0].Id;
  const created = await call('POST', `vendor?minorversion=${MINOR}`, { DisplayName: name });
  return created.Vendor.Id;
}
async function anyItemId() {
  const items = (await query(`select Id from Item where Type = 'Service' maxresults 1`)).Item
             || (await query(`select Id from Item maxresults 1`)).Item;
  if (!items || !items[0]) throw new Error('No QBO Item found — create a Service item (e.g. "Trailer") in QuickBooks first.');
  return items[0].Id;
}
async function anyExpenseAccountId() {
  const a = (await query(`select Id from Account where AccountType = 'Cost of Goods Sold' maxresults 1`)).Account
         || (await query(`select Id from Account where Classification = 'Expense' maxresults 1`)).Account;
  if (!a || !a[0]) throw new Error('No expense/COGS account found in QuickBooks.');
  return a[0].Id;
}

// ---- the two operations accounting.js calls ----
export async function createInvoice({ customer, amount, ref, lines }) {
  const customerId = await ensureCustomer(customer || 'Customer');
  const itemId = await anyItemId();
  // One line per trailer (with VIN in the description) when provided; else a single line.
  const Line = (Array.isArray(lines) && lines.length)
    ? lines.map(l => ({
        DetailType: 'SalesItemLineDetail', Amount: Number(l.amount),
        Description: (l.description || `Built Trailers order ${ref || ''}`).toString().slice(0, 1000).trim(),
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: Number(l.amount) },
      }))
    : [{
        DetailType: 'SalesItemLineDetail', Amount: Number(amount),
        Description: `Built Trailers order ${ref || ''}`.trim(),
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: Number(amount) },
      }];
  const inv = await call('POST', `invoice?minorversion=${MINOR}`, {
    CustomerRef: { value: customerId },
    DocNumber: (ref || '').slice(0, 21) || undefined,
    Line,
  });
  return inv.Invoice.Id;
}
export async function createBill({ vendor, amount, ref }) {
  const vendorId = await ensureVendor(vendor || 'Vendor');
  const acctId = await anyExpenseAccountId();
  const bill = await call('POST', `bill?minorversion=${MINOR}`, {
    VendorRef: { value: vendorId },
    DocNumber: (ref || '').slice(0, 21) || undefined,
    Line: [{
      DetailType: 'AccountBasedExpenseLineDetail', Amount: Number(amount),
      Description: `Built Trailers PO ${ref || ''}`.trim(),
      AccountBasedExpenseLineDetail: { AccountRef: { value: acctId } },
    }],
  });
  return bill.Bill.Id;
}

async function inventoryAssetAccountId() {
  const a = (await query(`select Id from Account where AccountType = 'Other Current Asset' and AccountSubType = 'Inventory' maxresults 1`)).Account
         || (await query(`select Id from Account where Classification = 'Asset' and FullyQualifiedName like '%Inventory%' maxresults 1`)).Account;
  if (!a || !a[0]) throw new QBOFeatureError('No inventory asset account found in QuickBooks — create or map one before posting cycle counts.', 'journalentry');
  return a[0].Id;
}
// Post the net value of an approved cycle-count adjustment as a balanced journal entry: Inventory
// Asset vs an adjustment/shrinkage account. (QBO's API doesn't expose per-item quantity
// adjustments — the per-part on-hand is corrected in the app; this posts the dollar value.)
export async function createJournalEntry({ ref, amount, memo }) {
  const amt = Math.round(Math.abs(Number(amount) || 0) * 100) / 100;
  if (amt < 0.005) return null; // a zero-variance count posts nothing
  const assetId = await inventoryAssetAccountId();
  const adjId = await anyExpenseAccountId();
  const gained = Number(amount) > 0; // counted more than the system had → inventory value up
  const line = (postingType, accountId) => ({
    Amount: amt, DetailType: 'JournalEntryLineDetail', Description: (memo || '').slice(0, 1000),
    JournalEntryLineDetail: { PostingType: postingType, AccountRef: { value: accountId } },
  });
  const je = await call('POST', `journalentry?minorversion=${MINOR}`, {
    DocNumber: (ref || '').slice(0, 21) || undefined, PrivateNote: memo,
    Line: [line(gained ? 'Debit' : 'Credit', assetId), line(gained ? 'Credit' : 'Debit', adjId)],
  });
  return je.JournalEntry.Id;
}

// ---- Pull sync: QB → Built Trailers ----

async function paginate(entity, where = '') {
  const rows = [];
  let start = 1;
  while (true) {
    const sql = `SELECT * FROM ${entity}${where ? ' WHERE ' + where : ''} STARTPOSITION ${start} MAXRESULTS 1000`;
    const r = await query(sql);
    const batch = r[entity] || [];
    rows.push(...batch);
    if (batch.length < 1000) break;
    start += 1000;
  }
  return rows;
}

export async function syncCustomersFromQBO() {
  const custs = await paginate('Customer');
  let created = 0, updated = 0;
  for (const c of custs) {
    if (c.Job) continue; // skip sub-customers (jobs)
    const id = 'qbo_' + c.Id;
    const name = c.DisplayName || c.CompanyName || c.FullyQualifiedName || 'Unknown';
    const contact = c.PrimaryEmailAddr?.Address || null;
    const phone = c.PrimaryPhone?.FreeFormNumber || null;
    const exists = await one('SELECT id FROM customer WHERE id=$1', [id]);
    if (exists) {
      await q('UPDATE customer SET name=$1,contact=$2,phone=$3 WHERE id=$4', [name, contact, phone, id]);
      updated++;
    } else {
      await q('INSERT INTO customer(id,name,kind,contact,phone) VALUES ($1,$2,$3,$4,$5)',
        [id, name, 'Dealership', contact, phone]);
      created++;
    }
  }
  await setConfig('qbo_customers_synced_at', new Date().toISOString());
  return { created, updated };
}

async function ensureVendorLocal(qbVendorRef) {
  if (!qbVendorRef?.name) return null;
  const existing = await one('SELECT id FROM vendor WHERE lower(name)=lower($1)', [qbVendorRef.name]);
  if (existing) {
    if (qbVendorRef.value) await q('UPDATE vendor SET qbo_id=$1 WHERE id=$2 AND qbo_id IS NULL', [String(qbVendorRef.value), existing.id]);
    return existing.id;
  }
  const vid = 'qbo_v_' + qbVendorRef.value;
  await q('INSERT INTO vendor(id,name,lead_days,qbo_id) VALUES ($1,$2,0,$3) ON CONFLICT DO NOTHING',
    [vid, qbVendorRef.name, qbVendorRef.value ? String(qbVendorRef.value) : null]);
  return vid;
}

// Pull sync: the full QuickBooks vendor list -> local `vendor` table (mirrors
// syncCustomersFromQBO). Matched by qbo_id first, then by name, so a vendor created locally
// and already pushed to QBO (see accounting.js pushVendorToQBO) reconciles instead of duplicating.
export async function syncVendorsFromQBO() {
  const vendors = await paginate('Vendor');
  let created = 0, updated = 0;
  for (const v of vendors) {
    if (v.Active === false) continue; // skip inactive QB vendors
    const name = v.DisplayName || v.CompanyName || 'Unknown';
    const existing = await one('SELECT id FROM vendor WHERE qbo_id=$1', [String(v.Id)])
                  || await one('SELECT id FROM vendor WHERE lower(name)=lower($1)', [name]);
    if (existing) {
      await q('UPDATE vendor SET name=$1, qbo_id=$2 WHERE id=$3', [name, String(v.Id), existing.id]);
      updated++;
    } else {
      const id = 'qbo_v_' + v.Id;
      await q(`INSERT INTO vendor(id,name,lead_days,status,qbo_id) VALUES ($1,$2,0,'active',$3) ON CONFLICT DO NOTHING`,
        [id, name, String(v.Id)]);
      created++;
    }
  }
  await setConfig('qbo_vendors_synced_at', new Date().toISOString());
  return { created, updated };
}

export async function previewItemsFromQBO() {
  const items = await paginate('Item');
  const existingParts = await all('SELECT id, name, cost, type FROM part', []);
  const byQbId = new Map(existingParts.filter(p => p.id.startsWith('QB-')).map(p => [p.id, p]));
  // Make parts are app-only — never match a QuickBooks item to one, so an import can't touch it.
  const byName  = new Map(existingParts.filter(p => p.type !== 'M').map(p => [p.name.toLowerCase(), p]));
  return items
    .filter(item => item.Type !== 'Group')
    .map(item => {
      const qbId = 'QB-' + item.Id;
      const name = item.FullyQualifiedName || item.Name || 'Unknown';
      const cost = Number(item.PurchaseCost ?? item.UnitPrice ?? 0);
      const existing = byQbId.get(qbId) || byName.get(name.toLowerCase());
      return {
        qbId:          item.Id,
        name,
        itemType:      item.Type,
        cost,
        vendor:        item.PrefVendorRef?.name || null,
        existingPartId: existing?.id || null,
        existingCost:  existing ? Number(existing.cost) : null,
        status:        existing ? 'update' : 'new',
        skip:          item.Type === 'Service',
      };
    });
}

export async function syncItemsFromQBO(qbIds) {
  // qbIds: optional array of QB item Ids to restrict the sync
  const items = await paginate('Item');
  const target = qbIds ? new Set(qbIds.map(String)) : null;
  let created = 0, updated = 0, skipped = 0;
  for (const item of items) {
    if (item.Type === 'Group') { skipped++; continue; }
    if (target && !target.has(String(item.Id))) { skipped++; continue; }
    const id = 'QB-' + item.Id;
    const name = item.FullyQualifiedName || item.Name || 'Unknown';
    const cost = Number(item.PurchaseCost ?? item.UnitPrice ?? 0);
    const vendorId = await ensureVendorLocal(item.PrefVendorRef);
    const exists = await one('SELECT id FROM part WHERE id=$1', [id]);
    if (exists) {
      await q('UPDATE part SET name=$1,cost=$2,vendor_id=$3 WHERE id=$4', [name, cost, vendorId, id]);
      updated++;
    } else {
      await q('INSERT INTO part(id,name,type,cost,vendor_id,on_hand,reorder,cushion,lot) VALUES ($1,$2,$3,$4,$5,0,0,0,1)',
        [id, name, 'P', cost, vendorId]);
      created++;
    }
  }
  await setConfig('qbo_items_synced_at', new Date().toISOString());
  return { created, updated, skipped };
}

// ---- Push: Built Trailers → QB. Update each trailer item's cost from the app BOM. ----

// All QB items with the fields needed to match models and read/write cost.
export async function getQBItems() {
  const items = await paginate('Item');
  return items.filter(i => i.Type !== 'Group').map(i => ({
    id: i.Id, name: i.Name || i.FullyQualifiedName || '', type: i.Type,
    cost: Number(i.PurchaseCost ?? 0), price: Number(i.UnitPrice ?? 0),
    syncToken: i.SyncToken, active: i.Active !== false,
  }));
}

// Sparse-update one item's PurchaseCost — the "Cost" field in QuickBooks. Re-reads the
// SyncToken immediately before writing so a stale token never blocks the update.
export async function updateItemCost(itemId, cost) {
  const found = (await query(`select Id, SyncToken from Item where Id = '${String(itemId).replace(/'/g, "\\'")}'`)).Item;
  if (!found || !found[0]) throw new Error(`QuickBooks item ${itemId} not found`);
  const res = await call('POST', `item?minorversion=${MINOR}`, {
    Id: String(itemId), SyncToken: found[0].SyncToken, sparse: true,
    PurchaseCost: Math.round(Number(cost) * 100) / 100,
  });
  return res.Item;
}

export async function syncInvoicesFromQBO() {
  const invoices = await paginate('Invoice');
  const models = await all('SELECT id, name FROM model', []);
  let created = 0, updated = 0;
  for (const inv of invoices) {
    const id = 'QBO-' + (inv.DocNumber || inv.Id);
    const qboCustId = 'qbo_' + (inv.CustomerRef?.value || '');
    const cust = await one('SELECT id FROM customer WHERE id=$1', [qboCustId])
              || await one('SELECT id FROM customer WHERE lower(name)=lower($1)', [inv.CustomerRef?.name || '']);
    const custId = cust?.id || null;

    // match first line item name to a model id or name
    const firstLine = (inv.Line || []).find(l => l.DetailType === 'SalesItemLineDetail');
    const itemName = (firstLine?.SalesItemLineDetail?.ItemRef?.name || '').toLowerCase();
    const matched = itemName
      ? models.find(m =>
          m.id.toLowerCase() === itemName ||
          m.name.toLowerCase().includes(itemName) ||
          itemName.includes(m.id.toLowerCase()))
      : null;
    const modelId = matched?.id || null;
    const qty = Math.max(1, Math.round(firstLine?.SalesItemLineDetail?.Qty || 1));
    const due = inv.DueDate || inv.TxnDate || null;

    const exists = await one('SELECT id FROM sales_order WHERE id=$1', [id]);
    if (exists) {
      await q('UPDATE sales_order SET customer_id=$1,model_id=$2,due=$3 WHERE id=$4',
        [custId, modelId, due, id]);
      updated++;
    } else {
      await q(`INSERT INTO sales_order(id,customer_id,model_id,qty,stage,due,deposit,channel,consumed,billed)
               VALUES ($1,$2,$3,$4,'Ready',$5,0,'QuickBooks',true,true)`,
        [id, custId, modelId, qty, due]);
      created++;
    }
  }
  await setConfig('qbo_invoices_synced_at', new Date().toISOString());
  return { created, updated };
}
