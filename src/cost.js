// Cost rollup engine — single source of truth for trailer cost & inventory valuation.
// Manufactured parts store raw-material cost directly; build labor comes from each
// model's labor routing × a burdened blended rate (real payroll arrives in Phase 5).
import { all } from './db.js';
import { orderWipMap } from './wip.js';

export const LABOR_RATE = Number(process.env.LABOR_RATE || 37); // fallback $/hr if a workstation has no staff
export const LABOR_BURDEN = Number(process.env.LABOR_BURDEN || 1.32); // payroll tax + benefits multiplier

// Phase 5: blended burdened $/hr per workstation, from the actual employee roster.
export async function wsRates() {
  const rows = await all(`SELECT workstation, AVG(base_rate) AS avg_rate FROM employee WHERE workstation IS NOT NULL GROUP BY workstation`, []);
  const map = {};
  rows.forEach(r => { map[r.workstation] = Number(r.avg_rate) * LABOR_BURDEN; });
  return map;
}
export function partUnitCost(part) { return Number(part.cost) || 0; }

// Pure rollup from already-fetched rows (no DB access) — the shared math behind both the
// single-model modelRollup and the bulk modelsSummary, so the two can never diverge.
function computeRollup(m, lines, labor, rates) {
  // Per-stage rollup of material + labor — the foundation for WIP valuation (phase 4).
  const STAGE_LIST = ['Build', 'Paint/Powder Coat', 'Finish'];
  const stageOf = s => STAGE_LIST.includes(s) ? s : 'Build';
  const byStage = {}; for (const s of STAGE_LIST) byStage[s] = { material: 0, laborHrs: 0, laborCost: 0, total: 0 };
  let material = 0;
  const bom = lines.map(l => {
    const unit = Number(l.cost) || 0, ext = unit * Number(l.qty), st = stageOf(l.stage);
    material += ext; byStage[st].material += ext; byStage[st].total += ext;
    return { partId: l.part_id, name: l.name, type: l.type, qty: Number(l.qty), unitCost: unit, ext, stage: st };
  });
  const laborOut = labor.map(l => {
    const rate = Number(l.rate) || rates[l.ws] || LABOR_RATE, ext = Number(l.hours) * rate, st = stageOf(l.stage);
    byStage[st].laborHrs += Number(l.hours); byStage[st].laborCost += ext; byStage[st].total += ext;
    return { ws: l.ws, hours: Number(l.hours), rate, ext, stage: st };
  });
  const laborHrs = labor.reduce((s, l) => s + Number(l.hours), 0);
  const laborCost = laborOut.reduce((s, l) => s + l.ext, 0);
  const totalCost = material + laborCost;
  const price = Number(m.price);
  return {
    id: m.id, name: m.name, category: m.category, axle: m.axle, price, cap: Number(m.cap),
    material, laborHrs, laborCost, totalCost,
    margin: price > 0 ? (price - totalCost) / price : 0,
    marginDollars: price - totalCost,
    bom, labor: laborOut, byStage
  };
}

export async function modelRollup(modelId, rates) {
  const m = (await all('SELECT * FROM model WHERE id=$1', [modelId]))[0];
  if (!m) return null;
  if (!rates) rates = await wsRates();
  const lines = await all(
    `SELECT b.part_id, b.qty, b.stage, p.name, p.type, p.cost
       FROM bom_line b JOIN part p ON p.id=b.part_id
      WHERE b.model_id=$1 ORDER BY p.type DESC, p.id`, [modelId]);
  const labor = await all('SELECT ws, hours, rate, stage FROM model_labor WHERE model_id=$1', [modelId]);
  return computeRollup(m, lines, labor, rates);
}

// Bulk version — fetches every model, BOM line and labor step in 4 queries total (was ~3
// per model), then rolls up in memory. Same output as mapping modelRollup over the models.
export async function modelsSummary() {
  const [models, allLines, allLabor, rates] = await Promise.all([
    all('SELECT * FROM model ORDER BY category, id', []),
    all(`SELECT b.model_id, b.part_id, b.qty, b.stage, p.name, p.type, p.cost
           FROM bom_line b JOIN part p ON p.id=b.part_id ORDER BY p.type DESC, p.id`, []),
    all('SELECT model_id, ws, hours, rate, stage FROM model_labor', []),
    wsRates(),
  ]);
  const linesBy = {}, laborBy = {};
  for (const l of allLines) (linesBy[l.model_id] ||= []).push(l);
  for (const l of allLabor) (laborBy[l.model_id] ||= []).push(l);
  return models.map(m => computeRollup(m, linesBy[m.id] || [], laborBy[m.id] || [], rates));
}

export async function inventoryValuation() {
  const parts = await all('SELECT * FROM part', []);
  let rawPurchased = 0, makeParts = 0, below = 0;
  for (const p of parts) {
    const v = partUnitCost(p) * Number(p.on_hand);
    if (p.type === 'M') makeParts += v; else rawPurchased += v;
    if (Number(p.on_hand) < Number(p.reorder)) below++;
  }
  // WIP + finished: value capitalized in un-invoiced orders. Materials consumed into these
  // orders have already left part.on_hand, so adding WIP on top is not double counting —
  // value simply flowed from raw stock into work-in-process.
  const [open, wipMap] = await Promise.all([
    all(`SELECT id, stage FROM sales_order WHERE billed = false`, []).catch(() => []),
    orderWipMap(),
  ]);
  let wipValue = 0, finishedValue = 0;
  for (const o of open) {
    const v = wipMap[o.id] || 0;
    if (v <= 0) continue;
    if (o.stage === 'Ready') finishedValue += v; else wipValue += v;
  }
  const onHandValue = rawPurchased + makeParts;
  return {
    totalValue: onHandValue + wipValue + finishedValue,
    onHandValue, rawPurchased, makeParts, wipValue, finishedValue,
    skuCount: parts.length,
    purchased: parts.filter(p => p.type === 'P').length,
    manufactured: parts.filter(p => p.type === 'M').length,
    belowReorder: below
  };
}
