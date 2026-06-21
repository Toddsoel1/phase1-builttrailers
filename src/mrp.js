// Phase 3 — Predictive ordering / MRP engine.
// For every part: demand from open orders, daily consumption from production capacity,
// projected on-hand, days of coverage vs vendor lead time + safety, suggested order/build
// quantity (rounded to lot size) and the latest safe order-by date — with cushion stock.
import { all, one, q } from './db.js';
import { postBill } from './accounting.js';
import { requestApprovals } from './approvals.js';

const SAFETY_DAYS = 3;

async function grossDemand() {
  // sum of BOM qty * order qty across open (non-shipped) orders
  const rows = await all(`
    SELECT b.part_id, SUM(b.qty * o.qty) AS demand
      FROM sales_order o
      JOIN bom_line b ON b.model_id = o.model_id
     WHERE o.stage <> 'Ready / Shipped'
     GROUP BY b.part_id`, []);
  const d = {}; rows.forEach(r => d[r.part_id] = Number(r.demand)); return d;
}

async function dailyConsumption() {
  // per-model daily capacity * BOM qty, summed per part
  const rows = await all(`
    SELECT b.part_id, SUM(b.qty * m.cap) AS daily
      FROM model m JOIN bom_line b ON b.model_id = m.id
     GROUP BY b.part_id`, []);
  const c = {}; rows.forEach(r => c[r.part_id] = Number(r.daily)); return c;
}

async function onOrder() {
  const rows = await all(`SELECT part_id, SUM(qty) AS q FROM purchase_order WHERE status='Open' GROUP BY part_id`, []);
  const o = {}; rows.forEach(r => o[r.part_id] = Number(r.q)); return o;
}

export async function mrp() {
  const [parts, demand, daily, onord] = await Promise.all([
    all(`SELECT p.*, v.name AS vendor_name, v.lead_days FROM part p LEFT JOIN vendor v ON v.id=p.vendor_id`, []),
    grossDemand(), dailyConsumption(), onOrder()
  ]);
  const today = new Date();
  return parts.map(p => {
    const lead = Number(p.lead_days) || 0;
    const dem = demand[p.id] || 0;
    const cons = daily[p.id] || 0.0001;
    const oo = onord[p.id] || 0;
    const proj = Number(p.on_hand) + oo - dem;
    const daysCover = cons > 0 ? Number(p.on_hand) / cons : 999;
    const reorderLevel = Number(p.reorder) + Number(p.cushion);
    const leadCushion = lead + SAFETY_DAYS;
    let action = 'OK', sev = 'ok', suggestQty = 0, orderBy = '';
    const isMake = p.type === 'M';
    // Shortage is measured on PROJECTED on-hand (current + already on order − demand),
    // so a part that's already covered by an open PO won't be re-recommended.
    const needToLevel = reorderLevel + cons * lead; // refill past reorder+cushion and cover the lead window
    if (proj < reorderLevel) {
      suggestQty = Math.max(Number(p.lot), Math.ceil((needToLevel - proj) / Number(p.lot)) * Number(p.lot));
      const orderByDays = Math.max(0, Math.floor(daysCover - lead));
      const ob = new Date(today); ob.setDate(ob.getDate() + orderByDays); orderBy = ob.toISOString().slice(0, 10);
      if (proj < Number(p.cushion) || daysCover < lead) { action = isMake ? 'BUILD NOW' : 'ORDER NOW'; sev = 'crit'; }
      else { action = isMake ? 'SCHEDULE BUILD' : 'REORDER SOON'; sev = 'warn'; }
    }
    return {
      id: p.id, name: p.name, type: p.type, vendor: p.vendor_name, vendorId: p.vendor_id,
      lead, onHand: Number(p.on_hand), onOrder: oo, demand: dem,
      proj, daysCover: daysCover >= 999 ? null : Math.floor(daysCover),
      reorderLevel, cost: Number(p.cost), action, sev, suggestQty, orderBy
    };
  });
}

export async function poList() {
  const rows = await all(`SELECT po.*, v.name AS vendor_name, p.name AS part_name
                            FROM purchase_order po LEFT JOIN vendor v ON v.id=po.vendor_id
                            LEFT JOIN part p ON p.id=po.part_id ORDER BY po.id DESC`, []);
  return rows.map(r => ({
    id: r.id, vendor: r.vendor_name, vendorId: r.vendor_id, partId: r.part_id, part: r.part_name,
    qty: r.qty, unit: Number(r.unit_cost), total: r.qty * Number(r.unit_cost),
    placed: r.placed, eta: r.eta, status: r.status
  }));
}

export async function createPO(partId, qty, userId) {
  const p = await one('SELECT * FROM part WHERE id=$1', [partId]);
  if (!p) throw new Error('part not found');
  const v = await one('SELECT * FROM vendor WHERE id=$1', [p.vendor_id]);
  if (v && v.status === 'pending') throw new Error(`Vendor "${v.name}" is pending approval — cannot place a PO yet`);
  const n = (await all('SELECT id FROM purchase_order', [])).length;
  const id = 'PO-' + (3303 + n);
  const eta = new Date(); eta.setDate(eta.getDate() + (Number(v?.lead_days) || 7));
  const total = qty * Number(p.cost);
  const desc = `${id}: ${qty}× ${p.name} from ${v?.name || 'vendor'} ($${total.toFixed(2)})`;

  // Determine initial status — 'Pending Approval' if any rule matches, else 'Open'
  const requests = await requestApprovals('po', id, total, desc, userId);
  const status = requests.length ? 'Pending Approval' : 'Open';

  await q(`INSERT INTO purchase_order(id,vendor_id,part_id,qty,unit_cost,placed,eta,status,created_by)
           VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,$8)`,
    [id, p.vendor_id, partId, qty, p.cost, eta.toISOString().slice(0, 10), status, userId || null]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [userId || null, 'po.create', `${id} ${partId} x${qty} → ${status}`]);
  return { id, status, approvalCount: requests.length };
}

export async function receivePO(poId, userId) {
  const po = await one('SELECT * FROM purchase_order WHERE id=$1', [poId]);
  if (!po || po.status === 'Received') return false;
  if (po.status === 'Pending Approval') throw new Error('PO is pending approval — cannot receive until approved');
  if (po.status === 'Rejected') throw new Error('PO was rejected');
  await q('UPDATE part SET on_hand = on_hand + $1 WHERE id=$2', [po.qty, po.part_id]);
  await q("UPDATE purchase_order SET status='Received' WHERE id=$1", [poId]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [userId || null, 'po.receive', `${poId}: +${po.qty} ${po.part_id}`]);
  // Phase 4: post a vendor bill to accounting on receipt
  const v = await one('SELECT name FROM vendor WHERE id=$1', [po.vendor_id]);
  await postBill(poId, v ? v.name : 'Vendor', po.qty * Number(po.unit_cost), userId);
  return true;
}
