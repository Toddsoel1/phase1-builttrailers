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
const DAY_HOURS = Number(process.env.STANDUP_DAY_HOURS || 8);

const today = () => new Date().toISOString().slice(0, 10);
export function normDate(d) {
  const s = String(d || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : today();
}

// Propose the day's tasks. Idempotent per (date, order, stage, workstation): re-running fills
// gaps (new orders since the last run) without duplicating or touching edited/approved tasks.
export async function generatePlan(date, byUserId) {
  const d = normDate(date);
  const existing = await all(`SELECT order_id, stage, workstation FROM daily_task WHERE plan_date=$1`, [d]);
  const have = new Set(existing.map(t => `${t.order_id}|${t.stage}|${t.workstation || ''}`));
  const orders = await all(`
    SELECT o.id, o.qty, o.stage, o.model_id, m.name AS model
      FROM sales_order o LEFT JOIN model m ON m.id=o.model_id
     WHERE o.stage = ANY($1) AND o.billed = false
     ORDER BY o.production_seq NULLS LAST, o.created_at`, [PROD_STAGES]);
  const workers = await all(`SELECT id, name, workstation FROM app_user
                              WHERE active IS DISTINCT FROM false AND workstation IS NOT NULL`, []);
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
      // Pick the least-loaded worker at this station who still has room; else leave unassigned.
      const candidates = workers.filter(w => r.ws && w.workstation === r.ws)
        .sort((a, b) => (load[a.id] || 0) - (load[b.id] || 0));
      const pick = candidates.find(w => (load[w.id] || 0) + est <= DAY_HOURS) || candidates[0] || null;
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

// The stand-up board: everyone's day, grouped, + the unassigned bucket.
export async function planFor(date) {
  const d = normDate(date);
  const rows = await all(`SELECT t.*, u.name AS user_name FROM daily_task t
                            LEFT JOIN app_user u ON u.id=t.user_id
                           WHERE t.plan_date=$1 ORDER BY u.name NULLS LAST, t.id`, [d]);
  const tasks = rows.map(shape);
  const proposed = tasks.filter(t => t.status === 'proposed').length;
  return { date: d, tasks, proposed,
    workers: await all(`SELECT id, name, workstation FROM app_user WHERE active IS DISTINCT FROM false ORDER BY name`, []) };
}

// One worker's day: the goal, the score, and the hours story.
export async function myDay(userId, date) {
  const d = normDate(date);
  const rows = await all(`SELECT t.*, NULL AS user_name FROM daily_task t
                           WHERE t.plan_date=$1 AND t.user_id=$2 AND t.status<>'proposed' ORDER BY t.id`, [d, userId]);
  const tasks = rows.map(shape);
  const done = tasks.filter(t => t.done).length;
  const actual = await one(`SELECT COALESCE(SUM(hours),0) AS h FROM work_log WHERE user_id=$1 AND log_date=$2`, [userId, d]).catch(() => null);
  return { date: d, tasks, goal: tasks.length, done,
    estHours: Math.round(tasks.reduce((a, t) => a + t.estHours, 0) * 10) / 10,
    actualHours: Number(actual?.h || 0) };
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
  return rows.map(r => ({ date: fmtDate(r.plan_date), userId: r.user_id, user: r.name,
    assigned: r.assigned, done: r.done, donePct: r.assigned ? Math.round((r.done / r.assigned) * 100) : null,
    estHours: Math.round(Number(r.est) * 10) / 10,
    actualHours: hKey[`${fmtDate(r.plan_date)}|${r.user_id}`] ?? 0 }));
}
