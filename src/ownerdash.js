// Owner dashboard — "is the business healthy", not "is today's production on track".
// Everything reads FROZEN transaction values (effective dating): posted invoices/bills/COGS
// from the ledger, frozen order prices, stage stamps — so trends never rewrite themselves.
import { all, one, q } from './db.js';
import { inventoryValuation } from './cost.js';

const num = v => Math.round(Number(v || 0) * 100) / 100;

// Cash THROUGH THE BOOKS: what the app has billed vs the vendor bills it has posted, plus
// the receivable still open on invoice batches. (Payments live in QuickBooks; this is the
// app-side pulse, labeled as such in the UI.)
async function cashPosition() {
  const t = await all(`SELECT kind, COALESCE(SUM(amount),0) AS amt FROM accounting_event
                        WHERE kind IN ('invoice','bill') GROUP BY kind`, []);
  const invoiced = num(t.find(x => x.kind === 'invoice')?.amt);
  const bills = num(t.find(x => x.kind === 'bill')?.amt);
  const ar = await one(`SELECT COALESCE(SUM(total),0) AS owed FROM invoice_batch WHERE status='Invoiced'`, []).catch(() => null);
  return { invoiced, bills, net: num(invoiced - bills), batchAR: num(ar?.owed) };
}

// Gross margin from POSTED transactions: each invoiced order's revenue (its own frozen
// invoice amount) minus its posted COGS relief — company-wide and by model.
async function grossMargin() {
  const rows = await all(`
    SELECT o.model_id, m.name AS model,
           SUM(CASE WHEN e.kind='invoice' THEN e.amount ELSE 0 END) AS revenue,
           SUM(CASE WHEN e.kind='cogs' THEN e.amount ELSE 0 END) AS cogs
      FROM accounting_event e
      JOIN sales_order o ON o.id = e.ref
      LEFT JOIN model m ON m.id = o.model_id
     WHERE e.kind IN ('invoice','cogs')
     GROUP BY o.model_id, m.name`, []).catch(() => []);
  const byModel = rows.map(r => {
    const rev = num(r.revenue), cogs = num(r.cogs), gm = num(rev - cogs);
    return { modelId: r.model_id, model: r.model || r.model_id, revenue: rev, cogs, margin: gm,
      marginPct: rev > 0 ? Math.round((gm / rev) * 1000) / 10 : null };
  }).filter(r => r.revenue > 0 || r.cogs > 0).sort((a, b) => b.revenue - a.revenue);
  const revenue = num(byModel.reduce((s, r) => s + r.revenue, 0));
  const cogs = num(byModel.reduce((s, r) => s + r.cogs, 0));
  return { revenue, cogs, margin: num(revenue - cogs),
    marginPct: revenue > 0 ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : null, byModel };
}

// 12 weekly buckets (oldest first): units reaching Ready, and on-time % of dated orders.
// Arrival at Ready = the 'Finish' completion stamp (order_stage_done records the stage LEFT).
async function weeklyTrends() {
  const rows = await all(`
    SELECT d.completed_at, o.qty, o.due
      FROM order_stage_done d JOIN sales_order o ON o.id = d.order_id
     WHERE d.stage = 'Finish' AND d.completed_at > now() - INTERVAL '84 days'`, []).catch(() => []);
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const end = new Date(Date.now() - i * 7 * 864e5);
    const start = new Date(end.getTime() - 7 * 864e5);
    const inWeek = rows.filter(r => { const t = new Date(r.completed_at); return t > start && t <= end; });
    const dated = inWeek.filter(r => r.due);
    const onTime = dated.filter(r => new Date(r.completed_at).toISOString().slice(0, 10) <= String(r.due).slice(0, 10));
    weeks.push({
      weekOf: start.toISOString().slice(0, 10),
      units: inWeek.reduce((s, r) => s + Number(r.qty || 1), 0),
      onTimePct: dated.length ? Math.round((onTime.length / dated.length) * 100) : null,
    });
  }
  return weeks;
}

// Warranty cost per month, trailing 6 months (opened date; parts + labor + shipping).
async function warrantyTrend() {
  return (await all(`
    SELECT to_char(wc.opened_at, 'YYYY-MM') AS month,
           COUNT(DISTINCT wc.id)::int AS claims,
           COALESCE(SUM(wc.labor_cost + wc.shipping_cost), 0)
             + COALESCE((SELECT SUM(p.qty * p.unit_cost) FROM warranty_claim_part p
                          WHERE p.claim_id IN (SELECT id FROM warranty_claim
                            WHERE to_char(opened_at,'YYYY-MM') = to_char(wc.opened_at,'YYYY-MM'))), 0) AS cost
      FROM warranty_claim wc
     WHERE wc.opened_at > now() - INTERVAL '6 months'
     GROUP BY 1 ORDER BY 1`, []).catch(() => []))
    .map(r => ({ month: r.month, claims: Number(r.claims), cost: num(r.cost) }));
}

// Inventory turns: trailing-90-day COGS annualized ÷ current inventory value.
async function inventoryTurns() {
  const cogs90 = await one(`SELECT COALESCE(SUM(amount),0) AS amt FROM accounting_event
                             WHERE kind='cogs' AND ts > now() - INTERVAL '90 days'`, []).catch(() => null);
  const inv = await inventoryValuation().catch(() => null);
  const value = Number(inv?.totalValue || 0);
  const annualized = Number(cogs90?.amt || 0) * (365 / 90);
  return { turns: value > 0 ? Math.round((annualized / value) * 10) / 10 : null,
    annualizedCOGS: num(annualized), inventoryValue: num(value) };
}

// ---- Safety log (SOP-SM-010) ----
export async function safetyList() {
  const items = (await all(`SELECT s.*, u.name AS logged_by_name, r.name AS resolved_by_name
                              FROM safety_log s LEFT JOIN app_user u ON u.id=s.logged_by
                              LEFT JOIN app_user r ON r.id=s.resolved_by
                             ORDER BY s.created_at DESC LIMIT 100`, []).catch(() => []))
    .map(s => ({ id: s.id, kind: s.kind, description: s.description, occurredOn: s.occurred_on,
      loggedBy: s.logged_by_name, at: s.created_at,
      resolved: !!s.resolved_at, resolvedBy: s.resolved_by_name, resolvedAt: s.resolved_at, resolution: s.resolution }));
  const openFindings = items.filter(i => i.kind === 'finding' && !i.resolved).length;
  const lastIncident = items.filter(i => i.kind === 'incident')
    .sort((a, b) => new Date(b.occurredOn) - new Date(a.occurredOn))[0];
  const daysSinceIncident = lastIncident
    ? Math.max(0, Math.floor((Date.now() - new Date(lastIncident.occurredOn).getTime()) / 864e5))
    : null; // null = no incident on record
  return { openFindings, daysSinceIncident, items };
}
export async function safetyAdd({ kind, description, occurredOn }, user) {
  const k = kind === 'incident' ? 'incident' : 'finding';
  const d = String(description || '').trim();
  if (d.length < 3) throw new Error('Describe the finding/incident.');
  const row = await one(`INSERT INTO safety_log(kind, description, occurred_on, logged_by)
                          VALUES($1,$2,COALESCE($3, CURRENT_DATE),$4) RETURNING id`,
    [k, d.slice(0, 500), occurredOn || null, user?.id || null]);
  return { id: row.id, kind: k };
}
export async function safetyResolve(id, resolution, user) {
  const cur = await one('SELECT id, resolved_at FROM safety_log WHERE id=$1', [id]);
  if (!cur) throw new Error('Safety item not found.');
  if (cur.resolved_at) throw new Error('Already resolved.');
  await q(`UPDATE safety_log SET resolved_at=now(), resolved_by=$1, resolution=$2 WHERE id=$3`,
    [user?.id || null, String(resolution || '').trim() || null, id]);
  return { ok: true };
}

// The whole page in one call.
export async function ownerDashboard() {
  const [cash, margin, weeks, warranty, turns, safety] = await Promise.all([
    cashPosition(), grossMargin(), weeklyTrends(), warrantyTrend(), inventoryTurns(), safetyList(),
  ]);
  return { cash, margin, weeks, warranty, turns,
    safety: { openFindings: safety.openFindings, daysSinceIncident: safety.daysSinceIncident,
      open: safety.items.filter(i => !i.resolved).slice(0, 10) } };
}
