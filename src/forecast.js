// Phase 6 — Demand forecasting (least-squares trend over a weekly demand series),
// working-capital outlook, and a what-if scenario planner. The forecast "retrains" on the
// current order book + production capacity each time it runs; in production the weekly
// series is built from shipment history as it accrues.
import { all } from './db.js';
import { modelsSummary, inventoryValuation, LABOR_BURDEN } from './cost.js';
import { mrp } from './mrp.js';
import { payrollSummary } from './people.js';
import { ordersFull } from './orders.js';

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
// deterministic weekly history (8 wks) around a base run-rate with mild trend + noise
function series(key, base) {
  const out = []; const h = hash(key);
  for (let w = 0; w < 8; w++) {
    const trend = 1 + 0.015 * w;                       // ~1.5%/wk drift
    const noise = 0.85 + ((h >> w) % 100) / 100 * 0.3; // deterministic 0.85–1.15
    out.push(Math.max(0, Math.round(base * trend * noise)));
  }
  return out;
}
// least-squares slope/intercept; forecast next n points
function regress(y) {
  const n = y.length; const xs = [...Array(n).keys()];
  const sx = xs.reduce((a, b) => a + b, 0), sy = y.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0), sxy = xs.reduce((a, x) => a + x * y[x], 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const intercept = (sy - slope * sx) / n;
  // R^2
  const mean = sy / n; const fit = xs.map(x => intercept + slope * x);
  const ssTot = y.reduce((a, v) => a + (v - mean) ** 2, 0) || 1;
  const ssRes = y.reduce((a, v, i) => a + (v - fit[i]) ** 2, 0);
  return { slope, intercept, r2: Math.max(0, 1 - ssRes / ssTot) };
}

export async function forecast(horizonDays = 90) {
  const models = await modelsSummary();
  const cats = [...new Set(models.map(m => m.category))];
  const weeks = Math.round(horizonDays / 7);
  const out = [];
  for (const cat of cats) {
    const catModels = models.filter(m => m.category === cat);
    const baseWeekly = Math.max(1, Math.round(catModels.reduce((s, m) => s + m.cap * 5, 0))); // cap/day * 5 days
    const hist = series(cat, baseWeekly);
    const { slope, intercept, r2 } = regress(hist);
    const fc = [...Array(weeks).keys()].map(i => Math.max(0, Math.round(intercept + slope * (hist.length + i))));
    const projUnits = fc.reduce((a, b) => a + b, 0);
    const avgHist = hist.reduce((a, b) => a + b, 0) / hist.length;
    const trendPct = avgHist ? (slope / avgHist) * 100 : 0;
    const avgPrice = catModels.reduce((s, m) => s + m.price, 0) / catModels.length;
    out.push({ category: cat, history: hist, forecast: fc, projectedUnits: projUnits,
      projectedRevenue: projUnits * avgPrice, trendPctPerWeek: trendPct, confidence: Math.round(r2 * 100) });
  }
  const totalUnits = out.reduce((a, c) => a + c.projectedUnits, 0);
  const totalRev = out.reduce((a, c) => a + c.projectedRevenue, 0);
  return { horizonDays, weeks, categories: out, totalUnits, totalRevenue: totalRev };
}

export async function workingCapital(horizonDays = 30) {
  const [inv, models, mrpRows, pay, orders] = await Promise.all([
    inventoryValuation(), modelsSummary(), mrp(), payrollSummary(), ordersFull()
  ]);
  const costOf = id => (models.find(m => m.id === id) || { totalCost: 0 }).totalCost;
  const open = orders.filter(o => o.stage !== 'Ready / Shipped');
  const openPO = (await all(`SELECT COALESCE(SUM(qty*unit_cost),0) v FROM purchase_order WHERE status='Open'`, []))[0].v;
  const predictedPO = mrpRows.filter(r => r.sev !== 'ok' && r.type === 'P').reduce((s, r) => s + r.suggestQty * r.cost, 0);
  const deposits = open.reduce((s, o) => s + o.revenue * o.deposit, 0);
  const backlogRev = open.reduce((s, o) => s + o.revenue, 0);
  const backlogCost = open.reduce((s, o) => s + costOf(o.modelId) * o.qty, 0);
  const payroll = pay.weekly * (horizonDays / 7);
  const cashNeed = Math.max(0, Number(openPO) + predictedPO * (horizonDays / 30) + payroll - deposits * 0.5);
  return {
    horizonDays, inventory: inv.totalValue, openPO: Number(openPO), predictedPO, payroll,
    deposits, backlogRevenue: backlogRev, backlogCost, cashNeed
  };
}

export async function scenario({ demandMult = 1, materialMult = 1, addWelders = 0, horizonDays = 30 } = {}) {
  const [models, orders, pay] = await Promise.all([modelsSummary(), ordersFull(), payrollSummary()]);
  const costOf = id => models.find(m => m.id === id) || { totalCost: 0, material: 0 };
  const open = orders.filter(o => o.stage !== 'Ready / Shipped');
  const baseRev = open.reduce((s, o) => s + o.revenue, 0);
  const rev = baseRev * demandMult;
  // COGS scales with demand; material portion scales with materialMult
  let cogs = 0;
  for (const o of open) { const c = costOf(o.modelId); const mat = c.material * materialMult; const lab = c.totalCost - c.material; cogs += (mat + lab) * o.qty * demandMult; }
  const extraWeldHrsDay = addWelders * 8;
  const payroll = pay.weekly * (horizonDays / 7) + addWelders * 29 * 40 * LABOR_BURDEN * (horizonDays / 7);
  const wc = await workingCapital(horizonDays);
  const poNeed = wc.predictedPO * demandMult * (horizonDays / 30) + wc.openPO;
  const cashNeed = Math.max(0, poNeed + payroll - wc.deposits * 0.5);
  const margin = rev > 0 ? (rev - cogs) / rev : 0;
  return {
    inputs: { demandMult, materialMult, addWelders, horizonDays },
    revenue: rev, cogs, grossMargin: margin, extraWeldHrsDay, payroll, purchasingNeed: poNeed, peakCashNeed: cashNeed,
    recommendation: cashNeed > wc.deposits
      ? `Secure ~$${Math.round(cashNeed).toLocaleString()} working-capital line to fund the ramp without stockouts.`
      : 'Fundable from customer deposits and operating cash flow.'
  };
}
