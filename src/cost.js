// Cost rollup engine — single source of truth for trailer cost & inventory valuation.
// Manufactured parts store raw-material cost directly; build labor comes from each
// model's labor routing × a burdened blended rate (real payroll arrives in Phase 5).
import { all } from './db.js';

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

export async function modelRollup(modelId, rates) {
  const m = (await all('SELECT * FROM model WHERE id=$1', [modelId]))[0];
  if (!m) return null;
  if (!rates) rates = await wsRates();
  const lines = await all(
    `SELECT b.part_id, b.qty, b.stage, p.name, p.type, p.cost
       FROM bom_line b JOIN part p ON p.id=b.part_id
      WHERE b.model_id=$1 ORDER BY p.type DESC, p.id`, [modelId]);
  const labor = await all('SELECT ws, hours, rate, stage FROM model_labor WHERE model_id=$1', [modelId]);
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

export async function modelsSummary() {
  const models = await all('SELECT id FROM model ORDER BY category, id', []);
  const rates = await wsRates();
  const out = [];
  for (const r of models) out.push(await modelRollup(r.id, rates));
  return out;
}

export async function inventoryValuation() {
  const parts = await all('SELECT * FROM part', []);
  let value = 0, below = 0;
  for (const p of parts) {
    value += partUnitCost(p) * Number(p.on_hand);
    if (Number(p.on_hand) < Number(p.reorder)) below++;
  }
  return {
    totalValue: value,
    skuCount: parts.length,
    purchased: parts.filter(p => p.type === 'P').length,
    manufactured: parts.filter(p => p.type === 'M').length,
    belowReorder: below
  };
}
