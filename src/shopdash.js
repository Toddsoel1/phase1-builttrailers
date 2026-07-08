// Shop Manager dashboard — the four floor-truth widgets:
//   ⚡ Labor efficiency  = earned standard hours ÷ actual hours logged (shop-wide + by station)
//   ✅ SOP compliance    = today's confirmed checkpoints ÷ required
//   🚩 Red flags         = employees under the efficiency threshold today
//   🚧 Bottleneck        = stages over their WIP limit, and for how long
// Earned standard hours: every stage completed today credits the completer with that
// (model, stage)'s routed hours (model_labor, workstations mapped to the stage) × order qty.
import { all, one, q } from './db.js';
import { stageForWorkstation } from './wip.js';
import { getWipLimits } from './analytics.js';

const RED_FLAG_PCT = () => Number(process.env.SM_RED_FLAG_PCT || 70);
const pct = (std, actual) => actual > 0 ? Math.round((std / actual) * 100) : null;
const r1 = x => Math.round(x * 10) / 10;

// Standard hours per (model, stage): sum the model's routed workstation hours whose
// workstation maps to that stage. Cached per call.
async function stdHoursByModelStage() {
  const labor = await all('SELECT model_id, ws, hours FROM model_labor', []);
  const wsSet = [...new Set(labor.map(l => l.ws))];
  const wsStage = {};
  for (const ws of wsSet) wsStage[ws] = await stageForWorkstation(ws).catch(() => null);
  const map = {};
  for (const l of labor) {
    const stage = wsStage[l.ws];
    if (!stage) continue;
    map[`${l.model_id}|${stage}`] = (map[`${l.model_id}|${stage}`] || 0) + Number(l.hours);
  }
  return map;
}

// from/to inclusive (YYYY-MM-DD). Returns totals + byStation + byUser.
export async function laborEfficiency(from, to) {
  const std = await stdHoursByModelStage();
  const logs = await all(
    `SELECT w.user_id, w.workstation, w.stage, w.hours, w.stage_complete, o.model_id, o.qty, u.name AS user_name
       FROM work_log w
       LEFT JOIN sales_order o ON o.id = w.order_id
       LEFT JOIN app_user u ON u.id = w.user_id
      WHERE w.log_date BETWEEN $1 AND $2`, [from, to]);
  const totals = { std: 0, actual: 0 };
  const byStation = {}, byUser = {};
  for (const w of logs) {
    const hrs = Number(w.hours) || 0;
    const earned = w.stage_complete ? (std[`${w.model_id}|${w.stage}`] || 0) * (Number(w.qty) || 1) : 0;
    totals.actual += hrs; totals.std += earned;
    const wsKey = w.workstation || '—';
    (byStation[wsKey] = byStation[wsKey] || { ws: wsKey, std: 0, actual: 0 });
    byStation[wsKey].std += earned; byStation[wsKey].actual += hrs;
    if (w.user_id) {
      (byUser[w.user_id] = byUser[w.user_id] || { userId: w.user_id, name: w.user_name || w.user_id, std: 0, actual: 0 });
      byUser[w.user_id].std += earned; byUser[w.user_id].actual += hrs;
    }
  }
  const shape = t => ({ std: r1(t.std), actual: r1(t.actual), pct: pct(t.std, t.actual) });
  return {
    ...shape(totals),
    byStation: Object.values(byStation).map(s => ({ ws: s.ws, ...shape(s) }))
      .sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999)),
    byUser: Object.values(byUser).map(u => ({ userId: u.userId, name: u.name, ...shape(u) })),
  };
}

// ---- SOP checkpoints ----
export async function sopList() {
  const items = await all(
    `SELECT s.id, s.workstation, s.text,
            l.confirmed_at, u.name AS confirmed_by
       FROM sop_checkpoint s
       LEFT JOIN sop_check_log l ON l.checkpoint_id = s.id AND l.log_date = CURRENT_DATE
       LEFT JOIN app_user u ON u.id = l.user_id
      WHERE s.active = true ORDER BY s.workstation NULLS FIRST, s.id`, []);
  const out = items.map(i => ({ id: i.id, workstation: i.workstation, text: i.text,
    confirmed: !!i.confirmed_at, confirmedBy: i.confirmed_by, confirmedAt: i.confirmed_at }));
  const required = out.length, confirmed = out.filter(i => i.confirmed).length;
  return { required, confirmed, pct: required ? Math.round((confirmed / required) * 100) : null, items: out };
}
export async function sopAdd(text, workstation, user) {
  const t = String(text || '').trim();
  if (t.length < 3) throw new Error('Describe the checkpoint (a few words at least).');
  const row = await one(`INSERT INTO sop_checkpoint(workstation, text, created_by) VALUES($1,$2,$3) RETURNING id`,
    [String(workstation || '').trim() || null, t.slice(0, 200), user?.id || null]);
  return { id: row.id };
}
export async function sopRemove(id) {
  await q('UPDATE sop_checkpoint SET active=false WHERE id=$1', [id]);
  return { ok: true };
}
export async function sopConfirm(id, user) {
  const cp = await one('SELECT id FROM sop_checkpoint WHERE id=$1 AND active=true', [id]);
  if (!cp) throw new Error('Checkpoint not found.');
  await q(`INSERT INTO sop_check_log(checkpoint_id, log_date, user_id) VALUES($1, CURRENT_DATE, $2)
           ON CONFLICT (checkpoint_id, log_date) DO NOTHING`, [id, user?.id || null]);
  return { ok: true };
}

// ---- Bottlenecks: WIP-violating stages + how long they've been over ----
// A stage went over when its (limit+1)-th newest occupant arrived; an order's arrival at its
// current stage is its newest order_stage_done stamp (falling back to creation).
export async function bottlenecks() {
  const limits = await getWipLimits().catch(() => ({}));
  const stages = Object.keys(limits).filter(s => Number(limits[s]) > 0);
  if (!stages.length) return [];
  const out = [];
  for (const stage of stages) {
    const occupants = await all(
      `SELECT o.id, GREATEST(COALESCE((SELECT MAX(d.completed_at) FROM order_stage_done d WHERE d.order_id=o.id), o.created_at), o.created_at) AS arrived
         FROM sales_order o WHERE o.stage=$1 AND o.billed=false ORDER BY arrived DESC`, [stage]);
    const limit = Number(limits[stage]);
    if (occupants.length <= limit) continue;
    const overSince = occupants[limit]?.arrived; // the arrival that tipped it over
    out.push({ stage, count: occupants.length, limit,
      overForHours: overSince ? Math.max(0, Math.round((Date.now() - new Date(overSince).getTime()) / 36e5 * 10) / 10) : null });
  }
  return out.sort((a, b) => (b.count - b.limit) - (a.count - a.limit));
}

// ---- Daily Scorecard: one person, one day — with the WHY behind the number ----
// Flag thresholds per the spec: green ≥100%, yellow 85–99%, red <85%.
const flagFor = p => p == null ? 'none' : p >= 100 ? 'green' : p >= 85 ? 'yellow' : 'red';
export async function dailyScorecard(userId, date) {
  const day = date || new Date().toISOString().slice(0, 10);
  const std = await stdHoursByModelStage();
  const from = new Date(new Date(day + 'T12:00:00Z').getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const logs = await all(
    `SELECT w.log_date, w.workstation, w.stage, w.hours, w.stage_complete, w.order_id, o.model_id, o.qty, m.name AS model
       FROM work_log w LEFT JOIN sales_order o ON o.id = w.order_id LEFT JOIN model m ON m.id = o.model_id
      WHERE w.user_id = $1 AND w.log_date BETWEEN $2 AND $3 ORDER BY w.id`, [userId, from, day]);
  const dayKey = d => d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); // PGlite returns DATE as a JS Date
  const byDay = {};
  const drill = [];
  for (const w of logs) {
    const k = dayKey(w.log_date);
    const b = (byDay[k] = byDay[k] || { std: 0, actual: 0 });
    const hrs = Number(w.hours) || 0;
    const earned = w.stage_complete ? (std[`${w.model_id}|${w.stage}`] || 0) * (Number(w.qty) || 1) : 0;
    b.actual += hrs; b.std += earned;
    if (k === day) drill.push({ orderId: w.order_id, model: w.model, workstation: w.workstation, stage: w.stage,
      hours: r1(hrs), stageComplete: !!w.stage_complete, earnedStd: r1(earned) });
  }
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(new Date(day + 'T12:00:00Z').getTime() - i * 864e5).toISOString().slice(0, 10);
    const b = byDay[d] || { std: 0, actual: 0 };
    trend.push({ date: d, pct: pct(b.std, b.actual) });
  }
  const today = byDay[day] || { std: 0, actual: 0 };
  return {
    date: day, hoursLogged: r1(today.actual), stdEarned: r1(today.std),
    effPct: pct(today.std, today.actual), flag: flagFor(pct(today.std, today.actual)),
    trend, drill,
  };
}

// The whole dashboard in one call.
export async function shopDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const [effToday, effWeek, sop, wipOver] = await Promise.all([
    laborEfficiency(today, today), laborEfficiency(weekAgo, today), sopList(), bottlenecks(),
  ]);
  const threshold = RED_FLAG_PCT();
  // Red flags: today's people with real hours logged but efficiency under the threshold.
  const redFlags = effToday.byUser
    .filter(u => u.actual >= 1 && u.pct != null && u.pct < threshold)
    .sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0));
  return {
    laborEff: { today: { std: effToday.std, actual: effToday.actual, pct: effToday.pct },
                week: { std: effWeek.std, actual: effWeek.actual, pct: effWeek.pct },
                byStation: effToday.byStation },
    sop: { required: sop.required, confirmed: sop.confirmed, pct: sop.pct },
    redFlags, threshold,
    bottlenecks: wipOver,
  };
}
