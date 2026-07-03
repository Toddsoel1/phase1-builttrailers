// Built Trailers — Phase 1 API + static UI
import 'dotenv/config';
import express from 'express';
// Routes async route-handler rejections to Express error handling automatically,
// so an unexpected DB/query error returns 500 (see error handler below) instead of
// becoming an unhandledRejection that crashes the process. Must be imported before
// any routes are registered. (Patches Express 4; Express 5 handles this natively.)
import 'express-async-errors';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createHmac, timingSafeEqual } from 'crypto';
import { initDb, dbKind, q, all, one } from './db.js';
import { ensureSchema } from '../db/migrate.js';
import { ensureDealers } from './dealerseed.js';
import { log, captureError, initObservability, requestId, uptimeSeconds } from './observability.js';
import { authMiddleware, requireTier, signToken, checkPassword, hashPassword } from './auth.js';
import { modelRollup, modelsSummary, inventoryValuation } from './cost.js';
import { STAGES, canSell, canReorderProduction, trailerTypes, customersWithTypes, allowedTypesFor, ordersFull, consumeInventory, setProductionOrder } from './orders.js';
import { logWork, dailyReport, wipReport, consumptionByWorkstation, workstations } from './wip.js';
import { mrp, poList, createPO, receivePO } from './mrp.js';
import { accountingMode, qboConfigured, ledger, totals, sync, scanInvoice, invoiceList } from './accounting.js';
import { getAuthUrl, exchangeCode, syncCustomersFromQBO, syncItemsFromQBO, syncInvoicesFromQBO, syncVendorsFromQBO, previewItemsFromQBO, QBOAuthError, QBOFeatureError, qboErrorLog, getRefreshTokenInfo, disconnectQBO, getRealmInfo, getQBItems, updateItemCost } from './qbo.js';
import * as people from './people.js';
import { forecast, workingCapital, scenario } from './forecast.js';
import * as sms from './sms.js';
import * as approvals from './approvals.js';
import * as support from './support.js';
import { actionItemsFor } from './inbox.js';
import { sendMorningBriefings, previewBriefingFor } from './briefing.js';
import * as invoicing from './invoicing.js';
import * as trailers from './trailers.js';
import * as warranty from './warranty.js';
import * as portal from './portal.js';
import * as dealer from './dealer.js';
import * as owner from './owner.js';
import * as inventory from './inventory.js';
import * as boatbuilder from './boatbuilder.js';
import QRCode from 'qrcode';
import * as dealernotify from './dealernotify.js';
import * as storage from './storage.js';
import * as push from './push.js';
import * as testdata from './testdata.js';
import { geocodeAddress } from './geocode.js';
import { emailConfigured } from './email.js';
import { runReminders } from './reminders.js';

// Crash fast if JWT_SECRET is unset in production — predictable fallback is a critical vuln
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Set it in Render → Environment.');
  process.exit(1);
}

// Last-resort safety net: a stray promise rejection or sync throw outside the
// request lifecycle (e.g. the briefing scheduler, a background timer) should be
// logged rather than crash the process. Route-handler errors are handled cleanly
// by express-async-errors + the error middleware below; these are the backstop.
// Structured logging + unhandledRejection/uncaughtException capture (forwards to Sentry and/or
// an alert webhook when SENTRY_DSN / ALERT_WEBHOOK_URL are set).
initObservability();

function requireSales(req, res, next) {
  if (!canSell(req.user)) return res.status(403).json({ error: 'Order management is controlled by Sales' });
  next();
}
function requireProductionPlanner(req, res, next) {
  if (!canReorderProduction(req.user)) return res.status(403).json({ error: 'Reordering production is limited to Sales, the GM, the Shop Manager, and the Office Manager' });
  next();
}
// Admins have all sections; other users must have the section explicitly assigned
function requireSection(section) {
  return (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    if (req.user?.sections?.includes(section)) return next();
    return res.status(403).json({ error: `Requires access to the ${section} section` });
  };
}

// Validate Twilio webhook signatures to block spoofed SMS events
function twilioSignatureValid(req) {
  const token = process.env.TWILIO_TOKEN;
  if (!token) return true; // skip if not configured yet
  const sig = req.headers['x-twilio-signature'] || '';
  const url = `https://${req.headers.host || 'app.builttrailers.app'}/webhooks/sms`;
  const params = req.body || {};
  const sorted = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
  const expected = createHmac('sha1', token).update(sorted).digest('base64');
  try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind Render's TLS-terminating proxy: trust the first hop so req.protocol reflects
// the original https (via x-forwarded-proto). Without this, OAuth redirect_uris are
// built as http:// and Intuit rejects them as unregistered.
app.set('trust proxy', 1);
app.use(requestId()); // tag every request with an id; log 5xx + slow responses

// Security headers (CSP disabled — app uses inline scripts/styles)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS — only allow requests from the app's own domains
app.use(cors({
  origin: ['https://app.builttrailers.app', 'https://builttrailers.app'],
  credentials: true,
}));

// Rate limiting — login attempts per 15 min per IP (tune with LOGIN_RATE_MAX)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});
// Throttle the unauthenticated public warranty portal (tune with PORTAL_RATE_MAX)
const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PORTAL_RATE_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});

// Limit raised to accommodate base64 proof-of-sale uploads from the public portal.
// (Production should move uploads to multipart + object storage — see portal.js.)
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false })); // needed for Twilio webhook

async function audit(req, action, detail) {
  try { await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [req.user?.id || null, action, detail]); } catch {}
}

// ---- Twilio inbound SMS webhook ----
app.post('/webhooks/sms', async (req, res) => {
  if (!twilioSignatureValid(req)) return res.status(403).send('Forbidden');
  const from  = sms.normalizePhone(req.body?.From || '');
  const body  = (req.body?.Body || '').trim().toUpperCase().replace(/\s+/g, '');
  let reply   = null;

  const OPT_IN_KEYWORDS  = ['START','YES','IN','ENROLL'];
  const OPT_OUT_KEYWORDS = ['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'];
  const OPT_IN_MSG = 'Built Trailers: You are now enrolled! Msg&data rates may apply. Msg frequency varies. Reply STOP to cancel, HELP for help. builttrailers.app/privacy';

  try {
    if (OPT_IN_KEYWORDS.includes(body)) {
      // Determine audience: employee if phone matches an app_user, otherwise customer
      const userMatch = await one(`SELECT id FROM app_user WHERE regexp_replace(phone,'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g')`, [from]);
      const audience  = userMatch ? 'employee' : 'customer';
      await sms.recordOptin(from, audience, 'keyword');
      reply = OPT_IN_MSG;
    } else if (OPT_OUT_KEYWORDS.includes(body)) {
      await sms.recordOptout(from);
      // Twilio sends its own STOP confirmation — no reply needed
    } else if (body === 'UNSTOP') {
      const existing = await one('SELECT audience FROM sms_optin WHERE phone=$1', [from]);
      await sms.recordOptin(from, existing?.audience || 'customer', 'keyword');
      reply = OPT_IN_MSG;
    } else if (body === 'HELP') {
      reply = `Built Trailers: Notifications svc. Text START, YES, IN, or ENROLL to subscribe. STOP to cancel. Msg&data rates may apply. Support: ${process.env.SUPPORT_EMAIL || 'info@builttrailers.com'}`;
    } else {
      reply = 'Built Trailers: Text START, YES, IN, or ENROLL to subscribe to notifications. STOP to cancel, HELP for help.';
    }
  } catch (e) { console.error('SMS webhook error:', e); }

  const twiml = reply
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  res.type('text/xml').send(twiml);
});

// ---- Public SMS opt-in via web form (unauthenticated) ----
app.post('/api/sms/optin', async (req, res) => {
  if (!sms.smsEnabled()) return res.status(503).json({ error: 'Text alerts are coming soon.' });
  const { phone, audience } = req.body || {};
  const normalized = sms.normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: 'Valid phone number required' });
  await sms.recordOptin(normalized, audience === 'employee' ? 'employee' : 'customer', 'webform');
  const welcome = audience === 'employee'
    ? 'Built Trailers: You\'re subscribed to approval notifications! Reply STOP to cancel, HELP for help.'
    : 'Built Trailers: You\'re subscribed to order status updates! Up to 4 msgs/order. Msg&data rates may apply. Reply STOP to cancel, HELP for help.';
  try { await sms.send({ recipient: normalized, body: welcome, kind: 'optin-welcome' }, null); }
  catch (e) { console.error('Welcome SMS failed:', e.message); }
  res.json({ ok: true });
});

// ---- Check if a phone number has an existing opt-in (used by add-customer / edit-user modals) ----
app.get('/api/sms/optin-check', authMiddleware, async (req, res) => {
  const phone = sms.normalizePhone(req.query.phone || '');
  if (!phone) return res.json({ optedIn: false });
  const row = await sms.checkOptin(phone);
  res.json({ optedIn: !!row, audience: row?.audience || null });
});

// ---- Web push: phone/desktop notifications (the "coming soon" SMS replacement) ----
app.get('/api/push/vapid', (_req, res) => res.json({ publicKey: push.vapidPublicKey() }));
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  await push.saveSubscription('staff', req.user.id, req.body || {});
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  await push.removeSubscription((req.body || {}).endpoint);
  res.json({ ok: true });
});
app.post('/api/dealer/push/subscribe', dealer.dealerAuth, async (req, res) => {
  if (!req.dealer.customer_id) return res.status(400).json({ error: 'Your dealership is not linked yet.' });
  await push.saveSubscription('dealer', req.dealer.customer_id, req.body || {});
  res.json({ ok: true });
});
app.post('/api/dealer/push/unsubscribe', dealer.dealerAuth, async (req, res) => {
  await push.removeSubscription((req.body || {}).endpoint);
  res.json({ ok: true });
});

// ---- Serve public opt-in, privacy, and terms pages ----
// /optin is offline while SMS is paused; re-enabling SMS_ENABLED brings the A2P opt-in page back.
app.get('/optin',   (_req, res) => sms.smsEnabled() ? res.sendFile(path.join(__dir, '..', 'public', 'optin.html')) : res.redirect('/'));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dir, '..', 'public', 'privacy.html')));
app.get('/terms',   (_req, res) => res.sendFile(path.join(__dir, '..', 'public', 'terms.html')));

// ---- Public warranty registration portal (no staff login; rate-limited) ----
app.get('/register', (_req, res) => res.sendFile(path.join(__dir, '..', 'public', 'register.html')));
// Where a traveler's QR resolves — a minimal public unit page (VIN looked up live).
// The traveler QR's target: a phone-friendly shop-floor station page. Anyone scanning sees the
// unit read-only (VIN, model, config, progress); with the shop PIN (set by an admin in Print
// Center) a worker can mark the current stage complete right from the floor — same code path
// as the desktop Production Flow, so VINs, print queues, SMS, and dealer emails all still fire.
const FLOOR_STAGES = ['Scheduled', 'Build', 'Paint/Powder Coat', 'Finish'];
app.get('/u/:id', portalLimiter, async (req, res) => {
  const u = await trailers.stationUnit(req.params.id).catch(() => null);
  if (!u) return res.status(404).type('html').send('<p style="font-family:system-ui;margin:40px">Trailer unit not found.</p>');
  const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pinSet = !!(await one(`SELECT value FROM app_config WHERE key='shop_pin'`, []).catch(() => null));
  const stage = u.order?.stage || null;
  const canAdvance = pinSet && stage && FLOOR_STAGES.includes(stage);
  const next = stage ? STAGES[STAGES.indexOf(stage) + 1] : null;
  const prodStages = STAGES.slice(STAGES.indexOf('Scheduled')); // Scheduled..Ready — the floor's world
  const chips = stage ? prodStages.map(s => {
    const done = STAGES.indexOf(s) < STAGES.indexOf(stage);
    const curr = s === stage;
    return `<span style="display:inline-block;margin:2px 4px 2px 0;padding:4px 10px;border-radius:14px;font-size:12px;font-weight:600;
      ${curr ? 'background:#ff7a18;color:#1a1206' : done ? 'background:#e8f6ee;color:#1a7f4b' : 'background:#eef1f4;color:#6b7785'}">${done ? '✓ ' : ''}${e(s)}</span>`;
  }).join('') : '';
  const boatRows = u.boat ? (u.boat.options || []).map(o =>
    `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #f0f2f5;font-size:14px">
       <span style="color:#6b7785">${e(o.group)}</span><b style="text-align:right">${e(o.choice)}</b></div>`).join('') : '';
  const actionCard = !u.order ? '' : canAdvance ? `
  <div style="background:#fff;border:1px solid #e2e7ec;border-radius:14px;padding:18px;margin-top:16px">
    <b style="font-size:15px">${stage === 'Scheduled' ? '▶ Start the build' : `✓ Mark ${e(stage)} complete`}</b>
    <p style="color:#6b7785;font-size:13px;margin:4px 0 10px">Moves order ${e(u.order.id)} to <b>${e(next)}</b>. Use the shop PIN from the office.</p>
    <input id="wName" placeholder="Your name / initials" style="width:100%;border:1px solid #e2e7ec;border-radius:9px;padding:12px;font-size:16px;margin-bottom:8px">
    <input id="wPin" type="password" inputmode="numeric" placeholder="Shop PIN" style="width:100%;border:1px solid #e2e7ec;border-radius:9px;padding:12px;font-size:16px">
    <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;color:#6b7785"><input type="checkbox" onchange="document.getElementById('wPin').type=this.checked?'text':'password'"> Show PIN</label>
    <button onclick="adv()" style="width:100%;margin-top:10px;background:#ff7a18;color:#1a1206;border:none;padding:14px;border-radius:9px;font-weight:700;font-size:16px">${stage === 'Scheduled' ? '▶ Start Build' : `Mark ${e(stage)} complete`}</button>
    <div id="msg" style="display:none;margin-top:10px;padding:11px 13px;border-radius:9px;font-size:14px"></div>
  </div>
  <script>
    var $=function(i){return document.getElementById(i)};
    $('wName').value=localStorage.getItem('shopWorker')||''; $('wPin').value=localStorage.getItem('shopPin')||'';
    function say(ok,t){var m=$('msg');m.style.display='block';m.style.background=ok?'#e8f6ee':'#fdecea';m.style.color=ok?'#1a7f4b':'#c0392b';m.textContent=t;}
    async function adv(){
      localStorage.setItem('shopWorker',$('wName').value.trim()); localStorage.setItem('shopPin',$('wPin').value);
      try{
        var r=await fetch(location.pathname+'/advance',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({pin:$('wPin').value,worker:$('wName').value.trim()})});
        var d=await r.json().catch(function(){return{}});
        if(!r.ok){ if(r.status===401)localStorage.removeItem('shopPin'); return say(false,d.error||('Error '+r.status)); }
        say(true,'Done — now "'+d.stage+'". Reloading…'); setTimeout(function(){location.reload()},1200);
      }catch(err){ say(false,'Network error — try again.'); }
    }
  </script>` : (stage && FLOOR_STAGES.includes(stage) ? `
  <p style="color:#6b7785;font-size:13px;margin-top:14px">🔒 Shop-floor updates aren't enabled yet — ask the office to set a shop PIN (Print Center).</p>` : stage === 'Ready' ? `
  <p style="color:#1a7f4b;font-weight:600;margin-top:14px">✅ Production complete.</p>` : `
  <p style="color:#6b7785;font-size:13px;margin-top:14px">Waiting to be scheduled — the office advances this stage.</p>`);
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BUILT Trailers unit</title>
<body style="margin:0;background:#f4f6f8">
<div style="font-family:-apple-system,system-ui,sans-serif;max-width:440px;margin:0 auto;padding:24px 20px 40px;color:#1a2230">
  <h2 style="margin:0">BUILT <span style="color:#ff7a18">TRAILERS</span></h2>
  <p style="color:#6b7785;margin:2px 0 16px">Build traveler — station view</p>
  <div style="background:#fff;border:1px solid #e2e7ec;border-radius:14px;padding:18px">
    <div style="font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:1.2px">${e(u.vin) || '(VIN pending)'}</div>
    <p style="font-size:16px;margin:6px 0 2px">${e(u.model)}${u.type ? ' · ' + e(u.type) : ''}</p>
    ${u.order ? `<p style="color:#6b7785;font-size:13px;margin:2px 0 10px">Order ${e(u.order.id)} · qty ${e(u.order.qty)}${u.order.due ? ' · due ' + e(String(u.order.due).slice(0, 10)) : ''}</p>${chips}` : `<p style="color:#6b7785">Status: ${e(u.status)}</p>`}
  </div>
  ${u.boat ? `<div style="background:#fff;border:1px solid #e2e7ec;border-radius:14px;padding:18px;margin-top:16px">
    <b style="font-size:15px">🚤 ${e(u.boat.model || 'Boat build')}${u.boat.year ? ' · ' + e(u.boat.year) : ''}${u.boat.length ? ' · ' + e(u.boat.length) + "'" : ''}</b>
    <div style="margin-top:6px">${boatRows || '<p style="color:#6b7785;font-size:13px">No options recorded.</p>'}</div>
  </div>` : ''}
  ${actionCard}
</div></body>`);
});
// PIN-gated stage advance from the station page. loginLimiter throttles PIN guessing.
app.post('/u/:id/advance', loginLimiter, async (req, res) => {
  try {
    const { pin, worker } = req.body || {};
    const pinHash = (await one(`SELECT value FROM app_config WHERE key='shop_pin'`, []).catch(() => null))?.value;
    if (!pinHash) return res.status(503).json({ error: 'Shop-floor updates are not enabled. Ask the office to set a shop PIN.' });
    if (!pin || !checkPassword(String(pin), pinHash)) return res.status(401).json({ error: 'Wrong PIN.' });
    const unit = await one('SELECT order_id FROM trailer WHERE id=$1', [req.params.id]);
    if (!unit?.order_id) return res.status(404).json({ error: 'Unit not found or not on an order.' });
    const cur = await one('SELECT * FROM sales_order WHERE id=$1', [unit.order_id]);
    if (!cur) return res.status(404).json({ error: 'Order not found.' });
    if (!FLOOR_STAGES.includes(cur.stage))
      return res.status(400).json({ error: `Order is "${cur.stage}" — that stage is handled by the office, not the floor.` });
    const next = STAGES[STAGES.indexOf(cur.stage) + 1];
    await applyOrderStage(unit.order_id, cur, next, null, `shop floor${worker ? ': ' + String(worker).slice(0, 40) : ''}`);
    res.json({ ok: true, stage: next });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/public/trailer/:vin', portalLimiter, async (req, res) => {
  try { res.json(await portal.publicTrailerLookup(req.params.vin)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/public/register', portalLimiter, async (req, res) => {
  try { res.json(await portal.submitRegistration(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/public/claim', portalLimiter, async (req, res) => {
  try { res.json(await portal.submitPublicClaim(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/public/maintenance', portalLimiter, async (req, res) => {
  try { res.json(await portal.submitMaintenance(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Owner account portal (owner.builttrailers.app) ----
app.get('/owner', (_req, res) => res.sendFile(path.join(__dir, '..', 'public', 'owner.html')));
app.post('/api/owner/register', portalLimiter, async (req, res) => {
  try { res.json(await owner.register(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/owner/login', loginLimiter, async (req, res) => {
  try { res.json(await owner.login(req.body || {})); } catch (e) { res.status(401).json({ error: e.message }); }
});
app.post('/api/owner/forgot', loginLimiter, async (req, res) => {
  try { res.json(await owner.requestReset(req.body?.email, process.env.OWNER_PORTAL_URL)); } catch { res.json({ ok: true }); }
});
app.post('/api/owner/reset', loginLimiter, async (req, res) => {
  try { res.json(await owner.resetPassword(req.body?.token, req.body?.password)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/owner/me', owner.ownerAuth, async (req, res) => res.json(await owner.me(req.owner)));
app.post('/api/owner/change-password', owner.ownerAuth, async (req, res) => {
  try { res.json(await owner.changePassword(req.owner, req.body?.currentPassword, req.body?.newPassword)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/owner/trailers', owner.ownerAuth, async (req, res) => res.json(await owner.myTrailers(req.owner)));
app.get('/api/owner/claims', owner.ownerAuth, async (req, res) => res.json(await owner.myClaims(req.owner)));
app.post('/api/owner/claims', owner.ownerAuth, async (req, res) => {
  try { res.json(await owner.submitClaim(req.owner, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/owner/maintenance', owner.ownerAuth, async (req, res) => res.json(await owner.myMaintenance(req.owner)));
app.post('/api/owner/maintenance', owner.ownerAuth, async (req, res) => {
  try { res.json(await owner.logMaintenance(req.owner, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Dealership portal (dealership.builttrailers.app) ----
app.get('/dealer', (_req, res) => res.sendFile(path.join(__dir, '..', 'public', 'dealership.html')));
app.post('/api/dealer/signup', portalLimiter, async (req, res) => {
  try { res.json(await dealer.signup(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/dealer/login', loginLimiter, async (req, res) => {
  try { res.json(await dealer.login(req.body || {})); } catch (e) { res.status(401).json({ error: e.message }); }
});
app.post('/api/dealer/forgot', loginLimiter, async (req, res) => {
  try { res.json(await dealer.requestReset(req.body?.email, process.env.DEALER_PORTAL_URL)); } catch { res.json({ ok: true }); }
});
app.post('/api/dealer/reset', loginLimiter, async (req, res) => {
  try { res.json(await dealer.resetPassword(req.body?.token, req.body?.password)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/dealer/change-password', dealer.dealerAuth, async (req, res) => {
  try { res.json(await dealer.changePassword(req.dealer, req.body?.currentPassword, req.body?.newPassword)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/dealer/me', dealer.dealerAuth, async (req, res) => res.json(await dealer.me(req.dealer)));
// Warranty role (+admin): register & view registrations
app.post('/api/dealer/register', dealer.dealerAuth, dealer.dealerRole('warranty'), async (req, res) => {
  try { res.json(await dealer.registerTrailer(req.dealer, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/dealer/registrations', dealer.dealerAuth, dealer.dealerRole('warranty'), async (req, res) => res.json(await dealer.myRegistrations(req.dealer)));
// Service + warranty roles (+admin): claims
app.get('/api/dealer/claims', dealer.dealerAuth, dealer.dealerRole('service', 'warranty'), async (req, res) => res.json(await dealer.myClaims(req.dealer)));
app.post('/api/dealer/claim', dealer.dealerAuth, dealer.dealerRole('service', 'warranty'), async (req, res) => {
  try { res.json(await portal.submitPublicClaim({ ...req.body, submittedBy: req.dealer.name })); } catch (e) { res.status(400).json({ error: e.message }); }
});
// Sales role (+admin): orders & invoices
app.get('/api/dealer/models', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => res.json(await dealer.orderableModels(req.dealer)));
app.get('/api/dealer/orders', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => res.json(await dealer.myOrders(req.dealer)));
app.post('/api/dealer/orders', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => {
  try { res.json(await dealer.placeOrder(req.dealer, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
// Boat Trailer Builder (dealer): the configurator catalog (internal part mappings stripped) and
// submit, which checks the dealership is authorized for the boat's trailer category, then creates
// a Quote order under the dealer's account for Built Trailers to approve.
app.get('/api/dealer/boat-catalog', dealer.dealerAuth, dealer.dealerRole('sales'), async (_req, res) => {
  const cat = await boatbuilder.getCatalog();
  res.json({ makes: cat.makes, boats: cat.boats, groups: cat.groups.map(g => ({ ...g, choices: g.choices.map(({ parts, ...c }) => c) })) });
});
app.post('/api/dealer/boat-build', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => {
  try {
    const d = req.dealer;
    if (!d.customer_id) throw new Error('Your account is not linked to a dealer record yet — contact Built Trailers.');
    const bm = await one('SELECT base_model_id FROM boat_model WHERE id=$1', [req.body?.boatId]);
    const mdl = bm && await one('SELECT category FROM model WHERE id=$1', [bm.base_model_id]);
    const allowed = (await all('SELECT type FROM customer_allowed_type WHERE customer_id=$1', [d.customer_id])).map(a => a.type);
    if (mdl && !allowed.includes(mdl.category)) throw new Error(`Your dealership isn't authorized to order ${mdl.category} trailers.`);
    const cust = await one('SELECT rep_id FROM customer WHERE id=$1', [d.customer_id]);
    res.json(await boatbuilder.submitBuild(null, { ...(req.body || {}), customerId: d.customer_id, channel: 'Dealer Portal', repId: cust?.rep_id || null, createdBy: d.id }));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
// Dealer self-service on their own order — allowed only while it's still a Quote (pre-confirmation).
async function dealerOwnQuote(req, res) {
  const o = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!o || o.customer_id !== req.dealer.customer_id) { res.status(404).json({ error: 'order not found' }); return null; }
  if (o.stage !== 'Quote') { res.status(400).json({ error: 'This order has been confirmed — contact Built Trailers to change it.' }); return null; }
  return o;
}
app.get('/api/dealer/orders/:id', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => {
  const o = await one(`SELECT o.id, o.qty, o.stage, o.due, m.name AS model FROM sales_order o LEFT JOIN model m ON m.id=o.model_id WHERE o.id=$1 AND o.customer_id=$2`, [req.params.id, req.dealer.customer_id]);
  if (!o) return res.status(404).json({ error: 'order not found' });
  res.json({ ...o, editable: o.stage === 'Quote', build: await boatbuilder.orderBuild(req.params.id).catch(() => null) });
});
app.post('/api/dealer/orders/:id/cancel', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => {
  const o = await dealerOwnQuote(req, res); if (!o) return;
  await q(`UPDATE sales_order SET prev_stage='Quote', stage='Cancelled', cancel_reason=$1, cancelled_at=now() WHERE id=$2`, ['Withdrawn by dealer', req.params.id]);
  res.json({ ok: true });
});
app.patch('/api/dealer/orders/:id', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => {
  const o = await dealerOwnQuote(req, res); if (!o) return;
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.due !== undefined) { vals.push(b.due || null); sets.push(`due=$${vals.length}`); }
  if (b.qty !== undefined) { vals.push(Math.max(1, Number(b.qty) || 1)); sets.push(`qty=$${vals.length}`); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await q(`UPDATE sales_order SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  res.json({ ok: true });
});
app.post('/api/dealer/orders/:id/boat-build', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => {
  try { const o = await dealerOwnQuote(req, res); if (!o) return; res.json(await boatbuilder.updateBuild(req.params.id, req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
// Public dealer directory (locator feed) — protected by a static bearer token (env DEALER_FEED_TOKEN).
// Returns only public-safe fields for active dealerships; never internal contacts, reps, or margins.
app.get('/api/public/dealers', portalLimiter, async (req, res) => {
  const expected = process.env.DEALER_FEED_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Dealer feed is not configured.' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  // Only geocoded dealers — a dealer with no coordinates never shows as a blank pin on the site.
  const rows = await all(`SELECT name, address, city, state, zip, phone, lat, lng
                            FROM customer WHERE kind='Dealership' AND active=true AND is_test=false
                              AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name`, []);
  const dealers = rows.map(d => ({
    name: d.name, address: d.address || null, city: d.city || null, state: d.state || null,
    zip: d.zip || null, phone: d.phone || null,
    lat: d.lat == null ? null : Number(d.lat), lng: d.lng == null ? null : Number(d.lng),
    status: 'active',
  }));
  res.json({ dealers });
});
app.get('/api/dealer/invoices', dealer.dealerAuth, dealer.dealerRole('sales'), async (req, res) => res.json(await dealer.myInvoices(req.dealer)));
// Everyone: notifications, team view
app.get('/api/dealer/notifications', dealer.dealerAuth, async (req, res) => res.json(await dealernotify.myNotifications(req.dealer)));
app.post('/api/dealer/notifications/read', dealer.dealerAuth, async (req, res) => res.json(await dealernotify.markRead(req.dealer)));
app.get('/api/dealer/team', dealer.dealerAuth, async (req, res) => res.json(await dealer.team(req.dealer)));
// Dealership admin only: manage who joins and their roles
app.post('/api/dealer/team/:id/approve', dealer.dealerAuth, dealer.dealerRole(), async (req, res) => {
  try { res.json(await dealer.approveTeamMember(req.dealer, req.params.id, req.body?.role)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/dealer/team/:id/reject', dealer.dealerAuth, dealer.dealerRole(), async (req, res) => {
  try { res.json(await dealer.rejectTeamMember(req.dealer, req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/dealer/team/:id/role', dealer.dealerAuth, dealer.dealerRole(), async (req, res) => {
  try { res.json(await dealer.setTeamRole(req.dealer, req.params.id, req.body?.role)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Document library (manuals, spec sheets, warranty terms) ----
app.get('/api/public/documents', portalLimiter, async (_req, res) => res.json(await portal.listDocuments()));
app.get('/api/public/document/:id', portalLimiter, async (req, res) => {
  const doc = await portal.getDocumentPath(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  const file = await storage.getFile(doc.path);
  if (!file) return res.status(404).end();
  res.type(doc.ct || file.contentType).send(file.buffer);
});
app.post('/api/documents', authMiddleware, requireTier('admin'), async (req, res) => {
  try { const r = await portal.addDocument(req.body || {}, req.user.id); await audit(req, 'doc.add', `${r.id} ${req.body?.title || ''}`); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/documents/:id', authMiddleware, requireTier('admin'), async (req, res) => {
  try { res.json(await portal.deleteDocument(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/t&cs',    (_req, res) => res.sendFile(path.join(__dir, '..', 'public', 'terms.html')));

// ---- health ----
app.get('/api/health', async (_req, res) => {
  // Build info so "what commit is actually live?" is answerable without dashboard access.
  // Render injects RENDER_GIT_COMMIT / RENDER_GIT_BRANCH at deploy time; locally they're absent.
  const build = {
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev',
    branch: process.env.RENDER_GIT_BRANCH || null,
    email: emailConfigured(), // true once RESEND_API_KEY is set — lets setup be confirmed with one curl
  };
  try {
    await q('SELECT 1');
    res.json({ ok: true, status: 'ok', db: dbKind(), uptime: uptimeSeconds(), ...build });
  } catch (e) {
    // 503 (not 200) so an uptime monitor / Render health check treats a DB outage as down.
    log.error('health check failed: database unreachable', { err: String(e) });
    res.status(503).json({ ok: false, status: 'degraded', error: 'database unreachable', ...build });
  }
});
// Front-end crash capture — the browser posts uncaught errors here so they're visible
// server-side too. Unauthenticated (errors happen logged-out) and rate-limited.
const clientErrLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });
app.post('/api/client-error', clientErrLimiter, (req, res) => {
  const b = req.body || {};
  log.warn('client_error', {
    kind: String(b.kind || 'error').slice(0, 40),
    message: String(b.message || '').slice(0, 500),
    url: String(b.url || '').slice(0, 300),
    stack: String(b.stack || '').slice(0, 2000),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    id: req.id,
  });
  res.json({ ok: true });
});

// ---- auth ----
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const u = await one('SELECT * FROM app_user WHERE lower(username)=lower($1)', [username || '']);
  if (!u || !checkPassword(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  if (u.active === false) return res.status(403).json({ error: 'Account is inactive. Contact your administrator.' });
  const titleRows = await all('SELECT role_name FROM user_title WHERE user_id=$1', [u.id]);
  const titles = titleRows.length ? titleRows.map(r => r.role_name) : (u.title ? [u.title] : []);
  const sectionRows = u.role === 'admin' ? null :
    await all(`SELECT DISTINCT rs.section FROM user_title ut JOIN role_section rs ON rs.role_name=ut.role_name WHERE ut.user_id=$1`, [u.id]);
  const sections = sectionRows ? sectionRows.map(r => r.section) : null;
  const safe = { id: u.id, name: u.name, username: u.username, title: u.title, titles, role: u.role, manager_id: u.manager_id, sections, email: u.email || null };
  res.json({ token: signToken(u), user: safe });
});
app.get('/api/auth/me', authMiddleware, (req, res) => res.json({ user: req.user }));

// ---- QBO connection diagnostic ----
app.get('/api/qbo/test', authMiddleware, requireTier('admin'), async (_req, res) => {
  const steps = [];
  try {
    // Step 1: refresh token present? Check the SAME source the live app uses — the
    // rotating DB token first, the env var only as a seed fallback — so the diagnostic
    // can't disagree with reality.
    const { token: rt, source } = await getRefreshTokenInfo();
    steps.push({ step: 'refresh_token_available', ok: !!rt, source, value: rt ? rt.slice(0, 12) + '…' : null });
    if (!rt) return res.json({ steps });

    // Step 2: can we get an access token?
    const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
    const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
    const tokRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }),
    });
    const tokBody = await tokRes.text();
    steps.push({ step: 'token_refresh', status: tokRes.status, ok: tokRes.ok, body: tokRes.ok ? '(tokens received)' : tokBody });
    if (!tokRes.ok) return res.json({ steps });
    const tok = JSON.parse(tokBody);

    // Step 3: can we hit the company info endpoint? Use the SAME realm the app uses
    // (the one captured at OAuth, DB-first) so the diagnostic can't disagree with reality.
    const API_BASE = process.env.QBO_ENV === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
    const { realmId: realm, source: realmSource } = await getRealmInfo();
    const infoRes = await fetch(`${API_BASE}/v3/company/${realm}/companyinfo/${realm}?minorversion=73`, {
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
    });
    const infoBody = await infoRes.text();
    steps.push({ step: 'company_info', status: infoRes.status, ok: infoRes.ok,
      body: infoRes.ok ? JSON.parse(infoBody)?.CompanyInfo?.CompanyName : infoBody.slice(0, 400) });

    res.json({ steps, env: process.env.QBO_ENV, realmId: realm, realmSource });
  } catch (e) {
    res.json({ steps, error: e.message });
  }
});

// ---- QBO OAuth flow (admin only — run once to get credentials) ----
app.get('/api/auth/qbo', authMiddleware, requireTier('admin'), async (req, res) => {
  if (!process.env.QBO_CLIENT_ID || !process.env.QBO_CLIENT_SECRET)
    return res.status(400).json({ error: 'Set QBO_CLIENT_ID and QBO_CLIENT_SECRET in .env first' });
  const redirect = `${req.protocol}://${req.get('host')}/api/auth/qbo/callback`;
  const url = await getAuthUrl(redirect);
  // JSON response lets the SPA open the URL itself; plain browser hits get a redirect
  if (req.headers.accept?.includes('application/json')) return res.json({ url });
  res.redirect(url);
});
app.get('/api/auth/qbo/disconnect', authMiddleware, requireTier('admin'), async (req, res) => {
  try {
    await disconnectQBO();   // revoke at Intuit + clear the stored (config) token + access cache
    await audit(req, 'qbo.disconnect', 'QBO access revoked');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/auth/qbo/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;
  if (error) return res.send(`<pre>QuickBooks error: ${error}\n\n<a href="/">← Home</a></pre>`);
  if (!code) return res.status(400).send('<pre>No authorization code received from QuickBooks.</pre>');
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    const redirect = `${req.protocol}://${req.get('host')}/api/auth/qbo/callback`;
    const { refreshToken } = await exchangeCode(String(code), redirect, String(state || ''), realmId);
    await audit(req, 'qbo.oauth', `realm ${realmId}`);
    res.send(`<!DOCTYPE html><html><head><title>QuickBooks Connected</title>
<style>body{font-family:sans-serif;padding:2rem;max-width:740px}
pre{background:#f5f5f5;padding:1rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.ok{color:#1a7f37}.note{color:#666;font-size:.9em;margin-top:1rem}</style></head><body>
<h2 class="ok">&#x2705; QuickBooks Authorization Complete</h2>
<p>Add these to your <code>.env</code> (or Render environment variables) and restart the server:</p>
<pre>ACCOUNTING_MODE=quickbooks
QBO_ENV=production
QBO_CLIENT_ID=${esc(process.env.QBO_CLIENT_ID)}
QBO_CLIENT_SECRET=${esc(process.env.QBO_CLIENT_SECRET)}
QBO_REALM_ID=${esc(realmId)}
QBO_REFRESH_TOKEN=${esc(refreshToken)}</pre>
<p class="note">The refresh token is also saved to the database automatically and will stay current
as long as the server makes at least one QuickBooks API call every 101 days.</p>
<p><a href="/">&#x2190; Back to Built Trailers</a></p>
</body></html>`);
  } catch (e) {
    res.status(500).send(`<pre>Token exchange failed: ${esc(e.message)}\n\n<a href="/">&#x2190; Home</a></pre>`);
  }
});

// ---- users (admin) ----
// Highest permission tier (viewer < editor < admin) across a set of job titles —
// a multi-title user gets the strongest tier among the titles they hold.
async function maxTier(roleNames) {
  if (!roleNames || !roleNames.length) return 'viewer';
  const order = { viewer: 0, editor: 1, admin: 2 };
  const allRoles = await all('SELECT name,tier FROM role', []);
  const tierByName = Object.fromEntries(allRoles.map(r => [r.name, r.tier]));
  let best = 'viewer';
  for (const n of roleNames) { const t = tierByName[n]; if (t && (order[t] ?? 0) > (order[best] ?? 0)) best = t; }
  return best;
}
app.get('/api/users', authMiddleware, async (_req, res) => {
  const users = await all('SELECT id,name,username,title,role,manager_id,phone,email,sms_consent,sms_consent_at,active FROM app_user ORDER BY active DESC,id', []);
  for (const u of users) {
    const rows = await all('SELECT role_name FROM user_title WHERE user_id=$1', [u.id]);
    u.titles = rows.map(r => r.role_name);
  }
  res.json(users);
});
app.post('/api/users', authMiddleware, requireTier('admin'), async (req, res) => {
  const { name, title, titles, password, phone, email, smsConsent } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  // Accept a list of job titles; fall back to the single `title` for older clients.
  const roleList = (Array.isArray(titles) ? titles : (title ? [title] : [])).filter(Boolean);
  const tier = await maxTier(roleList);
  const primary = roleList[0] || null;
  const id = 'u' + Date.now();
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  const normalizedPhone = phone ? sms.normalizePhone(phone) : null;
  const priorOptin = normalizedPhone ? await sms.checkOptin(normalizedPhone) : null;
  const effectiveConsent = !!(smsConsent || priorOptin);
  const consentAt = effectiveConsent ? new Date().toISOString() : null;
  await q('INSERT INTO app_user(id,name,username,password_hash,title,role,manager_id,phone,email,sms_consent,sms_consent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, name, base, hashPassword(password || 'built2026'), primary, tier, req.user.id, normalizedPhone || null, (email || '').trim() || null, effectiveConsent, consentAt]);
  // Sync the title junction so the new user's permissions (union of sections) take effect immediately.
  for (const rn of roleList) await q('INSERT INTO user_title(user_id,role_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, rn]);
  await audit(req, 'user.create', `${name} (${roleList.join(', ') || 'no title'})${effectiveConsent ? ' [sms-consent]' : ''}`);
  res.json({ id, username: base });
});
// Self-service email — every signed-in user maintains their own contact email (mirrors the
// self-service password change above); admins can still set anyone's via PATCH /api/users/:id.
app.post('/api/users/me/email', authMiddleware, async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That does not look like an email address.' });
  await q('UPDATE app_user SET email=$1 WHERE id=$2', [email || null, req.user.id]);
  await audit(req, 'user.email', `self-set ${email || '(cleared)'}`);
  res.json({ ok: true, email: email || null });
});
app.post('/api/users/me/password', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  await q('UPDATE app_user SET password_hash=$1 WHERE id=$2', [hashPassword(password), req.user.id]);
  await audit(req, 'user.password', 'self-change');
  res.json({ ok: true });
});
app.patch('/api/users/:id', authMiddleware, requireTier('admin'), async (req, res) => {
  const { title, titles, role, manager_id, password, username, phone, email, smsConsent } = req.body || {};
  const cur = await one('SELECT * FROM app_user WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  let newTitle = title ?? cur.title;
  let tier = role ?? cur.role;
  if (Array.isArray(titles)) {
    // Replace the user's whole set of job titles; permissions become the union of their sections.
    const roleList = titles.filter(Boolean);
    await q('DELETE FROM user_title WHERE user_id=$1', [req.params.id]);
    for (const rn of roleList) await q('INSERT INTO user_title(user_id,role_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.id, rn]);
    newTitle = roleList[0] || null;
    tier = await maxTier(roleList);
  } else if (title) {
    tier = (await one('SELECT tier FROM role WHERE name=$1', [title]))?.tier || cur.role;
  }
  const consentAt = (smsConsent === true && !cur.sms_consent) ? new Date().toISOString() : cur.sms_consent_at;
  const { name } = req.body || {};
  await q('UPDATE app_user SET name=$1,title=$2,role=$3,manager_id=$4,username=$5,phone=$6,email=$7,sms_consent=$8,sms_consent_at=$9 WHERE id=$10',
    [name ?? cur.name, newTitle, tier,
     manager_id !== undefined ? (manager_id || null) : cur.manager_id,
     username ?? cur.username,
     phone !== undefined ? (phone || null) : cur.phone,
     email !== undefined ? (String(email).trim() || null) : cur.email,
     smsConsent !== undefined ? !!smsConsent : cur.sms_consent,
     consentAt, req.params.id]);
  if (password) await q('UPDATE app_user SET password_hash=$1 WHERE id=$2', [hashPassword(password), req.params.id]);
  await audit(req, 'user.update', `${req.params.id}${smsConsent !== undefined ? (smsConsent ? ' [sms-consent granted]' : ' [sms-consent revoked]') : ''}`);
  res.json({ ok: true });
});
app.delete('/api/users/:id', authMiddleware, requireTier('admin'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  const cur = await one('SELECT name FROM app_user WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  // Check for any transactions by this user across key tables
  const hasActivity = await one(
    `SELECT 1 FROM audit_log WHERE user_id=$1 LIMIT 1
     UNION ALL SELECT 1 FROM sales_order WHERE created_by=$1 LIMIT 1
     UNION ALL SELECT 1 FROM purchase_order WHERE created_by=$1 LIMIT 1
     UNION ALL SELECT 1 FROM win WHERE by_user=$1 LIMIT 1
     UNION ALL SELECT 1 FROM approval_request WHERE requested_by=$1 OR decided_by=$1 LIMIT 1
     LIMIT 1`, [req.params.id]);
  if (hasActivity) {
    await q('UPDATE app_user SET active=false WHERE id=$1', [req.params.id]);
    await audit(req, 'user.deactivate', cur.name);
    res.json({ ok: true, deactivated: true });
  } else {
    await q('DELETE FROM app_user WHERE id=$1', [req.params.id]);
    await audit(req, 'user.delete', cur.name);
    res.json({ ok: true, deleted: true });
  }
});
app.patch('/api/users/:id/reactivate', authMiddleware, requireTier('admin'), async (req, res) => {
  await q('UPDATE app_user SET active=true WHERE id=$1', [req.params.id]);
  await audit(req, 'user.reactivate', req.params.id);
  res.json({ ok: true });
});

// ---- parts master ----
app.get('/api/parts', authMiddleware, async (_req, res) => {
  const rows = await all(`SELECT p.*, v.name AS vendor_name, v.status AS vendor_status, v.lead_days
                            FROM part p LEFT JOIN vendor v ON v.id=p.vendor_id ORDER BY p.type DESC, p.id`, []);
  res.json(rows.map(p => ({
    id: p.id, name: p.name, type: p.type, vendor: p.vendor_name, vendorId: p.vendor_id, vendorStatus: p.vendor_status, leadDays: p.lead_days,
    uom: p.uom, spec: p.spec, cost: Number(p.cost), onHand: p.on_hand, reorder: p.reorder,
    cushion: p.cushion, lot: p.lot, active: p.active !== false, extValue: Number(p.cost) * p.on_hand,
    status: p.on_hand < p.reorder ? 'below' : (p.on_hand < p.reorder + p.cushion ? 'low' : 'ok')
  })));
});
// Create a Make part in-app — app-only, never pushed to QuickBooks (the QB item sync
// only ever touches QB-prefixed parts). Buy parts come from the QuickBooks import instead.
app.post('/api/parts', authMiddleware, requireTier('editor'), async (req, res) => {
  const { id, name, type, cost, uom, spec, reorder, cushion, lot } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Part name is required.' });
  const partType = type === 'P' ? 'P' : 'M';
  let pid = id && String(id).trim() ? String(id).trim().toUpperCase().replace(/\s+/g, '-') : null;
  if (!pid) { const n = (await all(`SELECT id FROM part WHERE id LIKE 'MK-%'`, [])).length; pid = 'MK-' + (1001 + n); }
  if (await one('SELECT id FROM part WHERE id=$1', [pid])) return res.status(400).json({ error: `Part ${pid} already exists.` });
  await q(`INSERT INTO part(id,name,type,cost,uom,spec,on_hand,reorder,cushion,lot,active)
           VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,true)`,
    [pid, String(name).trim(), partType, Number(cost) || 0, uom || null, spec || null,
     Number(reorder) || 0, Number(cushion) || 0, Math.max(1, Number(lot) || 1)]);
  await audit(req, 'part.create', `${pid} ${name} (${partType === 'M' ? 'Make' : 'Buy'}, app-only)`);
  res.json({ id: pid });
});
app.patch('/api/parts/:id', authMiddleware, requireTier('editor'), async (req, res) => {
  const cur = await one('SELECT * FROM part WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const { cost, reorder, cushion, lot, active, vendorId } = req.body || {};
  if (vendorId !== undefined && vendorId && !await one('SELECT id FROM vendor WHERE id=$1', [vendorId]))
    return res.status(400).json({ error: 'Vendor not found' });
  const newVendorId = vendorId !== undefined ? (vendorId || null) : cur.vendor_id;
  await q('UPDATE part SET cost=$1, reorder=$2, cushion=$3, lot=$4, active=$5, vendor_id=$6 WHERE id=$7',
    [cost ?? cur.cost, reorder ?? cur.reorder, cushion ?? cur.cushion, lot ?? cur.lot,
     active !== undefined ? !!active : (cur.active !== false), newVendorId, req.params.id]);
  if (cost != null && Number(cost) !== Number(cur.cost))
    await audit(req, 'part.cost', `${req.params.id}: ${cur.cost} -> ${cost}`);
  if (active !== undefined) await audit(req, 'part.active', `${req.params.id} ${active ? 'active' : 'inactive'}`);
  if (vendorId !== undefined && newVendorId !== cur.vendor_id) await audit(req, 'part.vendor', `${req.params.id} -> ${newVendorId || '(none)'}`);
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
// ---- Cycle counts: operations specialist records; OM/GM approves before on-hand + QB post ----
app.post('/api/cycle-counts', authMiddleware, requireOpsCount, async (req, res) => {
  try { res.json(await inventory.createCycleCount(req.body?.lines, req.body?.note, req.user)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/cycle-counts', authMiddleware, requireOpsCount, async (req, res) => res.json(await inventory.listCycleCounts(req.query.status)));
app.get('/api/cycle-counts/:id', authMiddleware, requireOpsCount, async (req, res) => {
  const d = await inventory.cycleCountDetail(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(d);
});
app.post('/api/cycle-counts/:id/approve', authMiddleware, requireCountApprover, async (req, res) => {
  try {
    const r = await inventory.approveCycleCount(Number(req.params.id), req.user);
    await audit(req, 'cyclecount.approve', `CC-${req.params.id} net $${Math.round(r.netValue)} (QB ${r.qb})`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/cycle-counts/:id/reject', authMiddleware, requireCountApprover, async (req, res) => {
  try { const r = await inventory.rejectCycleCount(Number(req.params.id), req.user, req.body?.note); await audit(req, 'cyclecount.reject', `CC-${req.params.id}`); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- models / BOMs ----
app.get('/api/models', authMiddleware, async (_req, res) => res.json(await modelsSummary()));
app.get('/api/models/:id', authMiddleware, async (req, res) => {
  const r = await modelRollup(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});
app.post('/api/models/:id/bom', authMiddleware, requireTier('admin'), async (req, res) => {
  const { partId, qty } = req.body || {};
  if (!partId || !qty) return res.status(400).json({ error: 'partId and qty required' });
  await q('INSERT INTO bom_line(model_id,part_id,qty) VALUES ($1,$2,$3) ON CONFLICT(model_id,part_id) DO UPDATE SET qty=$3',
    [req.params.id, partId, Number(qty)]);
  await audit(req, 'bom.update', `${req.params.id}+${partId} qty=${qty}`);
  res.json({ ok: true });
});
app.patch('/api/models/:id/bom/:partId', authMiddleware, requireTier('admin'), async (req, res) => {
  const { qty } = req.body || {};
  if (!qty) return res.status(400).json({ error: 'qty required' });
  await q('UPDATE bom_line SET qty=$1 WHERE model_id=$2 AND part_id=$3', [Number(qty), req.params.id, req.params.partId]);
  await audit(req, 'bom.update', `${req.params.id} ${req.params.partId} qty=${qty}`);
  res.json({ ok: true });
});
app.delete('/api/models/:id/bom/:partId', authMiddleware, requireTier('admin'), async (req, res) => {
  await q('DELETE FROM bom_line WHERE model_id=$1 AND part_id=$2', [req.params.id, req.params.partId]);
  await audit(req, 'bom.delete', `${req.params.id} ${req.params.partId}`);
  res.json({ ok: true });
});
app.post('/api/models/:id/labor', authMiddleware, requireTier('admin'), async (req, res) => {
  const { ws, hours, rate } = req.body || {};
  if (!ws || !hours) return res.status(400).json({ error: 'ws and hours required' });
  await q('INSERT INTO model_labor(model_id,ws,hours,rate) VALUES ($1,$2,$3,$4) ON CONFLICT(model_id,ws) DO UPDATE SET hours=$3,rate=$4',
    [req.params.id, ws, Number(hours), Number(rate) || 35]);
  await audit(req, 'labor.update', `${req.params.id} ${ws} ${hours}h`);
  res.json({ ok: true });
});
app.delete('/api/models/:id/labor/:ws', authMiddleware, requireTier('admin'), async (req, res) => {
  await q('DELETE FROM model_labor WHERE model_id=$1 AND ws=$2', [req.params.id, req.params.ws]);
  await audit(req, 'labor.delete', `${req.params.id} ${req.params.ws}`);
  res.json({ ok: true });
});
// Stage-tag a BOM line or labor step. This is operational (it controls WHEN cost accrues,
// not the amount) so it's a direct admin edit, not part of the cost-change approval flow.
const BOM_STAGES = ['Build', 'Paint/Powder Coat', 'Finish'];
app.patch('/api/models/:id/bom/:partId/stage', authMiddleware, requireTier('admin'), async (req, res) => {
  if (!BOM_STAGES.includes(req.body?.stage)) return res.status(400).json({ error: 'invalid stage' });
  await q('UPDATE bom_line SET stage=$1 WHERE model_id=$2 AND part_id=$3', [req.body.stage, req.params.id, req.params.partId]);
  await audit(req, 'bom.stage', `${req.params.id} ${req.params.partId} → ${req.body.stage}`);
  res.json({ ok: true });
});
app.patch('/api/models/:id/labor/:ws/stage', authMiddleware, requireTier('admin'), async (req, res) => {
  if (!BOM_STAGES.includes(req.body?.stage)) return res.status(400).json({ error: 'invalid stage' });
  await q('UPDATE model_labor SET stage=$1 WHERE model_id=$2 AND ws=$3', [req.body.stage, req.params.id, req.params.ws]);
  await audit(req, 'labor.stage', `${req.params.id} ${req.params.ws} → ${req.body.stage}`);
  res.json({ ok: true });
});
// ---- BOM change requests (accounting approval workflow) ----
app.post('/api/bom-change-requests', authMiddleware, requireTier('editor'), async (req, res) => {
  const { modelId, modelName, op, payload } = req.body || {};
  if (!modelId || !op || !payload) return res.status(400).json({ error: 'modelId, op, and payload required' });
  const u = req.user;
  const r = await one(
    `INSERT INTO bom_change_request(model_id,model_name,requested_by,requester_name,op,payload) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [modelId, modelName || modelId, u.id, u.name, op, JSON.stringify(payload)]
  );
  await audit(req, 'bom.change_request', `CR#${r.id} ${modelId} op=${op}`);
  res.json({ id: r.id });
});

app.get('/api/bom-change-requests', authMiddleware, async (req, res) => {
  const { modelId, status } = req.query;
  let sql = 'SELECT * FROM bom_change_request WHERE 1=1';
  const params = [];
  if (modelId) { params.push(modelId); sql += ` AND model_id=$${params.length}`; }
  if (status)  { params.push(status);  sql += ` AND status=$${params.length}`; }
  res.json(await all(sql + ' ORDER BY created_at DESC', params));
});

app.post('/api/bom-change-requests/:id/approve', authMiddleware, requireSection('accounting'), async (req, res) => {
  const cr = await one('SELECT * FROM bom_change_request WHERE id=$1', [Number(req.params.id)]);
  if (!cr) return res.status(404).json({ error: 'not found' });
  if (cr.status !== 'pending') return res.status(400).json({ error: 'already reviewed' });
  const p = cr.payload;
  switch (cr.op) {
    case 'update_qty':
      await q('UPDATE bom_line SET qty=$1 WHERE model_id=$2 AND part_id=$3', [p.newQty, cr.model_id, p.partId]); break;
    case 'add_part':
      await q('INSERT INTO bom_line(model_id,part_id,qty) VALUES($1,$2,$3) ON CONFLICT(model_id,part_id) DO UPDATE SET qty=$3', [cr.model_id, p.partId, p.qty]); break;
    case 'remove_part':
      await q('DELETE FROM bom_line WHERE model_id=$1 AND part_id=$2', [cr.model_id, p.partId]); break;
    case 'update_labor':
      await q('UPDATE model_labor SET hours=$1,rate=$2 WHERE model_id=$3 AND ws=$4', [p.newHours, p.newRate, cr.model_id, p.ws]); break;
    case 'add_labor':
      await q('INSERT INTO model_labor(model_id,ws,hours,rate) VALUES($1,$2,$3,$4) ON CONFLICT(model_id,ws) DO UPDATE SET hours=$3,rate=$4', [cr.model_id, p.ws, p.hours, p.rate]); break;
    case 'remove_labor':
      await q('DELETE FROM model_labor WHERE model_id=$1 AND ws=$2', [cr.model_id, p.ws]); break;
    default: return res.status(400).json({ error: 'unknown op' });
  }
  const u = req.user;
  await q(`UPDATE bom_change_request SET status='approved',reviewed_by=$1,reviewer_name=$2,reviewed_at=now() WHERE id=$3`, [u.id, u.name, cr.id]);
  await audit(req, 'bom.approved', `CR#${cr.id} ${cr.model_id} ${cr.op}`);
  res.json({ ok: true });
});

app.post('/api/bom-change-requests/:id/reject', authMiddleware, requireSection('accounting'), async (req, res) => {
  const { note } = req.body || {};
  const cr = await one('SELECT * FROM bom_change_request WHERE id=$1', [Number(req.params.id)]);
  if (!cr) return res.status(404).json({ error: 'not found' });
  if (cr.status !== 'pending') return res.status(400).json({ error: 'already reviewed' });
  const u = req.user;
  await q(`UPDATE bom_change_request SET status='rejected',reviewed_by=$1,reviewer_name=$2,reviewed_at=now(),review_note=$3 WHERE id=$4`, [u.id, u.name, note || null, cr.id]);
  await audit(req, 'bom.rejected', `CR#${cr.id} ${cr.model_id} ${cr.op}`);
  res.json({ ok: true });
});

app.get('/api/roles', authMiddleware, async (_req, res) => {
  const roles = await all('SELECT name,tier FROM role ORDER BY tier,name', []);
  for (const r of roles) {
    const rows = await all('SELECT section FROM role_section WHERE role_name=$1', [r.name]);
    r.sections = rows.map(x => x.section);
  }
  res.json(roles);
});
app.post('/api/roles', authMiddleware, requireTier('admin'), async (req, res) => {
  const { name, tier, sections } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!['admin','editor','viewer'].includes(tier)) return res.status(400).json({ error: 'invalid tier' });
  await q('INSERT INTO role(name,tier) VALUES ($1,$2) ON CONFLICT(name) DO UPDATE SET tier=$2', [name.trim(), tier]);
  if (sections) {
    await q('DELETE FROM role_section WHERE role_name=$1', [name.trim()]);
    for (const s of sections) await q('INSERT INTO role_section(role_name,section) VALUES($1,$2) ON CONFLICT DO NOTHING', [name.trim(), s]);
  }
  await audit(req, 'role.create', `${name.trim()}→${tier}`);
  res.json({ ok: true });
});
app.patch('/api/roles/:name', authMiddleware, requireTier('admin'), async (req, res) => {
  const { tier, sections } = req.body || {};
  if (tier) {
    if (!['admin','editor','viewer'].includes(tier)) return res.status(400).json({ error: 'invalid tier' });
    await q('INSERT INTO role(name,tier) VALUES ($1,$2) ON CONFLICT(name) DO UPDATE SET tier=$2', [req.params.name, tier]);
    await audit(req, 'role.update', `${req.params.name}→${tier}`);
  }
  if (sections !== undefined) {
    await q('DELETE FROM role_section WHERE role_name=$1', [req.params.name]);
    for (const s of sections) await q('INSERT INTO role_section(role_name,section) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.name, s]);
    await audit(req, 'role.sections', `${req.params.name}: ${sections.join(',')}`);
  }
  res.json({ ok: true });
});
app.delete('/api/roles/:name', authMiddleware, requireTier('admin'), async (req, res) => {
  const inUse = await one('SELECT 1 FROM user_title WHERE role_name=$1 LIMIT 1', [req.params.name]);
  if (inUse) return res.status(409).json({ error: 'This title is assigned to one or more users. Reassign them first.' });
  await q('DELETE FROM role WHERE name=$1', [req.params.name]);
  await audit(req, 'role.delete', req.params.name);
  res.json({ ok: true });
});
app.get('/api/users/:id/titles', authMiddleware, async (req, res) => {
  res.json(await all('SELECT role_name FROM user_title WHERE user_id=$1', [req.params.id]));
});
app.post('/api/users/:id/titles', authMiddleware, requireTier('admin'), async (req, res) => {
  const { roleName } = req.body || {};
  if (!roleName) return res.status(400).json({ error: 'roleName required' });
  await q('INSERT INTO user_title(user_id,role_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.id, roleName]);
  // Upgrade user's permission tier if new role has higher tier
  const r = await one('SELECT tier FROM role WHERE name=$1', [roleName]);
  if (r) {
    const RANK = { viewer:0, editor:1, admin:2 };
    const cur = await one('SELECT role FROM app_user WHERE id=$1', [req.params.id]);
    if (cur && RANK[r.tier] > RANK[cur.role]) await q('UPDATE app_user SET role=$1,title=$2 WHERE id=$3', [r.tier, roleName, req.params.id]);
  }
  await audit(req, 'user.title.add', `${req.params.id}+${roleName}`);
  res.json({ ok: true });
});
app.delete('/api/users/:id/titles/:roleName', authMiddleware, requireTier('admin'), async (req, res) => {
  await q('DELETE FROM user_title WHERE user_id=$1 AND role_name=$2', [req.params.id, req.params.roleName]);
  // Recalculate user's tier from remaining titles
  const remaining = await all('SELECT r.tier FROM user_title ut JOIN role r ON r.name=ut.role_name WHERE ut.user_id=$1', [req.params.id]);
  const RANK = { viewer:0, editor:1, admin:2 };
  const topTier = remaining.reduce((best,r) => RANK[r.tier]>RANK[best]?r.tier:best, 'viewer');
  const topTitle = (await one('SELECT role_name FROM user_title WHERE user_id=$1 LIMIT 1', [req.params.id]))?.role_name || null;
  await q('UPDATE app_user SET role=$1,title=$2 WHERE id=$3', [topTier, topTitle, req.params.id]);
  await audit(req, 'user.title.remove', `${req.params.id}-${req.params.roleName}`);
  res.json({ ok: true });
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

// ---- global search (Cmd+K) — jump to an order, VIN, customer, part, or model ----
app.get('/api/search', authMiddleware, async (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (raw.length < 2) return res.json({ orders: [], units: [], customers: [], parts: [], models: [] });
  const like = '%' + raw.replace(/[\\%_]/g, '\\$&') + '%';
  const [orders, units, customers, parts, models] = await Promise.all([
    all(`SELECT o.id, o.stage, c.name AS customer, m.name AS model FROM sales_order o
           LEFT JOIN customer c ON c.id=o.customer_id LEFT JOIN model m ON m.id=o.model_id
          WHERE o.id ILIKE $1 OR c.name ILIKE $1 ORDER BY o.created_at DESC NULLS LAST, o.id DESC LIMIT 5`, [like]),
    all(`SELECT t.id, t.vin, t.order_id, m.name AS model FROM trailer t LEFT JOIN model m ON m.id=t.model_id
          WHERE t.vin ILIKE $1 ORDER BY t.vin LIMIT 5`, [like]),
    all(`SELECT id, name, kind FROM customer WHERE name ILIKE $1 OR contact ILIKE $1 ORDER BY name LIMIT 5`, [like]),
    all(`SELECT id, name FROM part WHERE id ILIKE $1 OR name ILIKE $1 ORDER BY id LIMIT 5`, [like]),
    all(`SELECT id, name FROM model WHERE id ILIKE $1 OR name ILIKE $1 ORDER BY id LIMIT 5`, [like]),
  ]);
  res.json({
    orders: orders.map(o => ({ id: o.id, stage: o.stage, customer: o.customer, model: o.model })),
    units: units.map(u => ({ id: u.id, vin: u.vin, orderId: u.order_id, model: u.model })),
    customers: customers.map(c => ({ id: c.id, name: c.name, kind: c.kind })),
    parts: parts.map(p => ({ id: p.id, name: p.name })),
    models: models.map(m => ({ id: m.id, name: m.name })),
  });
});

// ---- customers / dealers (Phase 2) ----
app.get('/api/customers', authMiddleware, async (_req, res) => res.json(await customersWithTypes()));
app.post('/api/customers', authMiddleware, requireSales, async (req, res) => {
  const { name, kind, allowed, phone, contact, smsConsent, address, city, state, zip } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'c' + Date.now();
  const normalizedPhone = phone ? sms.normalizePhone(phone) : null;
  // Auto-link if they already opted in via keyword or web form
  const priorOptin = normalizedPhone ? await sms.checkOptin(normalizedPhone) : null;
  const effectiveConsent = !!(smsConsent || priorOptin);
  const consentAt = effectiveConsent ? new Date().toISOString() : null;
  const st = (state || '').toUpperCase().slice(0, 2) || null;
  const g = address ? await geocodeAddress({ address, city, state: st, zip }) : null;
  await q('INSERT INTO customer(id,name,kind,rep_id,phone,contact,sms_consent,sms_consent_at,address,city,state,zip,lat,lng) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [id, name, kind || 'Dealership', req.user.id, normalizedPhone || null, contact || null, effectiveConsent, consentAt, address || null, city || null, st, zip || null, g?.lat ?? null, g?.lng ?? null]);
  for (const t of (allowed || [])) await q('INSERT INTO customer_allowed_type(customer_id,type) VALUES ($1,$2)', [id, t]);
  await audit(req, 'customer.create', `${name}${effectiveConsent ? ' [sms-consent]' : ''}`);
  res.json({ id, smsConsentAutoLinked: !!(priorOptin && !smsConsent) });
});
app.patch('/api/customers/:id/types', authMiddleware, requireSales, async (req, res) => {
  const { type, on } = req.body || {};
  if (on) await q('INSERT INTO customer_allowed_type(customer_id,type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, type]);
  else await q('DELETE FROM customer_allowed_type WHERE customer_id=$1 AND type=$2', [req.params.id, type]);
  await audit(req, 'customer.types', `${req.params.id} ${on ? '+' : '-'}${type}`);
  res.json({ ok: true });
});
// Update a customer/dealer: soft-active (app use), kind (Dealership/Customer), or details.
app.patch('/api/customers/:id', authMiddleware, requireSales, async (req, res) => {
  const { active, kind, name, contact, phone, address, city, state, zip, lat, lng } = req.body || {};
  const cur = await one('SELECT * FROM customer WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const normalizedPhone = phone !== undefined ? (phone ? sms.normalizePhone(phone) : null) : cur.phone;
  const addr = address !== undefined ? (address || null) : cur.address;
  const ci = city !== undefined ? (city || null) : cur.city;
  const st = state !== undefined ? ((state || '').toUpperCase().slice(0, 2) || null) : cur.state;
  const zp = zip !== undefined ? (zip || null) : cur.zip;
  // Coordinates: an explicit lat/lng wins; otherwise, if the address changed, geocode it.
  let la = lat !== undefined ? (lat === '' || lat === null ? null : Number(lat)) : (cur.lat == null ? null : Number(cur.lat));
  let ln = lng !== undefined ? (lng === '' || lng === null ? null : Number(lng)) : (cur.lng == null ? null : Number(cur.lng));
  const addrChanged = addr !== cur.address || ci !== cur.city || st !== cur.state || zp !== cur.zip;
  if (lat === undefined && lng === undefined && addrChanged && addr) {
    const g = await geocodeAddress({ address: addr, city: ci, state: st, zip: zp });
    if (g) { la = g.lat; ln = g.lng; }
  }
  await q('UPDATE customer SET active=$1, kind=$2, name=$3, contact=$4, phone=$5, address=$6, city=$7, state=$8, zip=$9, lat=$10, lng=$11 WHERE id=$12',
    [active !== undefined ? !!active : (cur.active !== false), kind ?? cur.kind, name ?? cur.name,
     contact !== undefined ? (contact || null) : cur.contact, normalizedPhone, addr, ci, st, zp, la, ln, req.params.id]);
  await audit(req, 'customer.update', `${req.params.id}${active !== undefined ? (active ? ' [active]' : ' [inactive]') : ''}`);
  res.json({ ok: true, geocoded: la != null && ln != null });
});
// Merge a duplicate customer into a survivor (admin only, irreversible). Repoints every table
// that references the duplicate, backfills any fields the survivor is missing, records the merge
// in customer_merge (so a QuickBooks pull can't resurrect the duplicate), then deletes it.
app.post('/api/customers/:id/merge', authMiddleware, requireTier('admin'), async (req, res) => {
  const dupId = req.params.id, intoId = req.body?.into;
  if (!intoId) return res.status(400).json({ error: 'Choose the customer to merge into.' });
  if (intoId === dupId) return res.status(400).json({ error: 'Pick two different customers.' });
  const dup = await one('SELECT * FROM customer WHERE id=$1', [dupId]);
  const into = await one('SELECT * FROM customer WHERE id=$1', [intoId]);
  if (!dup || !into) return res.status(404).json({ error: 'Customer not found.' });
  const counts = {};
  const repoint = async (label, sql, params) => { const r = await q(sql, params); counts[label] = r.rowCount ?? r.affectedRows ?? 0; };
  await repoint('orders', 'UPDATE sales_order SET customer_id=$1 WHERE customer_id=$2', [intoId, dupId]);
  await repoint('trailers', 'UPDATE trailer SET customer_id=$1 WHERE customer_id=$2', [intoId, dupId]);
  await repoint('dealerLogins', 'UPDATE dealer_user SET customer_id=$1 WHERE customer_id=$2', [intoId, dupId]);
  await repoint('invoiceBatches', 'UPDATE invoice_batch SET customer_id=$1, customer_name=$2 WHERE customer_id=$3', [intoId, into.name, dupId]);
  await repoint('notifications', 'UPDATE dealer_notification SET customer_id=$1 WHERE customer_id=$2', [intoId, dupId]);
  await repoint('pushSubs', `UPDATE push_subscription SET owner_id=$1 WHERE owner_type='dealer' AND owner_id=$2`, [intoId, dupId]);
  // Allowed trailer types: union of both (PK (customer_id,type) — copy-ignore, then drop the dup's).
  await q(`INSERT INTO customer_allowed_type(customer_id,type)
             SELECT $1, type FROM customer_allowed_type WHERE customer_id=$2
             ON CONFLICT DO NOTHING`, [intoId, dupId]);
  await q('DELETE FROM customer_allowed_type WHERE customer_id=$1', [dupId]);
  // Backfill anything the survivor is missing from the duplicate (never overwrite).
  await q(`UPDATE customer SET
             contact=COALESCE(contact,$2), phone=COALESCE(phone,$3), rep_id=COALESCE(rep_id,$4),
             address=COALESCE(address,$5), city=COALESCE(city,$6), state=COALESCE(state,$7), zip=COALESCE(zip,$8),
             lat=COALESCE(lat,$9), lng=COALESCE(lng,$10),
             sms_consent=(sms_consent OR $11), sms_consent_at=COALESCE(sms_consent_at,$12)
           WHERE id=$1`,
    [intoId, dup.contact, dup.phone, dup.rep_id, dup.address, dup.city, dup.state, dup.zip,
     dup.lat, dup.lng, !!dup.sms_consent, dup.sms_consent_at]);
  // Remember the merge (and re-aim any older merges that pointed at the duplicate), then delete.
  await q(`INSERT INTO customer_merge(old_id,new_id,merged_by) VALUES ($1,$2,$3)
             ON CONFLICT(old_id) DO UPDATE SET new_id=$2, merged_at=now(), merged_by=$3`, [dupId, intoId, req.user.id]);
  await q('UPDATE customer_merge SET new_id=$1 WHERE new_id=$2', [intoId, dupId]);
  await q('DELETE FROM customer WHERE id=$1', [dupId]);
  await audit(req, 'customer.merge', `${dupId} (${dup.name}) -> ${intoId} (${into.name}) ${JSON.stringify(counts)}`);
  res.json({ ok: true, into: intoId, moved: counts });
});
// Dealer portal logins tied to this dealership + a staff-assisted reset — for when a dealer is
// locked out and can't (or didn't) use the dealer portal's own email self-service.
app.get('/api/customers/:id/dealer-accounts', authMiddleware, requireSales, async (req, res) => res.json(await dealer.accountsForCustomer(req.params.id)));
app.post('/api/dealer-accounts/:id/reset-password', authMiddleware, requireSales, async (req, res) => {
  try { res.json(await dealer.adminResetPassword(req.params.id, req.body?.password)); await audit(req, 'dealer.password', req.params.id); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- orders / fulfillment (Phase 2) ----
app.get('/api/orders', authMiddleware, async (_req, res) => res.json({ stages: STAGES, orders: await ordersFull() }));
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  const o = (await ordersFull()).find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  const lines = await all(`SELECT b.part_id, b.qty, p.name, p.on_hand FROM bom_line b JOIN part p ON p.id=b.part_id WHERE b.model_id=$1`, [o.modelId]);
  o.bom = lines.map(l => ({ partId: l.part_id, name: l.name, need: Math.round(Number(l.qty) * o.qty), onHand: l.on_hand, short: l.on_hand < Number(l.qty) * o.qty }));
  const extra = await one('SELECT note, cancel_reason FROM sales_order WHERE id=$1', [req.params.id]);
  o.note = extra?.note || null;
  o.cancelReason = extra?.cancel_reason || null;
  o.build = await boatbuilder.orderBuild(req.params.id).catch(() => null); // boat-build config, if any
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
  const seqRow = await one('SELECT COALESCE(MAX(production_seq),0)+1 AS n FROM sales_order', []);
  await q('INSERT INTO sales_order(id,customer_id,model_id,qty,stage,due,deposit,channel,rep_id,production_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, customerId, modelId, Math.max(1, Number(qty) || 1), 'Quote', due || null, 0, 'Sales', req.user.id, seqRow?.n || 1]);
  await audit(req, 'order.create', `${id} ${cust.name} ${mdl.category} x${qty}`);
  res.json({ id });
});
// Build-to-stock: a production order with no customer yet. Flows through the stages and gets a
// VIN like any build; its MSO is held until the trailer is sold (a customer assigned below).
app.post('/api/orders/stock', authMiddleware, requireStockCreator, async (req, res) => {
  const { modelId, qty, due } = req.body || {};
  const mdl = await one('SELECT * FROM model WHERE id=$1', [modelId]);
  if (!mdl) return res.status(400).json({ error: 'model required' });
  const n = Math.max(1, Number(qty) || 1);
  const id = 'SO-' + (1049 + (await all('SELECT id FROM sales_order', [])).length);
  const seqRow = await one('SELECT COALESCE(MAX(production_seq),0)+1 AS n FROM sales_order', []);
  await q('INSERT INTO sales_order(id,customer_id,model_id,qty,stage,due,deposit,channel,rep_id,production_seq) VALUES ($1,NULL,$2,$3,$4,$5,0,$6,$7,$8)',
    [id, modelId, n, 'Scheduled', due || null, 'Stock', req.user.id, seqRow?.n || 1]);
  await audit(req, 'order.stock', `${id} STOCK ${mdl.category} x${n}`);
  res.json({ id, stock: true });
});
// Assign a customer to a stock order (it's been sold) and release any held MSOs.
app.post('/api/orders/:id/customer', authMiddleware, requireSales, async (req, res) => {
  const { customerId } = req.body || {};
  const o = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const cust = await one('SELECT * FROM customer WHERE id=$1', [customerId]);
  if (!cust) return res.status(400).json({ error: 'customer required' });
  const mdl = await one('SELECT category FROM model WHERE id=$1', [o.model_id]);
  const allowed = await allowedTypesFor(customerId);
  if (mdl && !allowed.includes(mdl.category))
    return res.status(403).json({ error: `${cust.name} is not authorized to take ${mdl.category} trailers` });
  await q('UPDATE sales_order SET customer_id=$1 WHERE id=$2', [customerId, o.id]);
  await q('UPDATE trailer SET customer_id=$1 WHERE order_id=$2', [customerId, o.id]);
  const msosQueued = await trailers.releaseMsosIfPaintDone(o.id);
  await audit(req, 'order.sold', `${o.id} -> ${cust.name}${msosQueued ? ` (${msosQueued} MSO queued)` : ''}`);
  res.json({ ok: true, msosQueued });
});
// Resequence the production queue — order = full ordered array of order IDs
app.post('/api/orders/production-order', authMiddleware, requireProductionPlanner, async (req, res) => {
  const ids = Array.isArray(req.body?.order) ? req.body.order.filter(x => typeof x === 'string') : null;
  if (!ids || !ids.length) return res.status(400).json({ error: 'order array required' });
  const n = await setProductionOrder(ids);
  await audit(req, 'order.reorder', `${n} orders resequenced`);
  res.json({ ok: true, count: n });
});
// One code path for every stage change — the desktop Production Flow AND the shop-floor
// station page — so VIN assignment, print queues, customer SMS, and dealer notifications
// can never diverge between the two.
async function applyOrderStage(orderId, curOrder, stage, actorUser, actorLabel) {
  await q('UPDATE sales_order SET stage=$1 WHERE id=$2', [stage, orderId]);
  await trailers.afterStageChange(orderId, curOrder.stage, stage, actorUser); // VINs at Build, print queues at Paint
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [actorUser?.id || null, 'order.stage', `${orderId} -> ${stage}${actorLabel ? ` (${actorLabel})` : ''}`]).catch(() => {});
  await sms.notifyOrderStage(orderId, stage, actorUser?.id || null); // Phase 6: text the customer
  await dealernotify.notifyDealer(curOrder.customer_id, 'order', `Order ${orderId} is now "${stage}".`, orderId);
}
app.patch('/api/orders/:id/stage', authMiddleware, requireTier('editor'), async (req, res) => {
  const stage = req.body?.stage;
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'invalid stage' });
  const cur = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  await applyOrderStage(req.params.id, cur, stage, req.user);
  res.json({ ok: true });
});
// Reject / cancel an order (a dealer quote we won't accept, or any non-invoiced order). Soft: keeps
// the record, drops it off the board (stage 'Cancelled'), reversible, and notifies the dealer.
app.post('/api/orders/:id/cancel', authMiddleware, requireSales, async (req, res) => {
  const cur = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.billed) return res.status(400).json({ error: 'This order is already invoiced — it can\'t be rejected.' });
  if (cur.stage === 'Cancelled') return res.json({ ok: true });
  const reason = (req.body?.reason || '').trim() || null;
  await q(`UPDATE sales_order SET prev_stage=$1, stage='Cancelled', cancel_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$4`,
    [cur.stage, reason, req.user.id, req.params.id]);
  await audit(req, 'order.cancel', `${req.params.id}${reason ? ': ' + reason : ''}`);
  await dealernotify.notifyDealer(cur.customer_id, 'order', `Order ${req.params.id} was not accepted${reason ? ': ' + reason : '.'}`, req.params.id);
  res.json({ ok: true });
});
app.post('/api/orders/:id/uncancel', authMiddleware, requireSales, async (req, res) => {
  const cur = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.stage !== 'Cancelled') return res.status(400).json({ error: 'Order is not cancelled.' });
  const back = cur.prev_stage || 'Quote';
  await q(`UPDATE sales_order SET stage=$1, cancel_reason=NULL, cancelled_by=NULL, cancelled_at=NULL, prev_stage=NULL WHERE id=$2`, [back, req.params.id]);
  await audit(req, 'order.uncancel', `${req.params.id} -> ${back}`);
  res.json({ ok: true, stage: back });
});
// Edit order details. Due/deposit/note are always editable; quantity locks once VINs are assigned
// (changing it would desync the trailer units); customer locks once invoiced.
app.patch('/api/orders/:id', authMiddleware, requireSales, async (req, res) => {
  const cur = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const sets = [], vals = [];
  const set = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
  if (b.due !== undefined) set('due', b.due || null);
  if (b.deposit !== undefined) set('deposit', Number(b.deposit) || 0);
  if (b.note !== undefined) set('note', b.note || null);
  if (b.qty !== undefined && Number(b.qty) !== cur.qty) {
    const vins = await one('SELECT COUNT(*)::int AS n FROM trailer WHERE order_id=$1', [req.params.id]);
    if ((vins?.n || 0) > 0 || cur.consumed) return res.status(400).json({ error: 'Quantity is locked once VINs are assigned or the order is in production.' });
    set('qty', Math.max(1, Number(b.qty) || 1));
  }
  if (b.customerId !== undefined && b.customerId !== cur.customer_id) {
    if (cur.billed) return res.status(400).json({ error: 'Customer is locked once the order is invoiced.' });
    if (b.customerId) {
      const mdl = await one('SELECT category FROM model WHERE id=$1', [cur.model_id]);
      const allowed = await allowedTypesFor(b.customerId);
      if (mdl && !allowed.includes(mdl.category)) return res.status(403).json({ error: `That customer isn't authorized for ${mdl.category} trailers.` });
      await q('UPDATE trailer SET customer_id=$1 WHERE order_id=$2', [b.customerId, req.params.id]);
    }
    set('customer_id', b.customerId || null);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await q(`UPDATE sales_order SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  await audit(req, 'order.edit', `${req.params.id} (${sets.map(s => s.split('=')[0]).join(', ')})`);
  res.json({ ok: true });
});
// Re-configure the boat build on an existing order (re-validates, re-prices, rebuilds the BOM).
app.post('/api/orders/:id/boat-build', authMiddleware, requireSales, async (req, res) => {
  try { res.json(await boatbuilder.updateBuild(req.params.id, req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
// Invoice a finished (Ready) order: consume its BOM from inventory, post the customer
// invoice, mark it billed, and drop it off the Build board. Decoupled from the stage so
// "Ready" just means waiting to invoice.
app.post('/api/orders/:id/invoice', authMiddleware, requireSales, async (req, res) => {
  const cur = await one('SELECT * FROM sales_order WHERE id=$1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.billed) return res.status(400).json({ error: 'This order is already invoiced.' });
  // Orders synced from QuickBooks already have an invoice there — never re-post a duplicate.
  if (cur.channel === 'QuickBooks') return res.status(400).json({ error: 'This order was imported from QuickBooks and is already invoiced there.' });
  if (cur.stage !== 'Ready') return res.status(400).json({ error: 'Move the order to Ready before invoicing.' });
  if (cur.invoice_batch_id) return res.status(400).json({ error: 'This order is part of an invoice batch — invoice the batch instead.' });
  await consumeInventory(req.params.id, req.user.id); // catch-up any unconsumed stages + post invoice/COGS + mark billed
  await audit(req, 'order.invoice', req.params.id);
  await dealernotify.notifyDealer(cur.customer_id, 'order', `Order ${req.params.id} has been invoiced.`, req.params.id);
  res.json({ ok: true });
});
// ---- Phase 4: WIP — daily production updates by user & workstation ----
app.get('/api/workstations', authMiddleware, async (_req, res) => res.json(await workstations()));
app.post('/api/work-log', authMiddleware, async (req, res) => {
  const { orderId, workstation, stage, hours, note, stageComplete } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  // Employees log their own work; an admin or shop/office/general manager may log for another user.
  const canLogForOthers = req.user.role === 'admin' || (req.user.titles || []).some(t => ['Shop Manager', 'General Manager', 'Office Manager'].includes(t));
  const userId = (req.body?.userId && canLogForOthers) ? req.body.userId : req.user.id;
  try {
    const r = await logWork({ userId, orderId, workstation, stage, hours, note, stageComplete, logDate: req.body?.logDate });
    if (r.advanced) await trailers.afterStageChange(orderId, r.stage, r.advanced, req.user); // queue VIN/MSO prints as paint begins/completes
    await audit(req, 'work.log', `${orderId} ${workstation || ''} ${Number(hours) || 0}h${r.consumed?.consumed ? ` — ${r.stage} complete, $${Math.round(r.consumed.materialValue)} consumed` : ''}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/work-log/daily', authMiddleware, async (req, res) => res.json(await dailyReport(req.query.date)));
app.get('/api/wip', authMiddleware, async (_req, res) => res.json(await wipReport()));
app.get('/api/wip/by-workstation', authMiddleware, async (req, res) => res.json(await consumptionByWorkstation(req.query.from, req.query.to)));

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
    const result = await createPO(partId, Math.max(1, Math.round(Number(qty) || 0)), req.user.id);
    res.json(result);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/po/:id/receive', authMiddleware, requireTier('editor'), async (req, res) => {
  try { const ok = await receivePO(req.params.id, req.user.id); res.json({ ok }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/po/:id/approvals', authMiddleware, async (req, res) => {
  res.json(await approvals.approvalStatusFor(req.params.id));
});
app.post('/api/mrp/auto', authMiddleware, requireTier('editor'), async (req, res) => {
  const rows = (await mrp()).filter(r => r.sev !== 'ok' && r.type === 'P');
  const created = [];
  for (const r of rows) created.push(await createPO(r.id, r.suggestQty, req.user.id));
  res.json({ created: created.length, ids: created.map(r => r.id || r) });
});

// ---- vendors ----
app.get('/api/vendors', authMiddleware, async (_req, res) => res.json(await approvals.listVendors()));
app.post('/api/vendors', authMiddleware, requireTier('admin'), async (req, res) => {
  try {
    const { name, leadDays, terms } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = await approvals.createVendor({ name, leadDays, terms }, req.user.id);
    await audit(req, 'vendor.create', `${name} → ${result.status}`);
    res.json(result);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- approval rules (admin) ----
app.get('/api/approval-rules', authMiddleware, async (_req, res) => res.json(await approvals.listRules()));
app.post('/api/approval-rules', authMiddleware, requireTier('admin'), async (req, res) => {
  try { const id = await approvals.createRule(req.body || {}); await audit(req, 'approval.rule.create', id); res.json({ id }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.patch('/api/approval-rules/:id', authMiddleware, requireTier('admin'), async (req, res) => {
  try { await approvals.updateRule(req.params.id, req.body || {}); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.delete('/api/approval-rules/:id', authMiddleware, requireTier('admin'), async (req, res) => {
  await approvals.deleteRule(req.params.id); await audit(req, 'approval.rule.delete', req.params.id); res.json({ ok: true });
});

// ---- in-app approvals ----
app.get('/api/approvals/pending', authMiddleware, async (req, res) => {
  res.json(await approvals.pendingForUser(req.user.id));
});
app.get('/api/approvals/pending-count', authMiddleware, async (req, res) => {
  res.json({ count: await approvals.pendingCount(req.user.id) });
});
app.post('/api/approvals/:token/decide', authMiddleware, async (req, res) => {
  try {
    const { decision, note } = req.body || {};
    const result = await approvals.processDecision(req.params.token, decision, note, req.user.id);
    await audit(req, `approval.${decision}`, `${req.params.token.slice(0,8)} → ${result.refId}`);
    res.json(result);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- public token-based approval page (no auth required) ----
app.get('/approve/:token', async (req, res) => {
  const req2 = await import('./db.js').then(m => m.one(
    `SELECT ar.*, u.name AS approver_name, r2.name AS requester_name
     FROM approval_request ar
     LEFT JOIN app_user u ON u.id=ar.approver_id
     LEFT JOIN app_user r2 ON r2.id=ar.requested_by
     WHERE ar.token=$1`, [req.params.token]));
  if (!req2) return res.status(404).send('<h2>Approval link not found or expired.</h2>');
  const done = req2.status !== 'pending';
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const amtStr = req2.ref_amount ? `$${Number(req2.ref_amount).toLocaleString('en-US',{minimumFractionDigits:2})}` : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Built Trailers — Approval</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:40px auto;padding:20px;color:#1a1a2e}
h2{color:#f59e0b}p{margin:6px 0}.card{background:#f8f8fb;border-radius:10px;padding:20px;margin:16px 0}
label{display:block;font-size:13px;color:#666;margin-bottom:4px}textarea{width:100%;border:1px solid #ccc;border-radius:6px;padding:8px;font-size:14px;resize:vertical}
.btn{display:inline-block;padding:12px 28px;border:none;border-radius:7px;font-size:16px;font-weight:600;cursor:pointer;margin-right:10px;margin-top:12px}
.approve{background:#22c55e;color:#fff}.reject{background:#ef4444;color:#fff}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.ok{background:#dcfce7;color:#16a34a}.low{background:#fef3c7;color:#d97706}.bad{background:#fee2e2;color:#dc2626}
</style></head><body>
<h2>Built Trailers — ${esc(req2.type==='po'?'Purchase Order':'New Vendor')} Approval</h2>
<div class="card">
  <p><b>Reference:</b> ${esc(req2.ref_id)}</p>
  ${amtStr ? `<p><b>Amount:</b> ${esc(amtStr)}</p>` : ''}
  <p><b>Description:</b> ${esc(req2.ref_desc||req2.ref_id)}</p>
  <p><b>Requested by:</b> ${esc(req2.requester_name||'System')}</p>
  <p><b>For approver:</b> ${esc(req2.approver_name)}</p>
  <p><b>Status:</b> <span class="badge ${req2.status==='approved'?'ok':req2.status==='pending'?'low':'bad'}">${esc(req2.status)}</span></p>
</div>
${done ? `<p style="color:#666;font-style:italic">This request has already been ${esc(req2.status)}${req2.note?` — "${esc(req2.note)}"`:''}</p>` : `
<form method="POST" action="/approve/${esc(req.params.token)}">
  <label>Note (optional)</label>
  <textarea name="note" rows="3" placeholder="Add a note…"></textarea>
  <div>
    <button class="btn approve" type="submit" name="decision" value="approved">Approve</button>
    <button class="btn reject" type="submit" name="decision" value="rejected">Reject</button>
  </div>
</form>`}
</body></html>`);
});
app.post('/approve/:token', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { decision, note } = req.body || {};
    const result = await approvals.processDecision(req.params.token, decision, note, null);
    const verb = result.outcome === 'rejected' ? 'rejected' : 'approved';
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Done</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:20px;text-align:center}
h2{color:${verb==='approved'?'#22c55e':'#ef4444'}}</style></head><body>
<h2>${verb === 'approved' ? 'Approved' : 'Rejected'}</h2>
<p>${result.refId} has been <b>${verb}</b>.</p>
${result.outcome==='fully_approved'?'<p>All approvals complete — the PO is now open.</p>':''}
${result.outcome==='approved_next_seq'?'<p>Next approver has been notified.</p>':''}
</body></html>`);
  } catch (e) {
    res.status(400).send(`<h2>Error</h2><p>${e.message}</p>`);
  }
});

// ---- accounting / QuickBooks (Phase 4) ----
app.get('/api/accounting', authMiddleware, async (_req, res) => {
  res.json({ mode: accountingMode(), configured: qboConfigured(), totals: await totals(), events: await ledger() });
});
app.post('/api/accounting/sync', authMiddleware, requireTier('editor'), async (req, res) => {
  const r = await sync(); await audit(req, 'acct.sync', JSON.stringify(r)); res.json(r);
});
function qboErrRes(res, e) {
  if (e instanceof QBOAuthError || e?.qboAuth)
    return res.status(401).json({ error: e.message, qboReconnectRequired: true });
  if (e instanceof QBOFeatureError || e?.qboFeature)
    return res.status(402).json({ error: e.message, qboFeatureUnavailable: true, feature: e.feature || null });
  return res.status(500).json({ error: String(e.message || e) });
}
app.get('/api/qbo/errors', authMiddleware, requireTier('admin'), async (req, res) => {
  const rows = await qboErrorLog(Number(req.query.limit) || 100);
  res.json(rows);
});
app.get('/api/qbo/errors/export', authMiddleware, requireTier('admin'), async (_req, res) => {
  const rows = await qboErrorLog(1000);
  const header = 'id,ts,method,endpoint,status,intuit_tid,error_type,message\n';
  const csv = rows.map(r =>
    [r.id, r.ts, r.method, `"${(r.endpoint||'').replace(/"/g,'""')}"`, r.status,
     r.intuit_tid || '', r.error_type, `"${(r.message||'').replace(/"/g,'""')}"`].join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="qbo-errors-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(header + csv);
});
app.get('/api/qbo/preview/items', authMiddleware, requireTier('editor'), async (_req, res) => {
  if (!qboConfigured()) return res.status(400).json({ error: 'QuickBooks not configured' });
  try { res.json(await previewItemsFromQBO()); }
  catch (e) { qboErrRes(res, e); }
});
// ---- Push trailer (model) cost to QuickBooks, computed from the app BOM ----
// Preview (read-only): app cost vs current QB cost, with each model→QB-item match.
app.get('/api/accounting/trailer-costs', authMiddleware, requireSection('accounting'), async (req, res) => {
  const includeLabor = req.query.includeLabor !== '0';
  const [models, meta] = await Promise.all([modelsSummary(), all('SELECT id, qb_item_id FROM model', [])]);
  const storedItem = Object.fromEntries(meta.map(m => [m.id, m.qb_item_id]));
  let items = null, connected = false, err = null;
  if (qboConfigured()) { try { items = await getQBItems(); connected = true; } catch (e) { err = e.message; } }
  const byId = items && new Map(items.map(i => [i.id, i]));
  const byName = items && new Map(items.map(i => [(i.name || '').toLowerCase().trim(), i]));
  const rows = models.map(m => {
    const appCost = Math.round((includeLabor ? m.totalCost : m.material) * 100) / 100;
    const item = items ? ((storedItem[m.id] && byId.get(storedItem[m.id])) || byName.get((m.name || '').toLowerCase().trim()) || null) : null;
    return {
      modelId: m.id, model: m.name, material: m.material, laborCost: m.laborCost, totalCost: m.totalCost, appCost,
      qbItemId: item?.id || storedItem[m.id] || null, qbItemName: item?.name || null,
      currentQbCost: item ? item.cost : null, matched: !!item,
      willChange: item ? Math.abs(item.cost - appCost) > 0.005 : false,
    };
  });
  res.json({ connected, mode: accountingMode(), includeLabor, error: err,
    items: items ? items.map(i => ({ id: i.id, name: i.name, type: i.type, cost: i.cost })) : [], rows });
});
// Push: write each selected model's app cost into its QB item's PurchaseCost (the QB "Cost").
app.post('/api/accounting/trailer-costs/push', authMiddleware, requireSection('accounting'), async (req, res) => {
  if (!qboConfigured()) return res.status(400).json({ error: 'QuickBooks not configured' });
  const includeLabor = req.body?.includeLabor !== false;
  const sel = Array.isArray(req.body?.items) ? req.body.items : null; // [{modelId, qbItemId}] explicit overrides
  const models = await modelsSummary();
  const modelById = new Map(models.map(m => [m.id, m]));
  const stored = Object.fromEntries((await all('SELECT id, qb_item_id FROM model', [])).map(m => [m.id, m.qb_item_id]));
  const targets = sel || Object.keys(stored).filter(id => stored[id]).map(id => ({ modelId: id, qbItemId: stored[id] }));
  if (!targets.length) return res.status(400).json({ error: 'No model→QuickBooks item mappings to push. Open the preview and choose a QB item for each trailer first.' });
  const results = [];
  for (const t of targets) {
    const m = modelById.get(t.modelId);
    if (!m) { results.push({ modelId: t.modelId, ok: false, error: 'model not found' }); continue; }
    const itemId = t.qbItemId || stored[t.modelId];
    if (!itemId) { results.push({ modelId: t.modelId, model: m.name, ok: false, error: 'no QB item selected' }); continue; }
    const cost = Math.round((includeLabor ? m.totalCost : m.material) * 100) / 100;
    try {
      await updateItemCost(itemId, cost);
      await q('UPDATE model SET qb_item_id=$1 WHERE id=$2', [String(itemId), t.modelId]); // remember the mapping
      results.push({ modelId: t.modelId, model: m.name, ok: true, qbItemId: String(itemId), cost });
    } catch (e) {
      results.push({ modelId: t.modelId, model: m.name, ok: false, qbItemId: String(itemId), error: e.message });
    }
  }
  const okN = results.filter(r => r.ok).length;
  await audit(req, 'qbo.push_costs', `${okN}/${results.length} trailer costs pushed to QuickBooks${includeLabor ? '' : ' (material only)'}`);
  res.json({ ok: true, pushed: okN, total: results.length, includeLabor, results });
});
// Shop-floor PIN: lets a worker mark stages complete from a traveler's QR page (see /u/:id).
// Stored bcrypt-hashed in app_config; clearing the PIN disables floor updates entirely.
app.get('/api/admin/shop-pin', authMiddleware, requireTier('admin'), async (_req, res) =>
  res.json({ set: !!(await one(`SELECT value FROM app_config WHERE key='shop_pin'`, []).catch(() => null)) }));
app.post('/api/admin/shop-pin', authMiddleware, requireTier('admin'), async (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (pin === '') {
    await q(`DELETE FROM app_config WHERE key='shop_pin'`);
    await audit(req, 'shoppin.clear', 'shop-floor updates disabled');
    return res.json({ ok: true, set: false });
  }
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4–8 digits.' });
  await q(`INSERT INTO app_config(key,value) VALUES('shop_pin',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [hashPassword(pin)]);
  await audit(req, 'shoppin.set', 'shop-floor PIN updated');
  res.json({ ok: true, set: true });
});
// Run (or preview with {dryRun:true}) the owner reminder emails on demand — the same
// runReminders() the daily scheduler calls, so office staff can check who's eligible.
app.post('/api/admin/reminders/run', authMiddleware, requireTier('admin'), async (req, res) => {
  try {
    const r = await runReminders({ dryRun: !!req.body?.dryRun });
    if (!req.body?.dryRun) await audit(req, 'reminders.manual', `expiry ${r.expirySent ?? 0}, maintenance ${r.maintenanceSent ?? 0}`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/qbo/pull', authMiddleware, requireTier('admin'), async (req, res) => {
  if (!qboConfigured()) return res.status(400).json({ error: 'QuickBooks not configured' });
  const what   = req.body?.what   || ['customers', 'items', 'invoices', 'vendors'];
  const itemIds = req.body?.itemIds || null;
  const results = {};
  try {
    if (what.includes('customers')) results.customers = await syncCustomersFromQBO();
    if (what.includes('items'))     results.items     = await syncItemsFromQBO(itemIds);
    if (what.includes('invoices'))  results.invoices  = await syncInvoicesFromQBO();
    if (what.includes('vendors'))   results.vendors   = await syncVendorsFromQBO();
    await audit(req, 'qbo.pull', JSON.stringify(results));
    res.json({ ok: true, results });
  } catch (e) {
    qboErrRes(res, e);
  }
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
  if (req.user.titles.length && req.user.titles.every(t => t === 'External Viewer')) return res.status(403).json({ error: 'External viewers cannot post' });
  if (!req.body?.title) return res.status(400).json({ error: 'title required' });
  res.json({ id: await people.postWin(req.body, req.user) });
});
app.post('/api/wins/:id/react', authMiddleware, async (req, res) => {
  if (req.user.titles.length && req.user.titles.every(t => t === 'External Viewer')) return res.status(403).json({ error: 'External viewers cannot react' });
  await people.reactWin(req.params.id, req.body?.emoji, req.user.id); res.json({ ok: true });
});

// ---- forecasting & planning (Phase 6) ----
app.get('/api/forecast', authMiddleware, async (req, res) => res.json(await forecast(Number(req.query.horizon) || 90)));
app.get('/api/workingcapital', authMiddleware, async (req, res) => res.json(await workingCapital(Number(req.query.horizon) || 30)));
app.post('/api/scenario', authMiddleware, async (req, res) => res.json(await scenario(req.body || {})));

// ---- notifications / SMS (Phase 6) ----
app.get('/api/notifications', authMiddleware, async (_req, res) => res.json({ mode: sms.smsMode(), configured: sms.twilioConfigured(), items: await sms.notifications() }));
app.post('/api/notifications/send', authMiddleware, requireTier('editor'), async (req, res) => {
  const payload = { ...(req.body || {}) };
  if (payload.body && !/STOP/i.test(payload.body))
    payload.body = payload.body.trim() + ' Reply STOP to opt out.';
  const r = await sms.send(payload, req.user.id);
  await audit(req, 'sms.send', JSON.stringify(req.body?.kind || 'manual'));
  res.json(r);
});

// ---- Action Inbox ----
// Personalized "what do I need to do" list for the signed-in user.
app.get('/api/inbox', authMiddleware, async (req, res) => {
  try { res.json({ items: await actionItemsFor(req.user) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Morning briefing jobs ----
// Preview MY briefing text without sending (used to test before opting in).
app.get('/api/briefing/preview', authMiddleware, async (req, res) => {
  try { res.json(await previewBriefingFor(req.user, req.user.name)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Fire the whole morning briefing now (admin only — also runs automatically at BRIEFING_HOUR).
app.post('/api/briefing/run', authMiddleware, requireTier('admin'), async (req, res) => {
  try {
    const r = await sendMorningBriefings(req.user.id);
    await audit(req, 'briefing.run', `manual: sent=${r.sent} skipped=${r.skipped} errors=${r.errors}`);
    res.json(r);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Run the weekly verification-queue prompt now (admin; also runs automatically weekly)
app.post('/api/jobs/verify-prompt', authMiddleware, requireTier('admin'), async (req, res) => {
  try { const r = await runVerifyPrompt(); await audit(req, 'verify.prompt', `manual: ${r.total} pending, sent ${r.sent}`); res.json(r); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Invoice batches (group a dealer's trailers onto one invoice) ----
app.get('/api/invoice-batches', authMiddleware, async (_req, res) => res.json(await invoicing.listBatches()));
// NOTE: /eligible must be declared before /:id so it isn't captured as an id
app.get('/api/invoice-batches/eligible', authMiddleware, async (req, res) => {
  if (!req.query.customerId) return res.status(400).json({ error: 'customerId required' });
  res.json(await invoicing.eligibleOrders(req.query.customerId));
});
app.get('/api/invoice-batches/:id', authMiddleware, async (req, res) => {
  const b = await invoicing.getBatch(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  res.json(b);
});
app.post('/api/invoice-batches', authMiddleware, requireSection('accounting'), async (req, res) => {
  const { customerId, orderIds, note } = req.body || {};
  if (!customerId) return res.status(400).json({ error: 'customerId required' });
  const id = await invoicing.createBatch(customerId, orderIds || [], note, req.user);
  await audit(req, 'batch.create', `${id} ${customerId} (${(orderIds || []).length} orders)`);
  res.json({ id });
});
app.post('/api/invoice-batches/:id/orders', authMiddleware, requireSection('accounting'), async (req, res) => {
  try { res.json(await invoicing.addOrders(req.params.id, req.body?.orderIds || [])); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/invoice-batches/:id/orders/:orderId', authMiddleware, requireSection('accounting'), async (req, res) => {
  try { res.json(await invoicing.removeOrder(req.params.id, req.params.orderId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/invoice-batches/:id/post', authMiddleware, requireSection('accounting'), async (req, res) => {
  try {
    const b = await invoicing.postBatchInvoice(req.params.id, req.user);
    await audit(req, 'batch.invoice', `${req.params.id} ${b.customer} $${Math.round(b.total)} (${b.orders.length} trailers)`);
    res.json(b);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/invoice-batches/:id/paid', authMiddleware, requireSection('accounting'), async (req, res) => {
  try {
    const b = await invoicing.markPaid(req.params.id, req.user);
    await audit(req, 'batch.paid', req.params.id);
    res.json(b);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Trailer units & VIN assignment ----
app.get('/api/trailers', authMiddleware, requireSection('trailers'), async (_req, res) =>
  res.json(await trailers.listTrailers()));
// VIN assignment is an Accounting function
app.post('/api/trailers/assign', authMiddleware, requireSection('accounting'), async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const assigned = await trailers.assignVinsForOrder(orderId, req.user);
    await audit(req, 'vin.assign', `${orderId}: ${assigned.length} VIN(s)`);
    res.json({ assigned });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/trailers/config', authMiddleware, requireSection('accounting'), async (req, res) => {
  const cfg = await trailers.setVinConfig(req.body || {});
  await audit(req, 'vin.config', JSON.stringify(cfg));
  res.json(cfg);
});

// Only the Office Manager, General Manager, or an Admin may run the VIN/MSO print center or
// correct an assigned VIN.
function requireVinAuthority(req, res, next) {
  const ok = req.user.role === 'admin' || (req.user.titles || []).some(t => ['Office Manager', 'General Manager'].includes(t));
  if (!ok) return res.status(403).json({ error: 'Only the Office Manager, General Manager, or an Admin can do this.' });
  next();
}
const hasTitle = (req, names) => req.user.role === 'admin' || (req.user.titles || []).some(t => names.includes(t));
// Cycle counts: the Shop Specialist (and the office managers) can record them.
function requireOpsCount(req, res, next) {
  if (hasTitle(req, ['Shop Specialist', 'Office Manager', 'General Manager'])) return next();
  return res.status(403).json({ error: 'Cycle counts are for the Shop Specialist or the office managers.' });
}
// Approving an inventory adjustment (and its QuickBooks posting) — managers only.
function requireCountApprover(req, res, next) {
  if (hasTitle(req, ['Office Manager', 'General Manager'])) return next();
  return res.status(403).json({ error: 'Only the Office Manager, General Manager, or an Admin can approve inventory adjustments.' });
}
// Creating stock orders — Sales, Office Manager, General Manager, or Admin.
function requireStockCreator(req, res, next) {
  if (hasTitle(req, ['Sales', 'Office Manager', 'General Manager'])) return next();
  return res.status(403).json({ error: 'Only Sales, the Office Manager, the General Manager, or an Admin can create stock orders.' });
}
// VIN/MSO print center (office): VIN labels queue when paint begins, MSOs when paint completes.
app.get('/api/print-queue', authMiddleware, requireVinAuthority, async (req, res) => res.json(await trailers.printQueue(req.query.kind)));
app.post('/api/print-queue/:id/printed', authMiddleware, requireVinAuthority, async (req, res) => {
  try { const r = await trailers.markPrinted(Number(req.params.id), req.user); await audit(req, 'print.done', req.params.id); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Correct an assigned VIN after the fact (e.g. crossed stickers). Build history stays with the unit.
app.post('/api/trailers/:id/vin', authMiddleware, requireVinAuthority, async (req, res) => {
  try {
    const r = await trailers.correctVin(req.params.id, req.body?.vin);
    await audit(req, 'vin.correct', `${r.unitId}: ${r.oldVin || '(none)'} -> ${r.newVin}`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Printable build traveler (with a QR that points at the unit, not the VIN, so a VIN correction
// never breaks it) — for the shop/office.
app.get('/api/trailers/:id/traveler', authMiddleware, requireSection('trailers'), async (req, res) => {
  const d = await trailers.travelerData(req.params.id);
  if (!d) return res.status(404).json({ error: 'unit not found' });
  const base = process.env.APP_URL || `https://${req.get('host')}`;
  const qr = await QRCode.toDataURL(`${base}/u/${encodeURIComponent(d.unitId)}`, { margin: 1, width: 240 }).catch(() => null);
  const build = await boatbuilder.orderBuild(d.orderId).catch(() => null); // boat-build config, if any
  res.json({ ...d, qr, build });
});
// The configured boat-build spec for an order (production view: options + resolved BOM).
app.get('/api/orders/:id/build', authMiddleware, async (req, res) => {
  const spec = await boatbuilder.orderSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: 'no configured build for this order' });
  res.json(spec);
});
// Boat Trailer Builder — the configurator catalog (Nautique boats + option groups/choices). The
// sizing/validation/pricing engine + dealer submit route come in Phase 1B.
app.get('/api/boat-catalog', authMiddleware, async (_req, res) => {
  res.json(await boatbuilder.getCatalog());
});
// Preview a configuration — validation + live dealer price + the resolved BOM (no order created).
app.post('/api/boat-build/preview', authMiddleware, async (req, res) => {
  const cat = await boatbuilder.getCatalog();
  const valid = await boatbuilder.validateBuild(req.body || {}, cat);
  const price = await boatbuilder.priceBuild(req.body || {}, cat);
  const boat = cat.boats.find(b => b.id === req.body?.boatId);
  const bom = boat?.base_model_id ? await boatbuilder.computeFinalBOM(boat.base_model_id, req.body?.selections || {}, cat) : null;
  res.json({ ...valid, price, bom });
});
// Submit a configuration → creates the Quote order, persisting the build, options, and BOM deltas.
app.post('/api/boat-build/submit', authMiddleware, requireStockCreator, async (req, res) => {
  try { res.json(await boatbuilder.submitBuild(req.user, req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// ---- Boat Trailer Builder admin (the office): option pricing, new-part costs, boat catalog ----
function requireBoatAdmin(req, res, next) {
  if (hasTitle(req, ['Office Manager', 'General Manager'])) return next(); // hasTitle passes admin too
  return res.status(403).json({ error: 'Boat Builder settings are for the office managers or admin.' });
}
app.get('/api/boat-admin/catalog', authMiddleware, requireBoatAdmin, async (_req, res) => {
  const cat = await boatbuilder.getCatalog();
  const baseModels = await all(`SELECT id, name, axle FROM model WHERE category='Boat' ORDER BY id`, []);
  const parts = await all(`SELECT id, name, cost FROM part WHERE spec='TBD — set cost' ORDER BY id`, []);
  res.json({ groups: cat.groups.map(g => ({ id: g.id, name: g.name, choices: g.choices.map(({ parts: _p, ...c }) => c) })), boats: cat.boats, baseModels, parts });
});
app.post('/api/boat-admin/price', authMiddleware, requireBoatAdmin, async (req, res) => {
  if (!req.body?.choiceId) return res.status(400).json({ error: 'choiceId required' });
  await q('UPDATE option_choice SET dealer_price=$1 WHERE id=$2', [Number(req.body.dealerPrice) || 0, req.body.choiceId]);
  res.json({ ok: true });
});
app.post('/api/boat-admin/cost', authMiddleware, requireBoatAdmin, async (req, res) => {
  if (!req.body?.partId) return res.status(400).json({ error: 'partId required' });
  await q('UPDATE part SET cost=$1 WHERE id=$2', [Number(req.body.cost) || 0, req.body.partId]);
  res.json({ ok: true });
});
app.post('/api/boat-admin/boat', authMiddleware, requireBoatAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.boatId) return res.status(400).json({ error: 'boatId required' });
  const sets = [], vals = [];
  const add = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
  if (b.baseModelId !== undefined) add('base_model_id', b.baseModelId || null);
  if (b.lengthFt !== undefined) add('length_ft', b.lengthFt === '' || b.lengthFt === null ? null : Number(b.lengthFt));
  if (b.beamIn !== undefined) add('beam_in', b.beamIn === '' || b.beamIn === null ? null : Number(b.beamIn));
  if (b.dryWeightLb !== undefined) add('dry_weight_lb', b.dryWeightLb === '' || b.dryWeightLb === null ? null : Number(b.dryWeightLb));
  if (b.active !== undefined) add('active', !!b.active);
  if (!sets.length) return res.json({ ok: true });
  vals.push(b.boatId);
  await q(`UPDATE boat_model SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  res.json({ ok: true });
});

// ---- Test mode (admin only): provision flagged test portal accounts + a failproof wipe ----
app.get('/api/admin/test-data', authMiddleware, requireTier('admin'), async (_req, res) => res.json(await testdata.testStatus()));
app.post('/api/admin/test-accounts', authMiddleware, requireTier('admin'), async (_req, res) => res.json(await testdata.provisionTestAccounts()));
app.post('/api/admin/test-data/wipe', authMiddleware, requireTier('admin'), async (req, res) => {
  if (req.body?.confirm !== 'WIPE') return res.status(400).json({ error: 'Confirmation required.' });
  res.json({ wiped: await testdata.wipeTestData() });
});

// ---- Warranty & build history ----
app.get('/api/warranty/steps', authMiddleware, requireSection('trailers'), (_req, res) => res.json(warranty.BUILD_STEPS));
app.get('/api/warranty/by-dealer', authMiddleware, requireSection('trailers'), async (_req, res) => res.json(await warranty.byDealer()));
app.get('/api/warranty/summary', authMiddleware, requireSection('trailers'), async (_req, res) => res.json(await warranty.summary()));
app.get('/api/warranty/claims', authMiddleware, requireSection('trailers'), async (_req, res) => res.json(await warranty.claimsList()));
app.get('/api/trailers/:id/detail', authMiddleware, requireSection('trailers'), async (req, res) => {
  const d = await warranty.trailerDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'trailer not found' });
  res.json(d);
});
// Mutations require editor tier (shop floor + supervisors)
app.post('/api/trailers/:id/build-step', authMiddleware, requireTier('editor'), requireSection('trailers'), async (req, res) => {
  const { step, employeeId, employeeName, note } = req.body || {};
  try {
    const d = await warranty.logBuildStep(req.params.id, step, { employeeId, employeeName, note }, req.user);
    await audit(req, 'build.step', `${req.params.id} ${step} by ${employeeName || '—'}`);
    res.json(d);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/trailers/:id/warranty', authMiddleware, requireTier('editor'), requireSection('trailers'), async (req, res) => {
  try {
    const d = await warranty.registerWarranty(req.params.id, req.body || {}, req.user);
    await audit(req, 'warranty.register', `${req.params.id}`);
    res.json(d);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/warranty/claims', authMiddleware, requireTier('editor'), requireSection('trailers'), async (req, res) => {
  const { trailerId } = req.body || {};
  if (!trailerId) return res.status(400).json({ error: 'trailerId required' });
  try {
    const id = await warranty.openClaim(trailerId, req.body || {}, req.user);
    await audit(req, 'warranty.claim', `${id} on ${trailerId}`);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/warranty/claims/:id/resolve', authMiddleware, requireTier('editor'), requireSection('trailers'), async (req, res) => {
  try {
    await warranty.resolveClaim(req.params.id, req.body?.resolution);
    await audit(req, 'warranty.resolve', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Staff review of portal registrations
app.get('/api/warranty/registrations/pending', authMiddleware, requireSection('trailers'), async (_req, res) =>
  res.json(await portal.pendingRegistrations()));
app.post('/api/warranty/registrations/:trailerId/review', authMiddleware, requireTier('editor'), requireSection('trailers'), async (req, res) => {
  try {
    const r = await portal.reviewRegistration(req.params.trailerId, req.body?.decision, { salePrice: req.body?.salePrice, accessories: req.body?.accessories });
    await audit(req, 'warranty.reg_review', `${req.params.trailerId} -> ${r.status}`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Dealer-margin intelligence (sale price + accessories) — Built Trailers staff only
app.get('/api/warranty/margins', authMiddleware, requireSection('trailers'), async (_req, res) => res.json(await portal.marginReport()));
// View an uploaded proof-of-sale (staff only — never public)
app.get('/api/warranty/proof', authMiddleware, requireSection('trailers'), async (req, res) => {
  // storage.getFile confines the ref to the uploads namespace (R2) or UPLOAD_DIR (local),
  // so a client-supplied path can't escape to arbitrary files.
  const file = await storage.getFile(String(req.query.path || ''));
  if (!file) return res.status(404).json({ error: 'not found' });
  res.type(file.contentType).send(file.buffer);
});
// Staff review of dealership account signups
app.get('/api/dealers/pending', authMiddleware, requireSection('trailers'), async (_req, res) =>
  res.json(await dealer.pendingDealers()));
app.post('/api/dealers/:id/approve', authMiddleware, requireTier('editor'), requireSection('trailers'), async (req, res) => {
  try {
    const r = await dealer.approveDealer(req.params.id, req.body?.customerId, req.body?.role);
    // Carry the dealership's signup address onto the linked customer (if it has none yet) + geocode.
    if (req.body?.customerId) {
      const du = await one('SELECT address, city, state, zip FROM dealer_user WHERE id=$1', [req.params.id]);
      const cust = await one('SELECT address FROM customer WHERE id=$1', [req.body.customerId]);
      if (du?.address && cust && !cust.address) {
        const g = await geocodeAddress({ address: du.address, city: du.city, state: du.state, zip: du.zip });
        await q('UPDATE customer SET address=$1, city=$2, state=$3, zip=$4, lat=$5, lng=$6 WHERE id=$7',
          [du.address, du.city, du.state, du.zip, g?.lat ?? null, g?.lng ?? null, req.body.customerId]);
      }
    }
    await audit(req, 'dealer.approve', `${req.params.id} -> ${req.body?.customerId || '(no link)'} (${r.role})`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/dealers/:id/reject', authMiddleware, requireTier('editor'), requireSection('trailers'), async (req, res) => {
  try { await dealer.rejectDealer(req.params.id); await audit(req, 'dealer.reject', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- audit ----
app.get('/api/audit', authMiddleware, requireTier('admin'), async (_req, res) =>
  res.json(await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100', [])));

// ---- Support system ----
app.post('/api/support/tickets', authMiddleware, async (req, res) => {
  try {
    const { type, title, firstMessage } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const id = await support.createTicket(req.user.id, { type, title, firstMessage });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/support/tickets', authMiddleware, async (req, res) => {
  try {
    const isAdm = req.user.role === 'admin';
    const rows = await support.listTickets({
      status: req.query.status || undefined,
      type:   req.query.type   || undefined,
      userId: isAdm ? undefined : req.user.id,
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/support/tickets/:id', authMiddleware, async (req, res) => {
  try {
    const t = await support.getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && t.user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/support/tickets/:id/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const t = await support.getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && t.user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    const result = await support.chat(req.params.id, message, { userName: req.user.name, userRole: req.user.role });
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.patch('/api/support/tickets/:id', authMiddleware, async (req, res) => {
  try {
    const { status, adminNote, type } = req.body || {};
    if (req.user.role !== 'admin' && status !== 'escalated')
      return res.status(403).json({ error: 'Forbidden' });
    await support.updateTicket(req.params.id, { status, adminNote });
    if (type) await support.escalate(req.params.id, type);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/support/tickets/:id/escalate', authMiddleware, async (req, res) => {
  try {
    const { type } = req.body || {};
    await support.escalate(req.params.id, type || 'bug');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete('/api/support/tickets/:id', authMiddleware, requireTier('admin'), async (req, res) => {
  try { await support.deleteTicket(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- static UI (must be last) ----
// Serve static assets, but NOT the auto-index — so "/" falls through to the
// subdomain-aware handler below (owner.* and dealership.* get their own front door).
app.use(express.static(path.join(__dir, '..', 'public'), { index: false }));
function portalPageFor(req) {
  const sub = String(req.hostname || '').split('.')[0].toLowerCase();
  if (sub === 'owner') return 'owner.html';                    // owner.builttrailers.app (account portal)
  if (sub === 'dealership' || sub === 'dealer') return 'dealership.html'; // dealership.builttrailers.app
  return 'index.html';                                          // app.builttrailers.app (staff)
}
app.get('*', (req, res) => res.sendFile(path.join(__dir, '..', 'public', portalPageFor(req))));

// ---- final error handler (4-arg, must be registered after all routes) ----
// Catches synchronous throws and (via express-async-errors) async route rejections.
// Logs the full error server-side and returns a generic 500 so stack traces and
// internal details never leak to the client.
app.use((err, req, res, next) => {
  // Funnel through captureError: structured log + Sentry/webhook (when configured).
  captureError(err, { route: `${req.method} ${req.path}`, id: req.id, user: req.user?.id });
  if (res.headersSent) return next(err); // response already started — let Express finish/abort it
  res.status(500).json({ error: 'Internal error', requestId: req.id });
});

const PORT = process.env.PORT || 3000;
const kind = await initDb();

// Apply the database schema — base tables + incremental migrations (db/migrate.js, shared
// with the seed so structure can never drift). Then run data backfills, which operate on
// existing rows and therefore must come AFTER the structural schema.
await ensureSchema();
  // Boat Trailer Builder catalog (Nautique boats + options) — idempotent, never overwrites
  // office-edited prices. After ensureSchema so its tables + the part table exist.
  await boatbuilder.ensureBoatCatalog().catch(e => log('warn', 'boatCatalog', { error: e.message }));
  // Built Trailers' real dealer network -> customer table for the public locator. One-time
  // (app_config flag) so later office edits to a dealer aren't overwritten on the next reboot.
  await ensureDealers().catch(e => log('warn', 'dealerSeed', { error: e.message }));
  // Migrate existing app_user.title into user_title junction (idempotent)
  await q(`INSERT INTO user_title(user_id,role_name)
    SELECT u.id, u.title FROM app_user u JOIN role r ON r.name=u.title
    WHERE u.title IS NOT NULL ON CONFLICT DO NOTHING`).catch(()=>{});
  // Seed default sections for roles that have none yet
  const ALL_SECTIONS = ['dashboard','orders','neworder','customers','parts','predict','pos','boms','inventory','accounting','trailers','team','timeoff','outcomes','wins','forecast','notify','support','users'];
  const EDITOR_SECTIONS = ALL_SECTIONS.filter(s=>s!=='users');
  const VIEWER_SECTIONS = ['dashboard','orders','customers','inventory','notify','support'];
  const rolesWithoutSections = await all(`SELECT r.name,r.tier FROM role r WHERE NOT EXISTS (SELECT 1 FROM role_section rs WHERE rs.role_name=r.name)`, []);
  for (const r of rolesWithoutSections) {
    const secs = r.tier==='admin' ? ALL_SECTIONS : r.tier==='editor' ? EDITOR_SECTIONS : VIEWER_SECTIONS;
    for (const s of secs) await q(`INSERT INTO role_section(role_name,section) VALUES($1,$2) ON CONFLICT DO NOTHING`, [r.name, s]);
  }
  // Backfill production_seq for any orders missing it, defaulting to confirmation/creation order.
  await q(`UPDATE sales_order s SET production_seq = sub.rn + COALESCE((SELECT MAX(production_seq) FROM sales_order), 0)
             FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
                     FROM sales_order WHERE production_seq IS NULL) sub
            WHERE s.id = sub.id`).catch(e => console.warn('production_seq backfill:', e.message));
  // Grant the 'trailers' section to any role that can already see orders (admins see all).
  await q(`INSERT INTO role_section(role_name, section)
             SELECT DISTINCT role_name, 'trailers' FROM role_section WHERE section='orders'
             ON CONFLICT DO NOTHING`).catch(e => console.warn('trailers section grant:', e.message));
console.log('Migrations applied.');

try {
  const has = await one("SELECT to_regclass('public.part') AS t", []).catch(() => null);
  if (!has || !has.t) console.log('Note: run `npm run init-db` to create schema + seed.');
} catch {}

// ---- Morning briefing scheduler (in-process) ----
// Sends each employee their action-item text once a day at BRIEFING_HOUR (local
// to BRIEFING_TZ). Idempotent: the send date is recorded in app_config so a
// restart — or a second instance — can never double-send. For belt-and-suspenders
// reliability you can also run `node scripts/send-briefing.js` from a Render Cron Job.
const BRIEFING_HOUR = Number(process.env.BRIEFING_HOUR || 7);
const BRIEFING_TZ = process.env.BRIEFING_TZ || 'America/Denver';
const partsIn = tz => Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date()).map(p => [p.type, p.value]));

async function maybeRunBriefing() {
  try {
    const p = partsIn(BRIEFING_TZ);
    if (Number(p.hour) < BRIEFING_HOUR) return;            // not time yet today
    const today = `${p.year}-${p.month}-${p.day}`;
    const last = await one(`SELECT value FROM app_config WHERE key='briefing_last_run'`, []).catch(() => null);
    if (last && last.value === today) return;              // already ran today
    // Claim the day BEFORE sending so overlapping checks can't double-fire
    await q(`INSERT INTO app_config(key,value) VALUES('briefing_last_run',$1)
             ON CONFLICT(key) DO UPDATE SET value=$1`, [today]);
    const r = await sendMorningBriefings(null);
    console.log(`Morning briefing (${today}): sent ${r.sent}, skipped ${r.skipped}, errors ${r.errors}.`);
  } catch (e) { console.warn('briefing scheduler:', e.message); }
}

// Weekly nudge to staff to clear the manual-verification queue (pending portal
// registrations, dealer-account approvals, open warranty claims) — so the
// auto-verify-or-queue backlog never goes stale, without slowing dealers/owners.
const VERIFY_PROMPT_HOUR = Number(process.env.VERIFY_PROMPT_HOUR || 8);
const VERIFY_PROMPT_DOW = process.env.VERIFY_PROMPT_DOW || 'Mon';
const weekdayIn = tz => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date());
async function runVerifyPrompt() {
  const [regs, dealers, claims] = await Promise.all([
    portal.pendingRegistrationCount(), dealer.pendingDealerCount(), warranty.openClaimCount(),
  ]);
  const total = regs + dealers + claims;
  let sent = 0;
  if (total > 0) {
    const body = `Built Trailers — weekly verification queue: ${regs} registration(s) to verify, ${dealers} dealer account(s) to approve, ${claims} open warranty claim(s). Please clear these this week.`;
    const staff = await all(`SELECT phone FROM app_user WHERE active<>false AND sms_consent=true AND phone IS NOT NULL AND phone<>'' AND role IN ('admin','editor')`, []).catch(() => []);
    for (const s of staff) { try { await sms.send({ recipient: s.phone, body, kind: 'verify-prompt' }, null); sent++; } catch {} }
  }
  return { regs, dealers, claims, total, sent };
}
async function maybeRunVerifyPrompt() {
  try {
    const p = partsIn(BRIEFING_TZ);
    if (Number(p.hour) < VERIFY_PROMPT_HOUR || weekdayIn(BRIEFING_TZ) !== VERIFY_PROMPT_DOW) return;
    const today = `${p.year}-${p.month}-${p.day}`;
    const last = await one(`SELECT value FROM app_config WHERE key='verify_prompt_last_run'`, []).catch(() => null);
    if (last && last.value === today) return;
    await q(`INSERT INTO app_config(key,value) VALUES('verify_prompt_last_run',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [today]);
    const r = await runVerifyPrompt();
    console.log(`Weekly verify prompt (${today}): ${r.regs}+${r.dealers}+${r.claims} pending, texted ${r.sent} staff.`);
  } catch (e) { console.warn('verify prompt:', e.message); }
}
if (kind === 'postgres' && process.env.BRIEFING_DISABLED !== 'true') {
  setInterval(maybeRunBriefing, 5 * 60 * 1000);           // re-check every 5 minutes
  setTimeout(maybeRunBriefing, 15 * 1000);                // and once shortly after boot
}
if (kind === 'postgres' && process.env.VERIFY_PROMPT_DISABLED !== 'true') {
  setInterval(maybeRunVerifyPrompt, 30 * 60 * 1000);      // weekly job, checked every 30 min
}

// ---- Owner reminder emails (warranty expiry + maintenance nudges) ----
// Daily at REMINDER_HOUR (BRIEFING_TZ), same idempotent claim-the-day pattern as the briefing.
// Skips (without claiming the day) until RESEND_API_KEY is set, so the backlog sends once email
// goes live. Run on demand / preview with POST /api/admin/reminders/run {dryRun:true}.
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR || 9);
async function maybeRunReminders() {
  try {
    const p = partsIn(BRIEFING_TZ);
    if (Number(p.hour) < REMINDER_HOUR) return;
    if (!emailConfigured()) return;                        // don't claim the day — retry once email is on
    const today = `${p.year}-${p.month}-${p.day}`;
    const last = await one(`SELECT value FROM app_config WHERE key='reminders_last_run'`, []).catch(() => null);
    if (last && last.value === today) return;
    await q(`INSERT INTO app_config(key,value) VALUES('reminders_last_run',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [today]);
    const r = await runReminders();
    console.log(`Owner reminders (${today}): expiry ${r.expirySent}/${r.expiryEligible}, maintenance ${r.maintenanceSent}/${r.maintenanceEligible}.`);
  } catch (e) { console.warn('reminder scheduler:', e.message); }
}
if (kind === 'postgres' && process.env.REMINDERS_DISABLED !== 'true') {
  setInterval(maybeRunReminders, 15 * 60 * 1000);         // daily job, checked every 15 min
  setTimeout(maybeRunReminders, 25 * 1000);               // and once shortly after boot
}

app.listen(PORT, () => console.log(`Built Trailers Phase 1 API on :${PORT} (db: ${kind})`));
