// Email via Resend (https://resend.com). No-ops (just logs) until RESEND_API_KEY
// is set in the environment, so opt-in capture works today and real emails start
// the moment the key is added — no code change needed to turn it on.
const FROM = () => process.env.MAIL_FROM || 'Built Trailers <warranty@builttrailers.app>';
const BASE = () => process.env.OWNER_PORTAL_URL || 'https://owner.builttrailers.app';

export function emailConfigured() { return !!process.env.RESEND_API_KEY; }

export async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, skipped: 'no recipient' };
  if (!process.env.RESEND_API_KEY) { console.log(`[email] skipped (no RESEND_API_KEY): "${subject}" -> ${to}`); return { ok: false, skipped: 'not configured' }; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: [to], subject, html, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { ok: true, id: (await r.json().catch(() => ({}))).id };
}

// The opt-in welcome: maintenance schedule reminder, T&Cs link, and app-download link.
// Sent when a warranty registration is verified and the owner opted into email.
export async function sendWarrantyWelcome({ email, ownerName, vin, model }) {
  const url = BASE();
  const subject = `Your Built Trailers warranty is registered${model ? ' — ' + model : ''}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 8px">Welcome${ownerName ? ', ' + escapeHtml(ownerName) : ''}!</h2>
    <p>Your warranty for VIN <b>${escapeHtml(vin || '')}</b>${model ? ` (${escapeHtml(model)})` : ''} is registered and verified.</p>
    <ul style="line-height:1.7">
      <li>📅 <b>Required maintenance schedule</b> — log each item as you complete it to keep your warranty valid.</li>
      <li>📄 <b>Warranty terms &amp; conditions</b>: <a href="${url}/terms">${url}/terms</a></li>
      <li>📲 <b>Manage your trailer</b> (log maintenance, file a claim): <a href="${url}">${url}</a> — add it to your phone's home screen.</li>
    </ul>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers</p></div>`;
  const text = `Welcome${ownerName ? ', ' + ownerName : ''}! Your warranty for VIN ${vin || ''}${model ? ' (' + model + ')' : ''} is registered and verified. Terms: ${url}/terms  Manage your trailer: ${url}`;
  return sendEmail({ to: email, subject, html, text });
}

// Self-service password reset link for an owner account (link expires in 1 hour).
export async function sendPasswordReset({ email, ownerName, resetUrl }) {
  const subject = 'Reset your Built Trailers password';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 8px">Password reset</h2>
    <p>Hi${ownerName ? ' ' + escapeHtml(ownerName) : ''}, we received a request to reset the password for your Built Trailers owner account.</p>
    <p style="margin:18px 0"><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#e8631a;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Reset my password</a></p>
    <p style="color:#6b7785;font-size:13px">This link expires in 1 hour. If you didn&#39;t request this, you can ignore this email — your password won&#39;t change.</p>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers</p></div>`;
  const text = `Reset your Built Trailers password: ${resetUrl}  (expires in 1 hour; ignore this email if you didn't request it).`;
  return sendEmail({ to: email, subject, html, text });
}

// Dealer-facing notification (order status, claim resolved, registration verified) — the email
// twin of the in-portal notification, so dealers who never enable push still hear about it.
const DEALER_PORTAL = () => process.env.DEALER_PORTAL_URL || 'https://dealership.builttrailers.app';
const KIND_SUBJECT = { order: 'Order update', claim: 'Warranty claim update', registration: 'Registration update' };
export async function sendDealerNotification({ email, kind, body }) {
  const url = DEALER_PORTAL();
  const subject = `Built Trailers — ${KIND_SUBJECT[kind] || 'Update'}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 8px">${escapeHtml(KIND_SUBJECT[kind] || 'Update')}</h2>
    <p style="font-size:15px">${escapeHtml(body)}</p>
    <p style="margin:18px 0"><a href="${url}" style="display:inline-block;background:#e8631a;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Open the dealer portal</a></p>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers</p></div>`;
  const text = `${body}  Dealer portal: ${url}`;
  return sendEmail({ to: email, subject, html, text });
}

// "You're approved" — sent when Built Trailers staff approve a dealership signup (or a
// dealership admin approves a teammate). Until this existed, approved dealers heard nothing.
export async function sendDealerApproved({ email, name, dealershipName }) {
  const url = DEALER_PORTAL();
  const subject = 'Your Built Trailers dealer account is approved';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 8px">You're in${name ? ', ' + escapeHtml(name) : ''}!</h2>
    <p>Your dealer portal account${dealershipName ? ` for <b>${escapeHtml(dealershipName)}</b>` : ''} has been approved. You can now place orders, build boat-trailer quotes, register warranties, and track claims.</p>
    <p style="margin:18px 0"><a href="${url}" style="display:inline-block;background:#e8631a;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Log in to the dealer portal</a></p>
    <p style="color:#6b7785;font-size:13px">Sign in with the email and password you created. Tip: add the portal to your phone's home screen for one-tap access.</p>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers</p></div>`;
  const text = `Your Built Trailers dealer account${dealershipName ? ` for ${dealershipName}` : ''} is approved. Log in: ${url}`;
  return sendEmail({ to: email, subject, html, text });
}

// Self-service password reset link for a dealer account (link expires in 1 hour).
export async function sendDealerPasswordReset({ email, name, resetUrl }) {
  const subject = 'Reset your Built Trailers dealer portal password';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 8px">Password reset</h2>
    <p>Hi${name ? ' ' + escapeHtml(name) : ''}, we received a request to reset the password for your Built Trailers dealer portal account.</p>
    <p style="margin:18px 0"><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#e8631a;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Reset my password</a></p>
    <p style="color:#6b7785;font-size:13px">This link expires in 1 hour. If you didn&#39;t request this, you can ignore this email — your password won&#39;t change.</p>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers</p></div>`;
  const text = `Reset your Built Trailers dealer portal password: ${resetUrl}  (expires in 1 hour; ignore this email if you didn't request it).`;
  return sendEmail({ to: email, subject, html, text });
}

// ~30 days before warranty expiry (one-shot per registration, tracked in expiry_reminder_sent).
export async function sendWarrantyExpiryReminder({ email, ownerName, vin, model, expiresOn }) {
  const url = BASE();
  // The DB driver may return DATE as a JS Date — normalize either shape to YYYY-MM-DD.
  const when = expiresOn instanceof Date ? expiresOn.toISOString().slice(0, 10) : String(expiresOn).slice(0, 10);
  const subject = `Your Built Trailers warranty ends ${when}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 8px">Warranty expires soon</h2>
    <p>Hi${ownerName ? ' ' + escapeHtml(ownerName) : ''}, the warranty on your trailer${model ? ` (${escapeHtml(model)})` : ''} — VIN <b>${escapeHtml(vin || '')}</b> — ends on <b>${escapeHtml(when)}</b>.</p>
    <ul style="line-height:1.7">
      <li>🛠️ Noticed anything wrong? <b>File a warranty claim before it expires.</b></li>
      <li>📅 Log any maintenance you've done — it keeps your records (and coverage) clean.</li>
    </ul>
    <p style="margin:18px 0"><a href="${url}" style="display:inline-block;background:#e8631a;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Open my owner account</a></p>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers</p></div>`;
  const text = `The warranty on your trailer (VIN ${vin || ''}) ends on ${when}. File any claims and log maintenance before then: ${url}`;
  return sendEmail({ to: email, subject, html, text });
}

// Periodic (~every 6 months in-warranty) service nudge; skipped when maintenance was logged recently.
export async function sendMaintenanceReminder({ email, ownerName, vin, model }) {
  const url = BASE();
  const subject = 'Trailer service time — log your maintenance';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 8px">Time for routine maintenance</h2>
    <p>Hi${ownerName ? ' ' + escapeHtml(ownerName) : ''}, it's been a while since maintenance was logged for your trailer${model ? ` (${escapeHtml(model)})` : ''} — VIN <b>${escapeHtml(vin || '')}</b>.</p>
    <p>Routine service — bearings, brakes, lights, torque checks — keeps your trailer safe <b>and keeps your warranty valid</b>. The full schedule is in your owner account under Documents.</p>
    <p style="margin:18px 0"><a href="${url}" style="display:inline-block;background:#e8631a;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Log maintenance now</a></p>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers</p></div>`;
  const text = `Time for routine maintenance on your trailer (VIN ${vin || ''}). Log it to keep your warranty valid: ${url}`;
  return sendEmail({ to: email, subject, html, text });
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
