// Observability — structured logging + provider-agnostic error capture.
//
// Errors are ALWAYS logged as structured records and, when configured, forwarded to:
//   • Sentry         — set SENTRY_DSN (and `npm install @sentry/node`) for a full error dashboard
//   • an alert webhook — set ALERT_WEBHOOK_URL (a Slack/Discord/generic incoming webhook) to get
//                        an instant ping, with zero extra dependencies
// Neither is required: the structured logs alone make failures searchable in Render's log stream.
import { randomUUID } from 'crypto';

const SVC = 'built-trailers';
const PRETTY = process.env.NODE_ENV !== 'production';   // human-readable locally, JSON in prod
const START = Date.now();

function emit(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, svc: SVC, msg, ...fields };
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (PRETTY) sink(`${rec.ts} ${level.toUpperCase().padEnd(5)} ${msg}` + (fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''));
  else sink(JSON.stringify(rec));
}
export const log = {
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};

// --- optional Sentry: loaded lazily, only when a DSN is configured ---
let _sentry = null, _sentryTried = false;
async function getSentry() {
  if (_sentryTried) return _sentry;
  _sentryTried = true;
  if (!process.env.SENTRY_DSN) return null;
  try {
    const S = await import('@sentry/node');
    S.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development', tracesSampleRate: 0 });
    _sentry = S;
    log.info('sentry enabled');
  } catch (e) {
    log.warn('SENTRY_DSN is set but @sentry/node is not installed — run: npm install @sentry/node', { err: e.message });
  }
  return _sentry;
}

// --- optional alert webhook (Slack/Discord/generic). Must never throw. ---
async function postWebhook(err, context) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const text = `🚨 *${SVC}* error: ${err.message || err}`
    + (context.route ? `\nroute: \`${context.route}\`` : '')
    + (context.id ? `\nrequest: ${context.id}` : '');
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(4000) });
  } catch { /* alerting failures are themselves swallowed — never cascade */ }
}

// The single funnel for everything that goes wrong: structured log + Sentry + webhook.
export async function captureError(err, context = {}) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })());
  log.error(e.message, { ...context, stack: e.stack });
  try { const S = await getSentry(); if (S) S.captureException(e, { extra: context }); } catch { /* ignore */ }
  await postWebhook(e, context);
}

// Process-level backstops + warm the Sentry client. Call once at boot.
export function initObservability() {
  process.on('unhandledRejection', (reason) => { captureError(reason, { kind: 'unhandledRejection' }); });
  process.on('uncaughtException', (err) => { captureError(err, { kind: 'uncaughtException' }); });
  getSentry();
  log.info('observability ready', {
    env: process.env.NODE_ENV || 'development',
    sentry: !!process.env.SENTRY_DSN, webhook: !!process.env.ALERT_WEBHOOK_URL,
  });
}

// Tag each request with an id (echoed in the response header + error payloads) and log only
// the high-signal outcomes: server errors and slow requests.
export function requestId() {
  return (req, res, next) => {
    req.id = (req.headers['x-request-id'] || randomUUID()).toString().slice(0, 64);
    res.setHeader('X-Request-Id', req.id);
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      if (res.statusCode >= 500) log.error('request_failed', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms });
      else if (ms > 3000) log.warn('request_slow', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms });
    });
    next();
  };
}

export function uptimeSeconds() { return Math.round((Date.now() - START) / 1000); }
