// Performance analytics — evaluates the shop against explicit expectations (targets) and
// generates owned, actionable improvement items for the Shop Manager / General Manager.
// Data sources already accruing in the app:
//   order_stage_done  — when each production stage finished (daily update + every stage change)
//   sales_order.due   — the promise made to the customer
//   trailer.vin_assigned_at / warranty_claim — quality cohort
//   mrp()             — projected part shortages vs scheduled + in-production demand
// Targets live in app_config('perf_targets') and are editable by admins — "pushing
// expectations" means the bar is explicit, visible, and adjustable as the shop matures.
import { all, one, q } from './db.js';
import { mrp } from './mrp.js';

const PROD_STAGES = ['Scheduled', 'Build', 'Paint/Powder Coat', 'Finish'];

export const DEFAULT_TARGETS = {
  onTimePct: 90,        // % of orders reaching Ready on or before their due date
  maxAvgBuildDays: 14,  // avg calendar days from first production stamp to Ready
  staleWipDays: 5,      // an order sitting longer than this in one stage is "stuck"
  maxClaimRatePct: 8,   // warranty claims per unit built (trailing 90 days)
};

export async function getTargets() {
  const row = await one(`SELECT value FROM app_config WHERE key='perf_targets'`, []).catch(() => null);
  let saved;
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return { ...DEFAULT_TARGETS, ...saved };
}
export async function setTargets(body) {
  const next = { ...await getTargets() };
  for (const k of Object.keys(DEFAULT_TARGETS)) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '' && !isNaN(Number(body[k]))) next[k] = Number(body[k]);
  }
  await q(`INSERT INTO app_config(key,value) VALUES('perf_targets',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify(next)]);
  return next;
}

const day = 86400000;
const days = (a, b) => (new Date(a) - new Date(b)) / day;

// Avg calendar days spent in each production stage (trailing 90 days of completions).
// Duration of a stamp = time since the order's previous stamp, attributed to the stage
// that just finished — honest with the data we have (no synthetic stage-entry times).
async function stageCycleTimes() {
  const rows = await all(`SELECT order_id, stage, completed_at FROM order_stage_done
                           WHERE completed_at > now() - INTERVAL '90 days'
                           ORDER BY order_id, completed_at`, []).catch(() => []);
  const prev = {};
  const agg = {}; // stage -> { totalDays, n }
  for (const r of rows) {
    if (prev[r.order_id]) {
      const d = days(r.completed_at, prev[r.order_id]);
      if (d >= 0 && d < 120 && PROD_STAGES.includes(r.stage)) {
        (agg[r.stage] = agg[r.stage] || { totalDays: 0, n: 0 }).totalDays += d;
        agg[r.stage].n++;
      }
    }
    prev[r.order_id] = r.completed_at;
  }
  return PROD_STAGES.map(s => ({
    stage: s, n: agg[s]?.n || 0,
    avgDays: agg[s]?.n ? Math.round((agg[s].totalDays / agg[s].n) * 10) / 10 : null,
  }));
}

// Orders currently in production and how long since they last moved (stuck-WIP detector).
async function wipAging() {
  const rows = await all(`
    SELECT o.id, o.stage, o.due, m.name AS model,
           COALESCE((SELECT MAX(completed_at) FROM order_stage_done d WHERE d.order_id=o.id), o.created_at) AS last_move
      FROM sales_order o LEFT JOIN model m ON m.id=o.model_id
     WHERE o.stage = ANY($1)
     ORDER BY last_move`, [PROD_STAGES]).catch(() => []);
  return rows.map(r => ({ id: r.id, stage: r.stage, model: r.model, due: r.due,
    daysInStage: Math.floor(days(new Date(), r.last_move)) }));
}

// Orders that reached Ready in the trailing 90 days: on-time %, avg total build days, throughput.
async function completions() {
  const rows = await all(`
    SELECT d.order_id, d.completed_at AS ready_at, o.due,
           (SELECT MIN(completed_at) FROM order_stage_done f WHERE f.order_id=d.order_id) AS first_stamp
      FROM order_stage_done d JOIN sales_order o ON o.id=d.order_id
     WHERE d.stage='Finish' AND d.completed_at > now() - INTERVAL '90 days'`, []).catch(() => []);
  let onTime = 0, withDue = 0, buildDaysTotal = 0, buildDaysN = 0;
  for (const r of rows) {
    if (r.due) { withDue++; if (days(r.ready_at, r.due) <= 0) onTime++; }
    const bd = days(r.ready_at, r.first_stamp);
    if (bd >= 0 && bd < 365) { buildDaysTotal += bd; buildDaysN++; }
  }
  const weeks = 90 / 7;
  return {
    completed90: rows.length,
    throughputPerWeek: Math.round((rows.length / weeks) * 10) / 10,
    onTimePct: withDue ? Math.round((onTime / withDue) * 100) : null,
    withDue,
    avgBuildDays: buildDaysN ? Math.round((buildDaysTotal / buildDaysN) * 10) / 10 : null,
  };
}

// Quality: trailing-90-day claims vs units built, and the top failing part.
async function quality() {
  const claims90 = Number((await one(`SELECT COUNT(*)::int AS n FROM warranty_claim WHERE opened_at > now() - INTERVAL '90 days'`, []).catch(() => null))?.n || 0);
  const units90 = Number((await one(`SELECT COUNT(*)::int AS n FROM trailer WHERE vin_assigned_at > now() - INTERVAL '90 days'`, []).catch(() => null))?.n || 0);
  const topPart = await one(`SELECT COALESCE(part_name, part_id) AS name, SUM(qty*unit_cost) AS cost, COUNT(DISTINCT claim_id)::int AS claims
                               FROM warranty_claim_part GROUP BY COALESCE(part_name, part_id)
                               ORDER BY cost DESC NULLS LAST LIMIT 1`, []).catch(() => null);
  return {
    claims90, units90,
    claimRatePct: units90 ? Math.round((claims90 / units90) * 1000) / 10 : null,
    topFailingPart: topPart ? { name: topPart.name, claims: topPart.claims, cost: Number(topPart.cost) || 0 } : null,
  };
}

// Replenishment risk straight from the MRP engine (scheduled + in-production demand).
export async function replenishment() {
  const rows = await mrp();
  const crit = rows.filter(r => r.sev === 'crit');
  const warn = rows.filter(r => r.sev === 'warn');
  const item = r => ({ id: r.id, name: r.name, type: r.type, action: r.action, suggestQty: r.suggestQty,
    daysCover: r.daysCover, orderBy: r.orderBy, vendor: r.vendor });
  return {
    critBuy: crit.filter(r => r.type !== 'M').map(item),
    critMake: crit.filter(r => r.type === 'M').map(item),
    warnBuy: warn.filter(r => r.type !== 'M').map(item),
    warnMake: warn.filter(r => r.type === 'M').map(item),
  };
}

// The whole scorecard: KPIs vs targets, plus generated "areas for improvement" with owners.
export async function scorecard() {
  const [targets, cycles, aging, done, qual, rep, pastDueRow] = await Promise.all([
    getTargets(), stageCycleTimes(), wipAging(), completions(), quality(), replenishment(),
    one(`SELECT COUNT(*)::int AS n FROM sales_order
          WHERE stage NOT IN ('Quote','Ready','Cancelled') AND due IS NOT NULL AND due < CURRENT_DATE`, []).catch(() => null),
  ]);
  const pastDue = Number(pastDueRow?.n || 0);
  const stale = aging.filter(a => a.daysInStage > targets.staleWipDays);
  const slowest = cycles.filter(c => c.avgDays != null).sort((a, b) => b.avgDays - a.avgDays)[0] || null;
  const critParts = rep.critBuy.length + rep.critMake.length;
  const warnParts = rep.warnBuy.length + rep.warnMake.length;

  const status = (ok, warnCond) => ok ? 'ok' : (warnCond ? 'warn' : 'miss');
  const kpis = [
    { key: 'onTime', label: 'On-time delivery', value: done.onTimePct, unit: '%', target: targets.onTimePct, dir: '>=',
      status: done.onTimePct == null ? 'nodata' : status(done.onTimePct >= targets.onTimePct, done.onTimePct >= targets.onTimePct - 10) },
    { key: 'buildDays', label: 'Avg build time', value: done.avgBuildDays, unit: ' days', target: targets.maxAvgBuildDays, dir: '<=',
      status: done.avgBuildDays == null ? 'nodata' : status(done.avgBuildDays <= targets.maxAvgBuildDays, done.avgBuildDays <= targets.maxAvgBuildDays * 1.25) },
    { key: 'throughput', label: 'Throughput', value: done.throughputPerWeek, unit: '/wk', target: null, dir: null, status: 'info' },
    { key: 'claimRate', label: 'Warranty claim rate', value: qual.claimRatePct, unit: '%', target: targets.maxClaimRatePct, dir: '<=',
      status: qual.claimRatePct == null ? 'nodata' : status(qual.claimRatePct <= targets.maxClaimRatePct, qual.claimRatePct <= targets.maxClaimRatePct * 1.5) },
    { key: 'stockouts', label: 'Parts at stockout risk', value: critParts, unit: '', target: 0, dir: '<=',
      status: critParts === 0 ? (warnParts ? 'warn' : 'ok') : 'miss' },
    { key: 'pastDue', label: 'Orders past due', value: pastDue, unit: '', target: 0, dir: '<=',
      status: pastDue === 0 ? 'ok' : 'miss' },
  ];

  // Areas for improvement — each owned, specific, and linked to the screen that fixes it.
  const recs = [];
  if (done.onTimePct != null && done.onTimePct < targets.onTimePct)
    recs.push({ sev: 'miss', owner: 'General Manager', link: 'orders',
      text: `On-time delivery is ${done.onTimePct}% vs the ${targets.onTimePct}% expectation — review due-date commitments and the production sequence.` });
  if (pastDue)
    recs.push({ sev: 'miss', owner: 'Shop Manager', link: 'orders',
      text: `${pastDue} order(s) already past due and still in production — re-sequence or renegotiate dates today.` });
  if (stale.length)
    recs.push({ sev: 'warn', owner: 'Shop Manager', link: 'orders',
      text: `${stale.length} order(s) stuck >${targets.staleWipDays} days in one stage (worst: ${stale[stale.length - 1].id} — ${stale[stale.length - 1].daysInStage} days in ${stale[stale.length - 1].stage}). Unstick or split them.` });
  if (done.avgBuildDays != null && done.avgBuildDays > targets.maxAvgBuildDays)
    recs.push({ sev: 'miss', owner: 'Shop Manager', link: 'performance',
      text: `Average build is ${done.avgBuildDays} days vs the ${targets.maxAvgBuildDays}-day expectation${slowest ? ` — ${slowest.stage} is the bottleneck at ${slowest.avgDays} days` : ''}.` });
  else if (slowest && slowest.avgDays != null && slowest.avgDays > targets.maxAvgBuildDays / 2)
    recs.push({ sev: 'warn', owner: 'Shop Manager', link: 'performance',
      text: `${slowest.stage} is the slowest stage (${slowest.avgDays} days avg) — batching or extra hands there buys the most time.` });
  if (qual.claimRatePct != null && qual.claimRatePct > targets.maxClaimRatePct)
    recs.push({ sev: 'miss', owner: 'General Manager', link: 'trailers',
      text: `Warranty claim rate is ${qual.claimRatePct}% vs the ${targets.maxClaimRatePct}% expectation${qual.topFailingPart ? ` — top failing part: ${qual.topFailingPart.name} (${qual.topFailingPart.claims} claim(s))` : ''}. Engineering/vendor review warranted.` });
  if (critParts)
    recs.push({ sev: 'miss', owner: 'Shop Specialist', link: 'predict',
      text: `${critParts} part(s) will run out before replenishment can land — order/build NOW: ${[...rep.critBuy, ...rep.critMake].slice(0, 3).map(p => p.id).join(', ')}${critParts > 3 ? '…' : ''}.` });
  else if (warnParts)
    recs.push({ sev: 'warn', owner: 'Shop Specialist', link: 'predict',
      text: `${warnParts} part(s) below reorder level — place orders/schedule builds this week to stay ahead of demand.` });
  if (!recs.length)
    recs.push({ sev: 'ok', owner: 'Shop', link: 'performance', text: 'All expectations met — consider raising the targets.' });

  return { targets, kpis, cycles, aging: stale, completions: done, quality: qual, replenishment: rep, pastDue, recommendations: recs };
}
