// Phase 4 — WIP execution + valuation.
//
// Daily production updates by user & workstation are the engine: when a workstation logs a
// stage *complete* for an order, that stage's BOM (tagged in phase 3) is consumed from raw
// inventory and capitalized into the order's work-in-process value — material at actual
// cost, labor at the model's standard hours. Inventory value flows raw → WIP → COGS and is
// conserved at each step (on-hand value drops exactly as WIP rises).
import { all, one, q } from './db.js';

export const PROD_STAGES = ['Build', 'Paint/Powder Coat', 'Finish'];

// Distinct workstations across model routings + anything logged historically.
export async function workstations() {
  const a = await all('SELECT DISTINCT ws AS w FROM model_labor', []).catch(() => []);
  const b = await all('SELECT DISTINCT workstation AS w FROM work_log WHERE workstation IS NOT NULL', []).catch(() => []);
  const c = await all('SELECT name AS w FROM workstation WHERE active', []).catch(() => []); // registry: Sub-Assembly etc.
  return [...new Set([...a, ...b, ...c].map(r => r.w).filter(Boolean))].sort();
}

// The stage a workstation belongs to — the registry wins (it's how added stations like
// Sub-Assembly get a stage), the model routing is the fallback.
export async function stageForWorkstation(ws) {
  if (!ws) return null;
  const reg = await one('SELECT stage FROM workstation WHERE name=$1', [ws]).catch(() => null);
  if (reg?.stage) return reg.stage;
  const r = await one('SELECT stage FROM model_labor WHERE ws=$1 LIMIT 1', [ws]).catch(() => null);
  return r?.stage || null;
}

// Consume one stage's BOM for an order — idempotent per (order, stage). Each part consumed
// is recorded against the workstation/user/day so consumption can be reported per workstation.
export async function consumeStage(orderId, stage, ctx = {}) {
  const o = await one('SELECT * FROM sales_order WHERE id=$1', [orderId]);
  if (!o) return { consumed: false, reason: 'no order' };
  if (await one('SELECT 1 AS x FROM order_stage_done WHERE order_id=$1 AND stage=$2', [orderId, stage]))
    return { consumed: false, reason: 'already done' };
  const logDate = ctx.logDate || new Date().toISOString().slice(0, 10);
  // Effective per-unit BOM for this stage = the base model BOM + this order's configurator deltas
  // (signed; from the Boat Trailer Builder). A standard order has no deltas and behaves as before;
  // a configured boat trailer consumes exactly its real parts (swapped axle/wheels, brakes, etc.).
  const eff = new Map(); // part_id -> { qty, cost }
  for (const l of await all(
    `SELECT b.part_id, b.qty, p.cost FROM bom_line b JOIN part p ON p.id=b.part_id
      WHERE b.model_id=$1 AND b.stage=$2`, [o.model_id, stage]))
    eff.set(l.part_id, { qty: Number(l.qty), cost: Number(l.cost) || 0 });
  for (const d of await all(
    `SELECT d.part_id, d.qty, p.cost FROM order_bom_delta d JOIN part p ON p.id=d.part_id
      WHERE d.order_id=$1 AND d.stage=$2`, [orderId, stage])) {
    const e = eff.get(d.part_id) || { qty: 0, cost: Number(d.cost) || 0 };
    e.qty += Number(d.qty);
    e.cost = Number(d.cost) || e.cost;
    eff.set(d.part_id, e);
  }
  let materialValue = 0, partsConsumed = 0;
  for (const [partId, e] of eff) {
    if (e.qty <= 0) continue;
    const qty = e.qty * Number(o.qty), unit = e.cost;
    await q('UPDATE part SET on_hand = GREATEST(0, on_hand - $1) WHERE id=$2', [qty, partId]);
    await q(`INSERT INTO inventory_consumption(order_id,stage,workstation,user_id,part_id,qty,unit_cost,ext_value,log_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orderId, stage, ctx.workstation || null, ctx.userId || null, partId, qty, unit, qty * unit, logDate]);
    materialValue += qty * unit;
    partsConsumed++;
  }
  await q(`INSERT INTO order_stage_done(order_id,stage,completed_by,workstation,completed_at)
           VALUES ($1,$2,$3,$4,now()) ON CONFLICT(order_id,stage) DO NOTHING`,
    [orderId, stage, ctx.userId || null, ctx.workstation || null]);
  return { consumed: true, parts: partsConsumed, materialValue };
}

// Standard labor $ for the stages already completed on an order (hours × rate × qty).
async function laborDoneValue(orderId) {
  const r = await one(
    `SELECT COALESCE(SUM(ml.hours * COALESCE(ml.rate,35) * o.qty),0) AS v
       FROM order_stage_done d
       JOIN sales_order o  ON o.id = d.order_id
       JOIN model_labor ml ON ml.model_id = o.model_id AND ml.stage = d.stage
      WHERE d.order_id=$1`, [orderId]).catch(() => ({ v: 0 }));
  return Number(r?.v || 0);
}

// Accumulated WIP value for one order: consumed materials (actual) + standard labor for done stages.
export async function orderWip(orderId) {
  const m = await one('SELECT COALESCE(SUM(ext_value),0) AS v FROM inventory_consumption WHERE order_id=$1', [orderId]).catch(() => ({ v: 0 }));
  return Number(m?.v || 0) + await laborDoneValue(orderId);
}

// WIP value for EVERY order in two aggregate queries (vs. two per order) — { orderId: value }.
// Identical math to orderWip(); used by the valuation + WIP-report callers.
export async function orderWipMap() {
  const [mat, lab] = await Promise.all([
    all('SELECT order_id, COALESCE(SUM(ext_value),0) AS v FROM inventory_consumption GROUP BY order_id', []).catch(() => []),
    all(`SELECT d.order_id AS order_id, COALESCE(SUM(ml.hours * COALESCE(ml.rate,35) * o.qty),0) AS v
           FROM order_stage_done d
           JOIN sales_order o  ON o.id = d.order_id
           JOIN model_labor ml ON ml.model_id = o.model_id AND ml.stage = d.stage
          GROUP BY d.order_id`, []).catch(() => []),
  ]);
  const map = {};
  for (const r of mat) map[r.order_id] = Number(r.v);
  for (const r of lab) map[r.order_id] = (map[r.order_id] || 0) + Number(r.v);
  return map;
}

// Units on the order that haven't passed the QC checklist yet — the gate before Ready.
// Every path that can move an order to Ready checks this (stage PATCH, station QR, daily update).
export async function qcMissing(orderId) {
  return all(`SELECT COALESCE(t.vin, t.id) AS ref FROM trailer t
               WHERE t.order_id=$1 AND NOT EXISTS
                 (SELECT 1 FROM trailer_build_step s WHERE s.trailer_id=t.id AND s.step='QC')`, [orderId]).catch(() => []);
}

// Log a daily production update. If stageComplete, consume that stage's BOM and advance the
// order to the next production stage so the board reflects progress.
export async function logWork({ userId, orderId, workstation, stage, hours, note, stageComplete, logDate }) {
  const o = await one('SELECT * FROM sales_order WHERE id=$1', [orderId]);
  if (!o) throw new Error('Order not found');
  if (o.billed) throw new Error('Order is already invoiced — nothing to log against it.');
  if (!stage) stage = await stageForWorkstation(workstation);
  const day = logDate || new Date().toISOString().slice(0, 10);
  await q(`INSERT INTO work_log(log_date,user_id,order_id,workstation,stage,hours,note,stage_complete)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [day, userId || null, orderId, workstation || null, stage || null, Number(hours) || 0, note || null, !!stageComplete]);
  let consumed = null, advanced = null, qcHold = 0;
  if (stageComplete && PROD_STAGES.includes(stage)) {
    consumed = await consumeStage(orderId, stage, { workstation, userId, logDate: day });
    const idx = PROD_STAGES.indexOf(stage);
    advanced = idx < PROD_STAGES.length - 1 ? PROD_STAGES[idx + 1] : 'Ready';
    // only move forward — never drag an order backward if it's already further along
    const cur = (await one('SELECT stage FROM sales_order WHERE id=$1', [orderId]))?.stage;
    const allStages = ['Quote', 'Confirmed', 'Scheduled', ...PROD_STAGES, 'Ready'];
    if (advanced === 'Ready') {
      // the QC gate: hold at Finish (work still logged + consumed) until every VIN passes QC
      const missing = await qcMissing(orderId);
      if (missing.length) { qcHold = missing.length; advanced = null; }
    }
    if (advanced && allStages.indexOf(advanced) > allStages.indexOf(cur))
      await q('UPDATE sales_order SET stage=$1 WHERE id=$2', [advanced, orderId]);
    else advanced = null;
  }
  return { stage, consumed, advanced, qcHold };
}

// Daily report: every log line + per-workstation/user hours and material $ consumed, for a date.
export async function dailyReport(date) {
  const day = date || new Date().toISOString().slice(0, 10);
  const logs = await all(
    `SELECT w.id, w.user_id, u.name AS user_name, w.workstation, w.stage, w.order_id,
            m.name AS model, w.hours, w.note, w.stage_complete
       FROM work_log w
       LEFT JOIN app_user u ON u.id = w.user_id
       LEFT JOIN sales_order o ON o.id = w.order_id
       LEFT JOIN model m ON m.id = o.model_id
      WHERE w.log_date=$1
      ORDER BY u.name, w.workstation, w.order_id`, [day]).catch(() => []);
  const consRows = await all(
    `SELECT COALESCE(workstation,'(unassigned)') AS workstation, user_id,
            COALESCE(SUM(ext_value),0) AS material, COUNT(*) AS lines
       FROM inventory_consumption WHERE log_date=$1
      GROUP BY workstation, user_id`, [day]).catch(() => []);
  // roll the logs up by workstation
  const wsMap = {};
  for (const l of logs) {
    const w = l.workstation || '(unassigned)';
    wsMap[w] = wsMap[w] || { workstation: w, hours: 0, stagesCompleted: 0, orders: new Set(), material: 0 };
    wsMap[w].hours += Number(l.hours) || 0;
    if (l.stage_complete) wsMap[w].stagesCompleted++;
    if (l.order_id) wsMap[w].orders.add(l.order_id);
  }
  for (const c of consRows) {
    const w = c.workstation || '(unassigned)';
    wsMap[w] = wsMap[w] || { workstation: w, hours: 0, stagesCompleted: 0, orders: new Set(), material: 0 };
    wsMap[w].material += Number(c.material) || 0;
  }
  const byWorkstation = Object.values(wsMap).map(x => ({ ...x, orders: x.orders.size }))
    .sort((a, b) => b.hours - a.hours);
  const totalHours = byWorkstation.reduce((s, w) => s + w.hours, 0);
  const totalMaterial = byWorkstation.reduce((s, w) => s + w.material, 0);
  return { date: day, logs, byWorkstation, totalHours, totalMaterial };
}

// Open (un-invoiced) orders that have entered production, with current WIP value + done stages.
export async function wipReport() {
  const orders = await all(
    `SELECT o.id, m.name AS model, c.name AS customer, o.stage, o.qty
       FROM sales_order o
       LEFT JOIN model m ON m.id=o.model_id
       LEFT JOIN customer c ON c.id=o.customer_id
      WHERE o.billed = false AND o.stage NOT IN ('Quote','Confirmed','Scheduled')
      ORDER BY o.production_seq NULLS LAST, o.id`, []).catch(() => []);
  // WIP value + done stages for all orders up front, instead of two queries per order.
  const [wipMap, doneRows] = await Promise.all([
    orderWipMap(),
    all('SELECT order_id, stage FROM order_stage_done', []).catch(() => []),
  ]);
  const doneBy = {};
  for (const r of doneRows) (doneBy[r.order_id] ||= []).push(r.stage);
  return orders.map(o => ({
    id: o.id, model: o.model, customer: o.customer, stage: o.stage, qty: o.qty,
    wip: wipMap[o.id] || 0, doneStages: doneBy[o.id] || [],
  }));
}

// "How much inventory each workstation consumed" — material $ rolled up by workstation.
export async function consumptionByWorkstation(from, to) {
  const params = [], where = [];
  if (from) { params.push(from); where.push(`log_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`log_date <= $${params.length}`); }
  const sql = `SELECT COALESCE(workstation,'(unassigned)') AS workstation,
                      COUNT(DISTINCT order_id) AS orders, COALESCE(SUM(qty),0) AS qty,
                      COALESCE(SUM(ext_value),0) AS material
                 FROM inventory_consumption
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                GROUP BY workstation ORDER BY material DESC`;
  return (await all(sql, params).catch(() => []))
    .map(r => ({ workstation: r.workstation, orders: Number(r.orders), qty: Number(r.qty), material: Number(r.material) }));
}
