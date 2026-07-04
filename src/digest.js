// Weekly performance digest — the Monday-morning email that tells the owner / GM / Shop Manager
// how the shop actually ran: KPIs vs expectations, the generated recommendations, open floor
// problems, and last week's throughput. Built from the same scorecard() the Performance screen
// renders, so the email and the app can never disagree.
import { all } from './db.js';
import { scorecard } from './analytics.js';
import { sendEmail, emailConfigured } from './email.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const APP = () => process.env.STAFF_APP_URL || 'https://app.builttrailers.app';

// Active admins + anyone holding a Shop Manager / General Manager title, with an email on file.
export async function digestRecipients() {
  return all(`SELECT DISTINCT u.id, u.name, u.email FROM app_user u
                LEFT JOIN user_title ut ON ut.user_id = u.id
               WHERE u.active <> false AND u.email IS NOT NULL AND u.email <> ''
                 AND (u.role = 'admin'
                      OR ut.role_name IN ('Shop Manager','General Manager')
                      OR u.title IN ('Shop Manager','General Manager'))
               ORDER BY u.name`, []).catch(() => []);
}

const STATUS_DOT = { ok: '🟢', warn: '🟡', miss: '🔴', info: '🔵', nodata: '⚪️' };
const fmtKpi = k => `${k.value == null ? '—' : k.value}${k.value == null ? '' : k.unit}`;
const fmtTarget = k => k.target == null ? '' : ` (target ${k.dir === '<=' ? '≤' : '≥'} ${k.target}${k.unit})`;

export async function buildDigest() {
  const sc = await scorecard();
  const week = new Date().toISOString().slice(0, 10);
  const misses = sc.kpis.filter(k => k.status === 'miss').length;
  const subject = `Built Trailers weekly digest — ${misses ? `${misses} expectation(s) missed` : 'all expectations met'} (${week})`;

  const kpiRows = sc.kpis.map(k => `<tr>
      <td style="padding:6px 10px 6px 0">${STATUS_DOT[k.status] || '⚪️'} ${esc(k.label)}</td>
      <td style="padding:6px 0;text-align:right"><b>${esc(fmtKpi(k))}</b><span style="color:#6b7785;font-size:12px">${esc(fmtTarget(k))}</span></td>
    </tr>`).join('');

  const recRows = sc.recommendations.slice(0, 6).map(r => `<li style="margin:6px 0">
      ${r.sev === 'miss' ? '🔴' : r.sev === 'warn' ? '🟡' : '🟢'} ${esc(r.text)}
      <span style="color:#6b7785;font-size:12px"> — ${esc(r.owner)}</span></li>`).join('');

  const andonBlock = sc.andon.open.length
    ? `<p style="margin:14px 0 4px"><b>🚨 ${sc.andon.open.length} floor problem(s) still open</b> — oldest: ${esc(sc.andon.open[0].orderId)} “${esc(sc.andon.open[0].reason)}” (${sc.andon.open[0].hoursOpen}h).</p>`
    : '';
  const paretoBlock = (sc.andon.pareto || []).length
    ? `<p style="margin:14px 0 4px"><b>Top blockers (30 days)</b></p><ul style="margin:0;padding-left:18px">${sc.andon.pareto.slice(0, 3).map(p => `<li>${esc(p.reason)} — ${p.count}× (${p.hoursLost}h lost)</li>`).join('')}</ul>`
    : '';

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2230;max-width:560px">
    <h2 style="margin:0 0 4px">Weekly performance digest</h2>
    <p style="color:#6b7785;font-size:13px;margin:0 0 14px">Week of ${week} · throughput ${sc.completions.throughputPerWeek ?? '—'}/wk · ${sc.pastDue} past due</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${kpiRows}</table>
    <h3 style="font-size:14px;margin:18px 0 4px">Where to focus this week</h3>
    <ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.55">${recRows}</ul>
    ${andonBlock}${paretoBlock}
    <p style="margin:18px 0 0"><a href="${APP()}" style="display:inline-block;background:#e8631a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open the Performance screen</a></p>
    <p style="color:#6b7785;font-size:12px;margin-top:18px">Built Trailers — generated automatically every Monday. Targets are editable on the Performance screen.</p></div>`;

  const text = `Built Trailers weekly digest (${week})\n`
    + sc.kpis.map(k => `${(STATUS_DOT[k.status] || '')} ${k.label}: ${fmtKpi(k)}${fmtTarget(k)}`).join('\n')
    + `\n\nWhere to focus:\n` + sc.recommendations.slice(0, 6).map(r => `- ${r.text} (${r.owner})`).join('\n')
    + `\n\n${APP()}`;

  return { subject, html, text, misses, recCount: sc.recommendations.length };
}

// Send to every recipient. dryRun returns who would get it (and the subject) without sending.
export async function sendWeeklyDigest({ dryRun } = {}) {
  const recipients = await digestRecipients();
  const digest = await buildDigest();
  if (dryRun) return { dryRun: true, subject: digest.subject, recipients: recipients.map(r => ({ name: r.name, email: r.email })) };
  if (!emailConfigured()) return { skipped: 'email not configured', recipients: recipients.length };
  let sent = 0, errors = 0;
  for (const r of recipients) {
    try { await sendEmail({ to: r.email, subject: digest.subject, html: digest.html, text: digest.text }); sent++; }
    catch (e) { errors++; console.warn(`digest -> ${r.email}:`, e.message); }
  }
  return { sent, errors, recipients: recipients.length, subject: digest.subject };
}
