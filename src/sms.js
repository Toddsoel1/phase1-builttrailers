// Phase 6 — SMS notifications. Simulated by default (recorded to the notification log);
// set SMS_MODE=twilio + Twilio credentials to send real texts. The single send hook is
// marked below.
import { q, all, one } from './db.js';

// Normalize any phone format to E.164 (+1XXXXXXXXXX for US numbers)
export function normalizePhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '+' + d;
}

// Record opt-in by phone; auto-links to customer / app_user records
export async function recordOptin(phone, audience, method) {
  await q(`INSERT INTO sms_optin(phone,audience,opted_in,opted_in_at,method)
           VALUES ($1,$2,true,now(),$3)
           ON CONFLICT(phone) DO UPDATE SET opted_in=true,opted_in_at=now(),opted_out_at=null,audience=$2,method=$3`,
    [phone, audience || 'customer', method || 'webform']);
  if (audience === 'employee') {
    await q(`UPDATE app_user SET sms_consent=true,sms_consent_at=now()
             WHERE regexp_replace(phone,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')`, [phone]);
  } else {
    await q(`UPDATE customer SET sms_consent=true,sms_consent_at=now()
             WHERE regexp_replace(phone,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')`, [phone]);
  }
}

// Record opt-out by phone; updates all matching records
export async function recordOptout(phone) {
  await q(`UPDATE sms_optin SET opted_in=false,opted_out_at=now() WHERE phone=$1`, [phone]);
  await q(`UPDATE customer SET sms_consent=false
           WHERE regexp_replace(phone,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')`, [phone]);
  await q(`UPDATE app_user SET sms_consent=false
           WHERE regexp_replace(phone,'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g')`, [phone]);
}

// Check if a phone number has a pending opt-in from keyword/webform
export async function checkOptin(phone) {
  return one(`SELECT * FROM sms_optin WHERE phone=$1 AND opted_in=true`, [phone]);
}

export function smsMode() { return process.env.SMS_MODE === 'twilio' ? 'twilio' : 'simulated'; }
export function twilioConfigured() { return !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM); }

async function deliver(to, body) {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.sid;
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

// auto-text a customer when their order changes stage — skipped if no phone or consent not given
export async function notifyOrderStage(orderId, stage, userId) {
  const o = await one(`SELECT o.qty, m.name AS model, c.name AS customer, c.phone, c.sms_consent
                         FROM sales_order o
                         LEFT JOIN model m ON m.id=o.model_id LEFT JOIN customer c ON c.id=o.customer_id
                        WHERE o.id=$1`, [orderId]);
  if (!o || !o.phone || !o.sms_consent) return;
  await send({ recipient: o.phone, body: `Built Trailers: Your ${o.qty}x ${o.model} (${orderId}) is now ${stage}. Reply STOP to opt out.`, kind: 'order-status', ref: orderId }, userId);
}

export async function notifications() {
  return (await all('SELECT * FROM notification ORDER BY id DESC LIMIT 100', []))
    .map(n => ({ id: n.id, ts: n.ts, channel: n.channel, recipient: n.recipient, body: n.body, kind: n.kind, ref: n.ref, mode: n.mode, status: n.status }));
}
