// Daily Stand-Up — the shop's day, planned and scored.
//   1. generatePlan(date): proposes tasks from the production queue + each model's labor
//      routing — one task per order-stage-workstation, spread across the workers whose
//      default station matches (capacity-aware, queue order preserved). Unmatched work lands
//      in an "unassigned" bucket for the Shop Manager to hand out at stand-up.
//   2. The Shop Manager reassigns/adjusts/adds, then approves the day. Mid-day resets are just
//      more edits — every change is audited by the routes.
//   3. Workers see goal vs done on My Day; completing the real stage auto-checks the task.
//   4. Rows never disappear: the table IS the effectiveness log (assigned vs done vs hours,
//      per person per day), reported over any window.
import { all, one, q } from './db.js';

const PROD_STAGES = ['Scheduled', 'Build', 'Paint/Powder Coat', 'Finish'];

// The shop default: Monday–Thursday, 10-hour days starting 6am. Each employee can carry their
// own schedule (app_user.schedule JSON) — a second shift or a Fri/Sat crew is just other values.
export const DEFAULT_SCHEDULE = {
  days: (process.env.SHOP_DAYS || '1,2,3,4').split(',').map(Number).filter(n => n >= 0 && n <= 6),
  hours: Number(process.env.SHOP_HOURS || 10),
  start: process.env.SHOP_START || '06:00',
};
export function parseSchedule(raw) {
  if (!raw) return { ...DEFAULT_SCHEDULE };
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const days = Array.isArray(s.days) ? s.days.map(Number).filter(n => n >= 0 && n <= 6) : DEFAULT_SCHEDULE.days;
    return { days: days.length ? [...new Set(days)].sort() : DEFAULT_SCHEDULE.days,
      hours: Math.min(14, Math.max(1, Number(s.hours) || DEFAULT_SCHEDULE.hours)),
      start: /^\d{2}:\d{2}$/.test(s.start || '') ? s.start : DEFAULT_SCHEDULE.start };
  } catch { return { ...DEFAULT_SCHEDULE }; }
}
const weekdayOf = d => new Date(d + 'T12:00:00').getDay();
export const worksOn = (schedule, dateStr) => schedule.days.includes(weekdayOf(dateStr));

const today = () => new Date().toISOString().slice(0, 10);
export function normDate(d) {
  const s = String(d || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : today();
}

// Past goals & performance -> each worker's suggested daily capacity. Trailing 21 days of
// closed plan days (today excluded): the est-hours they actually COMPLETED per planned day,
// stretched +10% (expectations push gently up), clamped to 50–125% of the base day. No history
// yet = the base day. Returned alongside completion % so the Shop Manager sees the why.
export async function workerCalibration(baseHoursByUser = {}) {
  const rows = await all(`
    SELECT user_id,
           COUNT(DISTINCT plan_date)::int AS days,
           COUNT(*)::int AS assigned,
           COUNT(completed_at)::int AS done,
           COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN est_hours END), 0) AS done_est
      FROM daily_task
     WHERE status <> 'proposed' AND user_id IS NOT NULL
       AND plan_date >= CURRENT_DATE - INTERVAL '21 days' AND plan_date < CURRENT_DATE
     GROUP BY user_id`, []).catch(() => []);
  const out = {};
  for (const r of rows) {
    const base = baseHoursByUser[r.user_id] || DEFAULT_SCHEDULE.hours;
    const perDay = r.days ? Number(r.done_est) / r.days : 0;
    const capacity = perDay > 0
      ? Math.round(Math.min(base * 1.25, Math.max(base * 0.5, perDay * 1.1)) * 10) / 10
      : base;
    out[r.user_id] = { capacity, days: r.days,
      donePct: r.assigned ? Math.round((r.done / r.assigned) * 100) : null };
  }
  return out;
}

// Propose the day's tasks. Idempotent per (date, order, stage, workstation): re-running fills
// gaps (new orders since the last run) without duplicating or touching edited/approved tasks.
// Assignment is performance-aware: work spreads across a station's workers in proportion to
// each one's calibrated capacity (see workerCalibration), queue order preserved.
export async function generatePlan(date, byUserId) {
  const d = normDate(date);
  const existing = await all(`SELECT order_id, stage, workstation FROM daily_task WHERE plan_date=$1`, [d]);
  const have = new Set(existing.map(t => `${t.order_id}|${t.stage}|${t.workstation || ''}`));
  const orders = await all(`
    SELECT o.id, o.qty, o.stage, o.model_id, m.name AS model
      FROM sales_order o LEFT JOIN model m ON m.id=o.model_id
     WHERE o.stage = ANY($1) AND o.billed = false
     ORDER BY o.production_seq NULLS LAST, o.created_at`, [PROD_STAGES]);
  const allWorkers = await all(`SELECT id, name, workstation, schedule FROM app_user
                                 WHERE active IS DISTINCT FROM false AND workstation IS NOT NULL`, []);
  // Only people scheduled to work THIS day get auto-assigned; everyone else's station work
  // lands in the unassigned bucket for the Shop Manager to place at stand-up.
  const workers = allWorkers.filter(w => worksOn(parseSchedule(w.schedule), d));
  const baseHours = Object.fromEntries(allWorkers.map(w => [w.id, parseSchedule(w.schedule).hours]));
  const calib = await workerCalibration(baseHours);
  const capOf = id => calib[id]?.capacity || baseHours[id] || DEFAULT_SCHEDULE.hours;
  const load = {}; // user_id -> hours already assigned today
  for (const t of await all(`SELECT user_id, SUM(est_hours) AS h FROM daily_task
                              WHERE plan_date=$1 AND user_id IS NOT NULL GROUP BY user_id`, [d]))
    load[t.user_id] = Number(t.h);

  let created = 0;
  for (const o of orders) {
    // The labor routing rows for this order's CURRENT stage = the work the day holds.
    const routes = await all(`SELECT ws, SUM(hours) AS h FROM model_labor
                               WHERE model_id=$1 AND stage=$2 GROUP BY ws`, [o.model_id, o.stage]);
    const rows = routes.length ? routes : [{ ws: null, h: 0 }]; // no routing tagged -> unassigned bucket
    for (const r of rows) {
      const key = `${o.id}|${o.stage}|${r.ws || ''}`;
      if (have.has(key)) continue;
      const est = Math.round(Number(r.h || 0) * o.qty * 100) / 100;
      // Fill each station's workers in proportion to their calibrated capacity: the pick is
      // whoever ends up least full (as a share of THEIR capacity) after taking this task.
      const candidates = workers.filter(w => r.ws && w.workstation === r.ws)
        .sort((a, b) => (((load[a.id] || 0) + est) / capOf(a.id)) - (((load[b.id] || 0) + est) / capOf(b.id)));
      const pick = candidates.find(w => (load[w.id] || 0) + est <= capOf(w.id)) || candidates[0] || null;
      if (pick) load[pick.id] = (load[pick.id] || 0) + est;
      await q(`INSERT INTO daily_task(plan_date, user_id, order_id, stage, workstation, description, est_hours, source, assigned_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'auto',$8)`,
        [d, pick?.id || null, o.id, o.stage, r.ws, `${o.stage}: ${o.qty}× ${o.model || o.id} (${o.id})`, est, byUserId || null]);
      have.add(key); created++;
    }
  }
  return { date: d, created };
}

export async function approvePlan(date, byUserId) {
  const d = normDate(date);
  const r = await q(`UPDATE daily_task SET status='approved', approved_at=now(), assigned_by=COALESCE(assigned_by,$2)
                     WHERE plan_date=$1 AND status='proposed'`, [d, byUserId || null]);
  return { date: d, approved: r.rowCount ?? r.affectedRows ?? 0 };
}

export async function addTask(date, { userId, orderId, stage, workstation, description, estHours }, byUserId) {
  if (!description) throw new Error('Describe the task.');
  const d = normDate(date);
  const row = await one(`INSERT INTO daily_task(plan_date, user_id, order_id, stage, workstation, description, est_hours, source, status, assigned_by, approved_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,'manual','approved',$8,now()) RETURNING id`,
    [d, userId || null, orderId || null, stage || null, workstation || null, String(description).slice(0, 200), Number(estHours) || 0, byUserId || null]);
  return { id: row.id };
}

// The Shop Manager's mid-day reset: reassign, resize, or re-describe — any time.
export async function updateTask(id, { userId, estHours, description, status }) {
  const t = await one('SELECT * FROM daily_task WHERE id=$1', [id]);
  if (!t) throw new Error('Task not found.');
  await q(`UPDATE daily_task SET user_id=$1, est_hours=$2, description=$3, status=$4 WHERE id=$5`,
    [userId !== undefined ? (userId || null) : t.user_id,
     estHours !== undefined ? (Number(estHours) || 0) : t.est_hours,
     description !== undefined ? String(description).slice(0, 200) : t.description,
     ['proposed', 'approved'].includes(status) ? status : t.status, id]);
  return { ok: true };
}
export async function deleteTask(id) { await q('DELETE FROM daily_task WHERE id=$1', [id]); return { ok: true }; }

export async function completeTask(id, via, actorUserId, actorIsManager) {
  const t = await one('SELECT * FROM daily_task WHERE id=$1', [id]);
  if (!t) throw new Error('Task not found.');
  if (!actorIsManager && t.user_id !== actorUserId) throw new Error('That task is assigned to someone else.');
  if (!t.completed_at)
    await q(`UPDATE daily_task SET status='done', completed_at=now(), completed_via=$2 WHERE id=$1`, [id, via || 'manual']);
  return { ok: true };
}

// Called from applyOrderStage: finishing a stage checks off every matching task through today.
export async function autoCompleteForStage(orderId, stage) {
  await q(`UPDATE daily_task SET status='done', completed_at=now(), completed_via='stage'
           WHERE order_id=$1 AND stage=$2 AND completed_at IS NULL AND plan_date <= CURRENT_DATE`,
    [orderId, stage]).catch(() => {});
}

const fmtDate = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const shape = t => ({ id: t.id, date: fmtDate(t.plan_date), userId: t.user_id, user: t.user_name || null,
  orderId: t.order_id, stage: t.stage, workstation: t.workstation, description: t.description,
  estHours: Number(t.est_hours) || 0, status: t.status, source: t.source,
  done: !!t.completed_at, completedAt: t.completed_at, completedVia: t.completed_via });

// The stand-up board: everyone's day, grouped, + the unassigned bucket. Workers carry their
// performance calibration so the Shop Manager sees each person's suggested load and why.
export async function planFor(date) {
  const d = normDate(date);
  const rows = await all(`SELECT t.*, u.name AS user_name FROM daily_task t
                            LEFT JOIN app_user u ON u.id=t.user_id
                           WHERE t.plan_date=$1 ORDER BY u.name NULLS LAST, t.id`, [d]);
  const tasks = rows.map(shape);
  const proposed = tasks.filter(t => t.status === 'proposed').length;
  const raw = await all(`SELECT id, name, workstation, schedule FROM app_user WHERE active IS DISTINCT FROM false ORDER BY name`, []);
  const baseHours = Object.fromEntries(raw.map(w => [w.id, parseSchedule(w.schedule).hours]));
  const calib = await workerCalibration(baseHours);
  const workers = raw.map(w => {
    const sch = parseSchedule(w.schedule);
    return { id: w.id, name: w.name, workstation: w.workstation,
      capacity: calib[w.id]?.capacity ?? sch.hours, trailingDonePct: calib[w.id]?.donePct ?? null,
      scheduledToday: worksOn(sch, d), scheduleDays: sch.days, scheduleHours: sch.hours };
  });
  return { date: d, tasks, proposed, workers, dayHours: DEFAULT_SCHEDULE.hours };
}

// One worker's day: the goal, the score, the hours story, and whether they've verified it.
export async function myDay(userId, date) {
  const d = normDate(date);
  const rows = await all(`SELECT t.*, NULL AS user_name FROM daily_task t
                           WHERE t.plan_date=$1 AND t.user_id=$2 AND t.status<>'proposed' ORDER BY t.id`, [d, userId]);
  const tasks = rows.map(shape);
  const done = tasks.filter(t => t.done).length;
  const actual = await one(`SELECT COALESCE(SUM(hours),0) AS h FROM work_log WHERE user_id=$1 AND log_date=$2`, [userId, d]).catch(() => null);
  const ver = await one(`SELECT verified_at, note FROM day_verification WHERE user_id=$1 AND plan_date=$2`, [userId, d]).catch(() => null);
  return { date: d, tasks, goal: tasks.length, done,
    estHours: Math.round(tasks.reduce((a, t) => a + t.estHours, 0) * 10) / 10,
    actualHours: Number(actual?.h || 0),
    verifiedAt: ver?.verified_at || null, verifyNote: ver?.note || null };
}

// The 60-second end-of-day check: the worker confirms what actually got done. Checked task ids
// complete (their own, that day, only); the confirmation itself is stamped so reporting can
// distinguish a verified day from an unreviewed one.
export async function verifyDay(userId, date, completeIds = [], note) {
  const d = normDate(date);
  for (const id of (Array.isArray(completeIds) ? completeIds : [])) {
    const t = await one('SELECT * FROM daily_task WHERE id=$1 AND user_id=$2 AND plan_date=$3', [Number(id), userId, d]);
    if (t && !t.completed_at)
      await q(`UPDATE daily_task SET status='done', completed_at=now(), completed_via='verify' WHERE id=$1`, [t.id]);
  }
  await q(`INSERT INTO day_verification(user_id, plan_date, note) VALUES ($1,$2,$3)
           ON CONFLICT(user_id, plan_date) DO UPDATE SET verified_at=now(), note=$3`,
    [userId, d, (note || '').slice(0, 300) || null]);
  return myDay(userId, d);
}

// Effectiveness: per person per day — assigned vs done vs hours — over a trailing window.
export async function report(days = 14) {
  const rows = await all(`
    SELECT t.plan_date, t.user_id, u.name,
           COUNT(*)::int AS assigned,
           COUNT(t.completed_at)::int AS done,
           COALESCE(SUM(t.est_hours),0) AS est
      FROM daily_task t LEFT JOIN app_user u ON u.id=t.user_id
     WHERE t.plan_date >= CURRENT_DATE - ($1 || ' days')::interval AND t.user_id IS NOT NULL
       AND t.status <> 'proposed'
     GROUP BY t.plan_date, t.user_id, u.name ORDER BY t.plan_date DESC, u.name`, [String(Math.max(1, days))]);
  const hours = await all(`SELECT log_date, user_id, COALESCE(SUM(hours),0) AS h FROM work_log
                            WHERE log_date >= CURRENT_DATE - ($1 || ' days')::interval GROUP BY log_date, user_id`,
    [String(Math.max(1, days))]).catch(() => []);
  const hKey = Object.fromEntries(hours.map(h => [`${fmtDate(h.log_date)}|${h.user_id}`, Number(h.h)]));
  const vers = await all(`SELECT user_id, plan_date FROM day_verification
                           WHERE plan_date >= CURRENT_DATE - ($1 || ' days')::interval`, [String(Math.max(1, days))]).catch(() => []);
  const vKey = new Set(vers.map(v => `${fmtDate(v.plan_date)}|${v.user_id}`));
  return rows.map(r => ({ date: fmtDate(r.plan_date), userId: r.user_id, user: r.name,
    assigned: r.assigned, done: r.done, donePct: r.assigned ? Math.round((r.done / r.assigned) * 100) : null,
    estHours: Math.round(Number(r.est) * 10) / 10,
    actualHours: hKey[`${fmtDate(r.plan_date)}|${r.user_id}`] ?? 0,
    verified: vKey.has(`${fmtDate(r.plan_date)}|${r.user_id}`) }));
}
