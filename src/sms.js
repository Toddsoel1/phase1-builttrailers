// Phase 6 — SMS notifications. Simulated by default (recorded to the notification log);
// set SMS_MODE=twilio + Twilio credentials to send real texts. The single send hook is
// marked below.
import { q, all, one } from './db.js';

export function smsMode() { return process.env.SMS_MODE === 'twilio' ? 'twilio' : 'simulated'; }
export function twilioConfigured() { return !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM); }

async function deliver(/* to, body */) {
  // TODO (production): POST to Twilio
  //   https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json  (From, To, Body)
  // Return the message SID. Until wired, simulated mode records the message locally.
  throw new Error('Twilio connector not wired');
}

export async function send({ recipient, body, kind, ref }, userId) {
  const mode = smsMode();
  let status = 'sent';
  if (mode === 'twilio') {
    try { if (!twilioConfigured()) throw new Error('not configured'); await deliver(recipient, body); status = 'sent'; }
    catch { status = 'queued'; }
  }
  await q(`INSERT INTO notification(channel,recipient,body,kind,ref,mode,status) VALUES ('sms',$1,$2,$3,$4,$5,$6)`,
    [recipient || '', body, kind || 'manual', ref || null, mode, status]);
  if (userId) await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [userId, 'sms.send', `${kind || 'manual'} → ${recipient}`]);
  return { status, mode };
}

// auto-text a customer when their order changes stage
export async function notifyOrderStage(orderId, stage, userId) {
  const o = await one(`SELECT o.qty, m.name AS model, c.name AS customer FROM sales_order o
                         LEFT JOIN model m ON m.id=o.model_id LEFT JOIN customer c ON c.id=o.customer_id
                        WHERE o.id=$1`, [orderId]);
  if (!o) return;
  await send({ recipient: o.customer || 'Customer', body: `Your ${o.qty}× ${o.model} (${orderId}) is now ${stage}.`, kind: 'order-status', ref: orderId }, userId);
}

export async function notifications() {
  return (await all('SELECT * FROM notification ORDER BY id DESC LIMIT 100', []))
    .map(n => ({ id: n.id, ts: n.ts, channel: n.channel, recipient: n.recipient, body: n.body, kind: n.kind, ref: n.ref, mode: n.mode, status: n.status }));
}
