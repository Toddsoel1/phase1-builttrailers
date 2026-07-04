// 📜 My Work — each employee's own completed-work record over any window (week/month/year/
// custom): trailers by build step (welded / painted / finished…) down to VIN and model,
// made/sub-assembly parts by part number (part_build_log), grouped completed tasks
// (bunkboards carpeted, decking installed…), and hours logged.
//
// Attribution is deliberately strict: build steps count only when stamped by a signed-in
// account (logged_by) — typed shop-floor initials don't accrue to anyone's record, which is
// exactly the incentive to log in.
import { all, one } from './db.js';
import { BUILD_STEPS } from './warranty.js';

const STEP_LABEL = Object.fromEntries(BUILD_STEPS.map(s => [s.key, s.label]));

function normRange(from, to) {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').slice(0, 10));
  const t = new Date().toISOString().slice(0, 10);
  return { from: ok(from) ? String(from).slice(0, 10) : t.slice(0, 4) + '-01-01', to: ok(to) ? String(to).slice(0, 10) : t };
}

export async function myWork(userId, from, to) {
  const r = normRange(from, to);
  const user = await one('SELECT id, name FROM app_user WHERE id=$1', [userId]);
  if (!user) throw new Error('User not found.');

  // Trailers by build step — stamped per VIN whenever this person completed a stage.
  const stepRows = await all(`
    SELECT s.step, s.completed_at, t.vin, t.id AS unit_id, m.name AS model, m.category AS type
      FROM trailer_build_step s
      JOIN trailer t ON t.id = s.trailer_id
      LEFT JOIN model m ON m.id = t.model_id
     WHERE s.logged_by = $1
       AND s.completed_at >= $2::date AND s.completed_at < ($3::date + INTERVAL '1 day')
     ORDER BY s.completed_at DESC`, [userId, r.from, r.to]).catch(() => []);
  const stepAgg = {};
  for (const s of stepRows) {
    const g = (stepAgg[s.step] = stepAgg[s.step] || { step: s.step, label: STEP_LABEL[s.step] || s.step, count: 0, items: [] });
    g.count++;
    if (g.items.length < 200) g.items.push({ vin: s.vin, unitId: s.unit_id, model: s.model, type: s.type, at: s.completed_at });
  }
  const steps = Object.values(stepAgg).sort((a, b) => b.count - a.count);

  // Made / sub-assembly parts by part number.
  const partRows = await all(`
    SELECT b.part_id, p.name, SUM(b.qty) AS qty, COUNT(*)::int AS times, MAX(b.built_at) AS last_at
      FROM part_build_log b LEFT JOIN part p ON p.id = b.part_id
     WHERE b.user_id = $1
       AND b.built_at >= $2::date AND b.built_at < ($3::date + INTERVAL '1 day')
     GROUP BY b.part_id, p.name ORDER BY qty DESC`, [userId, r.from, r.to]).catch(() => []);
  const partsBuilt = partRows.map(p => ({ partId: p.part_id, name: p.name, qty: Number(p.qty), times: p.times, lastAt: p.last_at }));

  // Completed plan tasks, grouped by description (bunkboards carpeted, decking installed…).
  const taskRows = await all(`
    SELECT description, COUNT(*)::int AS count, COALESCE(SUM(est_hours),0) AS est, MAX(completed_at) AS last_at
      FROM daily_task
     WHERE user_id = $1 AND completed_at IS NOT NULL
       AND completed_at >= $2::date AND completed_at < ($3::date + INTERVAL '1 day')
     GROUP BY description ORDER BY count DESC, last_at DESC`, [userId, r.from, r.to]).catch(() => []);
  const tasks = taskRows.map(t => ({ description: t.description, count: t.count,
    estHours: Math.round(Number(t.est) * 10) / 10, lastAt: t.last_at }));

  const hours = await one(`SELECT COALESCE(SUM(hours),0) AS h FROM work_log
                            WHERE user_id=$1 AND log_date >= $2::date AND log_date <= $3::date`, [userId, r.from, r.to]).catch(() => null);

  return {
    userId, user: user.name, from: r.from, to: r.to,
    totals: {
      stepStamps: stepRows.length,
      unitsTouched: new Set(stepRows.map(s => s.unit_id)).size,
      partsQty: partsBuilt.reduce((a, p) => a + p.qty, 0),
      tasksDone: tasks.reduce((a, t) => a + t.count, 0),
      hoursLogged: Number(hours?.h || 0),
    },
    steps, partsBuilt, tasks,
  };
}
