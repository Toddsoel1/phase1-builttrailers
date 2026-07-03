// Andon — shop-floor problem signalling. A worker raises a problem from the traveler QR
// station page (PIN-gated, reason-coded); the Shop Manager / GM get an instant push + inbox
// item; the order shows 🔴 on the Production Flow board until staff resolve it. Blocked time
// (resolved_at − raised_at, or still-running for open events) feeds the blocker Pareto on the
// Performance screen — waste-elimination targeting instead of waste anecdotes.
import { all, one, q } from './db.js';
import { sendPush } from './push.js';

export const ANDON_REASONS = ['Waiting on parts', 'Rework needed', 'Machine down', 'Missing info', 'Other'];

// Everyone who should hear about a floor problem immediately: admins + SM/GM title holders.
async function alertTargets() {
  return all(`SELECT DISTINCT u.id FROM app_user u
                LEFT JOIN user_title ut ON ut.user_id=u.id
               WHERE u.active IS DISTINCT FROM false
                 AND (u.role='admin' OR ut.role_name IN ('Shop Manager','General Manager'))`, []).catch(() => []);
}

export async function raiseProblem(unitId, { reason, note, worker }) {
  const r = ANDON_REASONS.includes(reason) ? reason : 'Other';
  const unit = await one('SELECT t.id, t.order_id, t.vin, o.stage FROM trailer t LEFT JOIN sales_order o ON o.id=t.order_id WHERE t.id=$1', [unitId]);
  if (!unit?.order_id) throw new Error('Unit not found or not on an order.');
  const row = await one(`INSERT INTO andon_event(order_id, unit_id, stage, reason, note, raised_by)
                         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [unit.order_id, unitId, unit.stage || null, r, (note || '').slice(0, 300) || null, (worker || '').slice(0, 40) || null]);
  const body = `🚨 ${unit.order_id}${unit.vin ? ` (VIN …${String(unit.vin).slice(-6)})` : ''}: ${r}${worker ? ` — ${worker}` : ''}${note ? `: ${String(note).slice(0, 80)}` : ''}`;
  for (const t of await alertTargets()) {
    try { await sendPush('staff', t.id, { title: 'Shop floor problem', body, tag: `andon-${row.id}`, url: '/' }); } catch { /* push is best-effort */ }
    await q(`INSERT INTO notification(channel,recipient,body,kind,ref,mode,status)
             VALUES ('app',$1,$2,'andon',$3,'app','sent')`, [t.id, body, unit.order_id]).catch(() => {});
  }
  return { id: row.id, orderId: unit.order_id };
}

export async function resolveProblem(id, resolution, userId) {
  const ev = await one('SELECT * FROM andon_event WHERE id=$1', [id]);
  if (!ev) throw new Error('Problem not found.');
  if (ev.resolved_at) return { ok: true, already: true };
  await q('UPDATE andon_event SET resolved_at=now(), resolved_by=$1, resolution=$2 WHERE id=$3',
    [userId || null, (resolution || '').slice(0, 300) || null, id]);
  return { ok: true };
}

const hrs = ms => Math.round((ms / 3600000) * 10) / 10;

export async function openProblems() {
  const rows = await all(`SELECT a.*, t.vin, m.name AS model FROM andon_event a
                            LEFT JOIN trailer t ON t.id=a.unit_id
                            LEFT JOIN sales_order o ON o.id=a.order_id
                            LEFT JOIN model m ON m.id=o.model_id
                           WHERE a.resolved_at IS NULL ORDER BY a.raised_at`, []).catch(() => []);
  return rows.map(a => ({ id: a.id, orderId: a.order_id, vin: a.vin, model: a.model, stage: a.stage,
    reason: a.reason, note: a.note, raisedBy: a.raised_by, raisedAt: a.raised_at,
    hoursOpen: hrs(Date.now() - new Date(a.raised_at)) }));
}

// Open + recent (resolved) problems on one order, for the order-detail banner.
export async function problemsForOrder(orderId) {
  const rows = await all(`SELECT * FROM andon_event WHERE order_id=$1 ORDER BY raised_at DESC LIMIT 10`, [orderId]).catch(() => []);
  return rows.map(a => ({ id: a.id, reason: a.reason, note: a.note, raisedBy: a.raised_by, raisedAt: a.raised_at,
    resolved: !!a.resolved_at, resolution: a.resolution,
    blockedHours: hrs((a.resolved_at ? new Date(a.resolved_at) : Date.now()) - new Date(a.raised_at)) }));
}

// The blocker Pareto: which reasons cost the most hours (trailing 90 days; open events count
// their running time). This is the "what do we fix first" list.
export async function blockerPareto() {
  const rows = await all(`SELECT reason, raised_at, resolved_at FROM andon_event
                           WHERE raised_at > now() - INTERVAL '90 days'`, []).catch(() => []);
  const agg = {};
  for (const a of rows) {
    const g = (agg[a.reason] = agg[a.reason] || { reason: a.reason, events: 0, blockedHours: 0, open: 0 });
    g.events++;
    if (!a.resolved_at) g.open++;
    g.blockedHours += hrs((a.resolved_at ? new Date(a.resolved_at) : Date.now()) - new Date(a.raised_at));
  }
  return Object.values(agg).map(g => ({ ...g, blockedHours: Math.round(g.blockedHours * 10) / 10 }))
    .sort((a, b) => b.blockedHours - a.blockedHours);
}
