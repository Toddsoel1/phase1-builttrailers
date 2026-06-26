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

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
