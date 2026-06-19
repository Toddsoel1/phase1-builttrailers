// Live QuickBooks Online connector — OAuth2 refresh-token flow + Invoice/Bill creation.
// Activated when ACCOUNTING_MODE=quickbooks and the QBO_* env vars are set. Until then the
// app stays in simulated mode (see accounting.js). Uses Node 20+ global fetch.
import 'dotenv/config';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens';
const API_BASE = (process.env.QBO_ENV === 'production')
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';
const MINOR = '73';

export function qboConfigured() {
  return !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET &&
            process.env.QBO_REFRESH_TOKEN && process.env.QBO_REALM_ID);
}

let tokenCache = { access: null, exp: 0 };
async function accessToken() {
  if (tokenCache.access && Date.now() < tokenCache.exp) return tokenCache.access;
  const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.QBO_REFRESH_TOKEN })
  });
  if (!res.ok) throw new Error(`QBO token refresh ${res.status}: ${await res.text()}`);
  const j = await res.json();
  tokenCache = { access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  // NOTE: Intuit rotates the refresh token (~101 days, reissued each refresh). In production,
  // persist j.refresh_token back to your secret store so it never goes stale.
  return tokenCache.access;
}

async function call(method, path, body) {
  const tok = await accessToken();
  const res = await fetch(`${API_BASE}/v3/company/${process.env.QBO_REALM_ID}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`QBO ${method} ${path} ${res.status}: ${await res.text()}`);
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
async function ensureVendor(name) {
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

// --- the two operations accounting.js calls ---
export async function createInvoice({ customer, amount, ref }) {
  const customerId = await ensureCustomer(customer || 'Customer');
  const itemId = await anyItemId();
  const inv = await call('POST', `invoice?minorversion=${MINOR}`, {
    CustomerRef: { value: customerId },
    DocNumber: (ref || '').slice(0, 21) || undefined,
    Line: [{
      DetailType: 'SalesItemLineDetail', Amount: Number(amount),
      Description: `Built Trailers order ${ref || ''}`.trim(),
      SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: Number(amount) }
    }]
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
      AccountBasedExpenseLineDetail: { AccountRef: { value: acctId } }
    }]
  });
  return bill.Bill.Id;
}
