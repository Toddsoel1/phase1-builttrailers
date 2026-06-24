// Phase 5 — People: employees & payroll, schedules, time-off approvals, outcomes,
// self-goals, recognition. Reuses the app_user hierarchy (manager_id) for routing.
import { all, one, q } from './db.js';
import { LABOR_BURDEN } from './cost.js';
import { userHasTitle } from './auth.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const REACTIONS = ['🎉', '🙌', '💪', '🔥', '👏'];

function parseSched(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
function toMin(t) { if (!t) return 0; const [a, b] = t.split(':').map(Number); return a * 60 + b; }
function weeklyHours(sched) {
  return DAYS.reduce((sum, d) => {
    const sl = sched[d]; if (!sl) return sum;
    let h = (toMin(sl[1]) - toMin(sl[0])) / 60; if (h > 6) h -= 0.5; return sum + h;
  }, 0);
}

export async function employees() {
  const emps = await all(`SELECT e.*, u.name AS mgr_name FROM employee e LEFT JOIN app_user u ON u.id=e.mgr_id ORDER BY e.id`, []);
  return emps.map(e => {
    const sched = parseSched(e.schedule);
    return {
      id: e.id, name: e.name, workstation: e.workstation, baseRate: Number(e.base_rate),
      hoursWk: Number(e.hours_wk), mgrId: e.mgr_id, manager: e.mgr_name, ptoBalance: Number(e.pto_balance),
      schedule: sched, weeklyHours: weeklyHours(sched),
      burdenedRate: Number(e.base_rate) * LABOR_BURDEN,
      weeklyCost: Number(e.base_rate) * Number(e.hours_wk) * LABOR_BURDEN
    };
  });
}
export async function payrollSummary() {
  const emps = await employees();
  const weekly = emps.reduce((s, e) => s + e.weeklyCost, 0);
  const byWs = {};
  emps.forEach(e => { byWs[e.workstation] = (byWs[e.workstation] || 0) + e.weeklyCost; });
  return { headcount: emps.length, weekly, annualized: weekly * 52, byWorkstation: byWs, burden: LABOR_BURDEN };
}

// ---- time off ----
const SAFE = u => `${u.name} (${u.title || u.role})`;
export async function timeOffList() {
  return (await all(`SELECT t.*, e.name AS emp_name, e.mgr_id FROM time_off t LEFT JOIN employee e ON e.id=t.emp_id ORDER BY t.id DESC`, []))
    .map(t => ({
      id: t.id, empId: t.emp_id, emp: t.emp_name, mgrId: t.mgr_id, type: t.type, start: t.start_date, end: t.end_date,
      hours: Number(t.hours), reason: t.reason, status: t.status, submittedOn: t.submitted_on,
      mgrBy: t.mgr_by, mgrOn: t.mgr_on, payBy: t.pay_by, payOn: t.pay_on
    }));
}
export async function canApproveTO(user, toId) {
  if (user.role === 'admin') return true;
  const r = await one(`SELECT e.mgr_id FROM time_off t JOIN employee e ON e.id=t.emp_id WHERE t.id=$1`, [toId]);
  return r && r.mgr_id === user.id;
}
export function canProcessTO(user) { return user.role === 'admin' || userHasTitle(user, ['Office Manager']); }

export async function submitTimeOff({ empId, type, start, end, hours, reason }, user) {
  const n = (await all('SELECT id FROM time_off', [])).length;
  const id = 'TO-' + (2005 + n);
  await q(`INSERT INTO time_off(id,emp_id,type,start_date,end_date,hours,reason,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending Manager')`,
    [id, empId, type, start || null, end || null, Number(hours) || 0, reason || '']);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [user.id, 'timeoff.submit', `${id} ${empId} ${type}`]);
  return id;
}
export async function approveTimeOff(id, user) {
  await q(`UPDATE time_off SET status='Approved - To Payroll', mgr_by=$1, mgr_on=CURRENT_DATE WHERE id=$2`, [SAFE(user), id]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [user.id, 'timeoff.approve', id]);
}
export async function denyTimeOff(id, user) {
  await q(`UPDATE time_off SET status='Denied', mgr_by=$1, mgr_on=CURRENT_DATE WHERE id=$2`, [SAFE(user), id]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [user.id, 'timeoff.deny', id]);
}
export async function processTimeOff(id, user) {
  const t = await one('SELECT * FROM time_off WHERE id=$1', [id]);
  if (!t || t.status !== 'Approved - To Payroll') return false;
  await q(`UPDATE time_off SET status='Processed', pay_by=$1, pay_on=CURRENT_DATE WHERE id=$2`, [SAFE(user), id]);
  if (t.type === 'PTO') await q('UPDATE employee SET pto_balance = GREATEST(0, pto_balance - $1) WHERE id=$2', [Number(t.hours), t.emp_id]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [user.id, 'timeoff.process', id]);
  return true;
}
export async function setSchedule(empId, schedule, user) {
  await q('UPDATE employee SET schedule=$1 WHERE id=$2', [JSON.stringify(schedule), empId]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [user.id, 'schedule.set', empId]);
}

// ---- outcomes ----
export async function outcomeFor(uid) {
  return await one('SELECT * FROM user_outcome WHERE user_id=$1', [uid]);
}
export async function setOutcome(uid, { day, week, month }, user) {
  const ex = await outcomeFor(uid);
  if (ex) await q(`UPDATE user_outcome SET day=$1,week=$2,month=$3,set_by=$4,set_on=CURRENT_DATE WHERE user_id=$5`, [day, week, month, SAFE(user), uid]);
  else await q(`INSERT INTO user_outcome(user_id,day,week,month,set_by,set_on) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)`, [uid, day, week, month, SAFE(user)]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [user.id, 'outcome.set', uid]);
}

// ---- self goals ----
export async function selfGoals(uid) {
  return (await all('SELECT * FROM self_goal WHERE user_id=$1 ORDER BY created_on DESC, id DESC', [uid]))
    .map(g => ({ id: g.id, text: g.text, horizon: g.horizon, done: g.done, on: g.created_on }));
}
export async function addSelfGoal(uid, text, horizon) {
  const id = 'SG-' + Date.now();
  await q('INSERT INTO self_goal(id,user_id,text,horizon) VALUES ($1,$2,$3,$4)', [id, uid, text, horizon || 'Month']);
  return id;
}
export async function toggleSelfGoal(uid, id) { await q('UPDATE self_goal SET done = NOT done WHERE id=$1 AND user_id=$2', [id, uid]); }
export async function deleteSelfGoal(uid, id) { await q('DELETE FROM self_goal WHERE id=$1 AND user_id=$2', [id, uid]); }

// ---- recognition ----
export async function wins() {
  const ws = await all('SELECT * FROM win ORDER BY created_on DESC, id DESC', []);
  const rx = await all('SELECT * FROM win_reaction', []);
  const users = await all('SELECT id,name,title FROM app_user', []);
  const uname = id => { const u = users.find(x => x.id === id); return u ? u.name : id; };
  return ws.map(w => {
    const r = rx.filter(x => x.win_id === w.id);
    const reactions = {};
    REACTIONS.forEach(e => { const a = r.filter(x => x.emoji === e).map(x => x.user_id); if (a.length) reactions[e] = a; });
    let targetLabel = w.target;
    if (w.scope === 'individual') targetLabel = uname(w.target);
    else if (w.scope === 'workstation') targetLabel = w.target + ' workstation';
    else targetLabel = w.target + ' department';
    return { id: w.id, scope: w.scope, target: w.target, targetLabel, title: w.title, detail: w.detail, by: uname(w.by_user), on: w.created_on, reactions, cheers: r.length };
  });
}
export async function postWin({ scope, target, title, detail }, user) {
  const id = 'W-' + Date.now();
  await q('INSERT INTO win(id,scope,target,title,detail,by_user) VALUES ($1,$2,$3,$4,$5,$6)', [id, scope, target, title, detail || '', user.id]);
  return id;
}
export async function reactWin(winId, emoji, userId) {
  if (!REACTIONS.includes(emoji)) return;
  const ex = await one('SELECT 1 AS x FROM win_reaction WHERE win_id=$1 AND emoji=$2 AND user_id=$3', [winId, emoji, userId]);
  if (ex) await q('DELETE FROM win_reaction WHERE win_id=$1 AND emoji=$2 AND user_id=$3', [winId, emoji, userId]);
  else await q('INSERT INTO win_reaction(win_id,emoji,user_id) VALUES ($1,$2,$3)', [winId, emoji, userId]);
}
export async function departments() {
  const cats = (await all('SELECT DISTINCT category FROM model', [])).map(r => r.category);
  return ['Sales', 'Production', 'Office', 'Quality', ...cats.map(c => c + ' Line')];
}
export async function workstationsList() {
  return (await all('SELECT DISTINCT workstation FROM employee WHERE workstation IS NOT NULL ORDER BY workstation', [])).map(r => r.workstation);
}
