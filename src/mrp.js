// Phase 3 — Predictive ordering / MRP engine.
// For every part: demand from open orders, daily consumption from production capacity,
// projected on-hand, days of coverage vs vendor lead time + safety, suggested order/build
// quantity (rounded to lot size) and the latest safe order-by date — with cushion stock.
import { all, one, q } from './db.js';
import { postBill } from './accounting.js';
import { requestApprovals } from './approvals.js';

async function grossDemand() {
  // sum of BOM qty * order qty across open (non-shipped) orders
  const rows = await all(`
    SELECT b.part_id, SUM(b.qty * o.qty) AS demand
      FROM sales_order o
      JOIN bom_line b ON b.model_id = o.model_id
     WHERE o.stage <> 'Ready' AND o.billed = false
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

// Actual lead times observed per vendor (received POs, trailing 180 days). The MRP uses the
// CONSERVATIVE effective lead — max(promised, median actual over the last receipts, once there
// are 3+) — so a chronically slow vendor makes ORDER-NOW fire earlier, never later.
export async function vendorActualLeads() {
  const rows = await all(`
    SELECT vendor_id, EXTRACT(EPOCH FROM (received_at - placed::timestamptz)) / 86400 AS days
      FROM purchase_order
     WHERE received_at IS NOT NULL AND vendor_id IS NOT NULL
       AND received_at > now() - INTERVAL '180 days'
     ORDER BY vendor_id, received_at DESC`, []).catch(() => []);
  const byVendor = {};
  for (const r of rows) (byVendor[r.vendor_id] = byVendor[r.vendor_id] || []).push(Math.max(0, Math.round(Number(r.days))));
  const out = {};
  for (const [v, arr] of Object.entries(byVendor)) {
    const last = arr.slice(0, 8).sort((a, b) => a - b);
    out[v] = { n: arr.length, median: last[Math.floor(last.length / 2)] };
  }
  return out;
}
const effectiveLead = (promised, actual) =>
  actual && actual.n >= 3 ? Math.max(promised, actual.median) : promised;

export async function mrp() {
  const [parts, demand, daily, onord, actuals] = await Promise.all([
    all(`SELECT p.*, v.name AS vendor_name, v.lead_days FROM part p LEFT JOIN vendor v ON v.id=p.vendor_id WHERE p.active = true`, []),
    grossDemand(), dailyConsumption(), onOrder(), vendorActualLeads()
  ]);
  const today = new Date();
  return parts.map(p => {
    const lead = effectiveLead(Number(p.lead_days) || 0, p.vendor_id ? actuals[p.vendor_id] : null);
    const dem = demand[p.id] || 0;
    const cons = daily[p.id] || 0.0001;
    const oo = onord[p.id] || 0;
    const proj = Number(p.on_hand) + oo - dem;
    const daysCover = cons > 0 ? Number(p.on_hand) / cons : 999;
    const reorderLevel = Number(p.reorder) + Number(p.cushion);
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

// The supplier scorecard: receipts, on-time %, promised vs actual lead days — and the effective
// lead the MRP is actually using for each vendor (with a slow flag when actuals beat promises).
export async function vendorScorecard() {
  const vendors = await all(`SELECT id, name, lead_days, status FROM vendor WHERE status <> 'rejected' ORDER BY name`, []);
  const pos = await all(`SELECT vendor_id, eta, placed, received_at FROM purchase_order
                          WHERE received_at IS NOT NULL AND vendor_id IS NOT NULL`, []).catch(() => []);
  const actuals = await vendorActualLeads();
  const agg = {};
  for (const p of pos) {
    const g = (agg[p.vendor_id] = agg[p.vendor_id] || { receipts: 0, onTime: 0, withEta: 0, leadSum: 0 });
    g.receipts++;
    g.leadSum += Math.max(0, Math.round((new Date(p.received_at) - new Date(p.placed)) / 86400000));
    if (p.eta) {
      g.withEta++;
      if (new Date(p.received_at).toISOString().slice(0, 10) <= String(p.eta).slice(0, 10)) g.onTime++;
    }
  }
  return vendors.map(v => {
    const g = agg[v.id], a = actuals[v.id];
    const promised = Number(v.lead_days) || 0;
    return { id: v.id, name: v.name, promisedLead: promised,
      receipts: g?.receipts || 0,
      onTimePct: g && g.withEta ? Math.round((g.onTime / g.withEta) * 100) : null,
      avgActualLead: g && g.receipts ? Math.round(g.leadSum / g.receipts) : null,
      medianActualLead: a?.median ?? null,
      effectiveLead: effectiveLead(promised, a),
      slow: !!(a && a.n >= 3 && a.median > promised) };
  }).sort((x, y) => y.receipts - x.receipts);
}

export async function poList() {
  const rows = await all(`SELECT po.*, v.name AS vendor_name, p.name AS part_name, p.vendor_part_no, u.name AS received_by_name
                            FROM purchase_order po LEFT JOIN vendor v ON v.id=po.vendor_id
                            LEFT JOIN part p ON p.id=po.part_id LEFT JOIN app_user u ON u.id=po.received_by
                            ORDER BY po.id DESC`, []);
  const ackRows = await all('SELECT * FROM po_ack ORDER BY id', []).catch(() => []);
  const acksBy = {};
  for (const a of ackRows) (acksBy[a.po_id] ||= []).push({
    id: a.id, ackNo: a.ack_no, qty: Number(a.qty), note: a.note, carrier: a.carrier,
    trackingNo: a.tracking_no, trackingStatus: a.tracking_status, trackingCheckedAt: a.tracking_checked_at,
  });
  return rows.map(r => ({
    id: r.id, vendor: r.vendor_name, vendorId: r.vendor_id, partId: r.part_id, part: r.part_name,
    vendorPartNo: r.vendor_part_no || null,
    qty: r.qty, unit: Number(r.unit_cost), total: r.qty * Number(r.unit_cost),
    placed: r.placed, eta: r.eta, status: r.status,
    acks: acksBy[r.id] || [], ackQty: (acksBy[r.id] || []).reduce((s, a) => s + a.qty, 0),
    unfulfilledQty: Number(r.unfulfilled_qty) || 0,
    receivedAt: r.received_at || null, receivedBy: r.received_by_name || null,
    // The carrier's claim, not the fact: true when any ack's tracking says delivered while
    // the PO is still Open — i.e. "it should be on the dock, go confirm and receive it."
    arrivedPerCarrier: r.status === 'Open' && (acksBy[r.id] || []).some(a => /deliver/i.test(a.trackingStatus || '')),
  }));
}

// ---- vendor order acknowledgements + PO edits/cancellations -------------------------------
// One PO may take several acknowledgements (a vendor rarely confirms everything at once);
// what they can't fulfill is either edited off the PO or cancelled as unfulfilled.
export async function addAck(poId, { ackNo, qty, carrier, trackingNo, note }, userId) {
  const po = await one('SELECT * FROM purchase_order WHERE id=$1', [poId]);
  if (!po) throw new Error('PO not found.');
  if (po.status !== 'Open') throw new Error(`${poId} is ${po.status} — acknowledgements apply to Open POs.`);
  const n = String(ackNo || '').trim();
  if (!n) throw new Error('Enter the vendor\'s order acknowledgement number.');
  const q2 = Number(qty);
  if (!Number.isFinite(q2) || q2 <= 0) throw new Error('Acknowledged quantity must be greater than zero.');
  const acked = Number((await one('SELECT COALESCE(SUM(qty),0) AS s FROM po_ack WHERE po_id=$1', [poId])).s);
  if (acked + q2 > Number(po.qty)) throw new Error(`Acknowledgements would cover ${acked + q2} of ${Number(po.qty)} ordered — reduce the quantity.`);
  const r = await one(
    `INSERT INTO po_ack(po_id, ack_no, qty, note, carrier, tracking_no, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [poId, n, q2, String(note || '').trim() || null, String(carrier || '').trim() || null,
     String(trackingNo || '').trim() || null, userId || null]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'po.ack', `${poId} ack ${n}: ${q2} of ${Number(po.qty)}${trackingNo ? ` — ${carrier || ''} ${trackingNo}` : ''}`]).catch(() => {});
  return { id: r.id, ackNo: n, qty: q2, acked: acked + q2, of: Number(po.qty) };
}

export async function editPOQty(poId, qty, userId) {
  const po = await one('SELECT * FROM purchase_order WHERE id=$1', [poId]);
  if (!po) throw new Error('PO not found.');
  if (po.status !== 'Open') throw new Error(`${poId} is ${po.status} — only Open POs can be edited.`);
  const q2 = Number(qty);
  if (!Number.isFinite(q2) || q2 <= 0) throw new Error('Quantity must be greater than zero (cancel the PO to drop it entirely).');
  const acked = Number((await one('SELECT COALESCE(SUM(qty),0) AS s FROM po_ack WHERE po_id=$1', [poId])).s);
  if (q2 < acked) throw new Error(`The vendor has already acknowledged ${acked} — the PO can't drop below that.`);
  await q('UPDATE purchase_order SET qty=$1 WHERE id=$2', [q2, poId]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'po.edit', `${poId} qty ${Number(po.qty)} → ${q2} (vendor can't fulfill the difference)`]).catch(() => {});
  return { ok: true, qty: q2 };
}

// Cancel as unfulfilled — the whole PO, or just the part of it the vendor is out of stock on.
export async function cancelPO(poId, { qty, reason } = {}, userId) {
  const po = await one('SELECT * FROM purchase_order WHERE id=$1', [poId]);
  if (!po) throw new Error('PO not found.');
  if (!['Open', 'Pending Approval'].includes(po.status)) throw new Error(`${poId} is ${po.status} — nothing to cancel.`);
  const why = String(reason || '').trim() || 'unfulfilled by vendor';
  const part = Number(qty);
  if (qty != null && Number.isFinite(part) && part > 0 && part < Number(po.qty)) {
    const acked = Number((await one('SELECT COALESCE(SUM(qty),0) AS s FROM po_ack WHERE po_id=$1', [poId])).s);
    if (Number(po.qty) - part < acked) throw new Error(`The vendor has already acknowledged ${acked} — cancel at most ${Number(po.qty) - acked}.`);
    await q('UPDATE purchase_order SET qty = qty - $1, unfulfilled_qty = unfulfilled_qty + $1, cancel_reason=$2 WHERE id=$3', [part, why, poId]);
    await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
      [userId || null, 'po.cancel', `${poId}: ${part} of ${Number(po.qty)} cancelled as unfulfilled — ${why}`]).catch(() => {});
    return { ok: true, partial: true, remainingQty: Number(po.qty) - part };
  }
  await q(`UPDATE purchase_order SET status='Cancelled', unfulfilled_qty = unfulfilled_qty + qty, cancel_reason=$1 WHERE id=$2`, [why, poId]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'po.cancel', `${poId} cancelled in full as unfulfilled — ${why}`]).catch(() => {});
  return { ok: true, partial: false, status: 'Cancelled' };
}

// vendorId (optional) buys this lot from an ALTERNATE vendor: the part keeps its primary
// vendor (which drives MRP timing), while this PO — and the receipts feeding the supplier
// scorecard and actual-lead medians — belong to whoever was actually used.
export async function createPO(partId, qty, userId, vendorId) {
  const p = await one('SELECT * FROM part WHERE id=$1', [partId]);
  if (!p) throw new Error('part not found');
  const v = await one('SELECT * FROM vendor WHERE id=$1', [vendorId || p.vendor_id]);
  if (vendorId && !v) throw new Error('vendor not found');
  if (v && v.status === 'pending') throw new Error(`Vendor "${v.name}" is pending approval — cannot place a PO yet`);
  if (v && v.status === 'rejected') throw new Error(`Vendor "${v.name}" was rejected — pick another vendor.`);
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
    [id, v ? v.id : p.vendor_id, partId, qty, p.cost, eta.toISOString().slice(0, 10), status, userId || null]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [userId || null, 'po.create', `${id} ${partId} x${qty} → ${status}`]);
  return { id, status, approvalCount: requests.length };
}

// Receive one VENDOR INVOICE covering one or more POs, with landed-cost allocation:
// shipping / sales tax / other charges spread across the lines proportionally to line value
// (the last line absorbs rounding so the shares sum exactly). Each part's cost becomes a
// weighted average of existing stock and the FULLY LANDED unit cost of this receipt, and ONE
// bill posts for the invoice bottom line — so the books match the paper to the penny.
export async function receiveInvoice({ vendorId, invoiceNo, invoiceDate, poIds, shipping, tax, other, otherLabel, expensed, expensedLabel }, userId) {
  const cents = x => Math.round((Number(x) || 0) * 100) / 100;
  const ids = [...new Set((Array.isArray(poIds) ? poIds : []).filter(Boolean))];
  if (!ids.length) throw new Error('Pick at least one PO covered by this invoice.');
  const v = await one('SELECT * FROM vendor WHERE id=$1', [vendorId]);
  if (!v) throw new Error('Vendor not found.');
  const pos = [];
  for (const id of ids) {
    const po = await one('SELECT * FROM purchase_order WHERE id=$1', [id]);
    if (!po) throw new Error(`${id} not found.`);
    if (po.vendor_id !== vendorId) throw new Error(`${id} belongs to a different vendor.`);
    if (po.status === 'Received') throw new Error(`${id} is already received.`);
    if (po.status !== 'Open') throw new Error(`${id} is ${po.status} — only Open POs can be received.`);
    pos.push(po);
  }
  const ship = cents(shipping), taxAmt = cents(tax), oth = cents(other), exp = cents(expensed);
  if (ship < 0 || taxAmt < 0 || oth < 0 || exp < 0) throw new Error('Shipping, tax, other, and expensed charges cannot be negative.');
  // Expendable lines are billed but never stocked — and they don't absorb landed cost, so the
  // allocation basis is the NON-expendable line value only.
  const flags = {};
  for (const po of pos) flags[po.part_id] = (await one('SELECT expendable FROM part WHERE id=$1', [po.part_id]))?.expendable === true;
  const lineVal = po => Number(po.qty) * Number(po.unit_cost);
  const partsTotal = cents(pos.reduce((a, po) => a + lineVal(po), 0));
  const basis = cents(pos.reduce((a, po) => a + (flags[po.part_id] ? 0 : lineVal(po)), 0));
  const extras = cents(ship + taxAmt + oth);
  if (extras > 0 && basis <= 0) throw new Error('Every line is expendable (nothing lands into item costs) — enter freight/tax under Expensed charges instead.');
  // Expensed charges (e.g. an expedite fee) ride the bill so QuickBooks pays the exact invoice,
  // but they are a period expense — standard part costs never move because of them.
  const total = cents(partsTotal + extras + exp);

  const invId = 'VI-' + Date.now().toString(36).toUpperCase();
  let allocated = 0;
  const lines = [];
  const lastAllocIdx = pos.reduce((last, po, i) => flags[po.part_id] ? last : i, -1);
  for (let i = 0; i < pos.length; i++) {
    const po = pos[i];
    const lineValue = lineVal(po);
    if (flags[po.part_id]) {
      // Expendable: billed, marked received, never stocked, never landed.
      await q(`UPDATE purchase_order SET status='Received', received_at=now(), received_by=$3, invoice_id=$1, landed_extra=0 WHERE id=$2`, [invId, po.id, userId || null]);
      await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
        [userId || null, 'po.receive', `${po.id}: ${po.qty} ${po.part_id} expendable — billed $${cents(lineValue)}, not stocked`]);
      lines.push({ poId: po.id, partId: po.part_id, qty: Number(po.qty), share: 0, landedUnit: cents(lineValue / Number(po.qty)), newCost: null, expendable: true });
      continue;
    }
    const share = i === lastAllocIdx ? cents(extras - allocated) : cents(extras * (basis > 0 ? lineValue / basis : 0));
    allocated = cents(allocated + share);
    const landedUnit = (lineValue + share) / Number(po.qty);
    const part = await one('SELECT on_hand, cost FROM part WHERE id=$1', [po.part_id]);
    const prevQty = Math.max(0, Number(part?.on_hand) || 0); // negative stock can't drag the average
    const prevCost = Number(part?.cost) || 0;
    const newCost = cents((prevQty * prevCost + Number(po.qty) * landedUnit) / (prevQty + Number(po.qty)));
    await q('UPDATE part SET on_hand = on_hand + $1, cost = $2 WHERE id=$3', [po.qty, newCost, po.part_id]);
    await q(`UPDATE purchase_order SET status='Received', received_at=now(), received_by=$4, invoice_id=$1, landed_extra=$2 WHERE id=$3`,
      [invId, share, po.id, userId || null]);
    await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
      [userId || null, 'po.receive', `${po.id}: +${po.qty} ${po.part_id} landed $${cents(landedUnit)}/ea (+$${share} allocated) — cost ${prevCost} -> ${newCost}`]);
    lines.push({ poId: po.id, partId: po.part_id, qty: Number(po.qty), share, landedUnit: cents(landedUnit), newCost });
  }
  await q(`INSERT INTO vendor_invoice(id,vendor_id,number,invoice_date,total,lines,status,created_by,shipping,tax,other,other_label,parts_total,expensed,expensed_label)
           VALUES ($1,$2,$3,$4,$5,$6,'Applied',$7,$8,$9,$10,$11,$12,$13,$14)`,
    [invId, vendorId, String(invoiceNo || '').trim() || invId, invoiceDate || new Date().toISOString().slice(0, 10),
     total, pos.length, userId || null, ship, taxAmt, oth, String(otherLabel || '').trim() || null, partsTotal,
     exp, String(expensedLabel || '').trim() || null]);
  // One bill for the whole invoice — DocNumber carries the vendor's real invoice number so
  // reconciling against QuickBooks is a straight match. (receivePO's per-PO bill is skipped.)
  await postBill(String(invoiceNo || '').trim() || invId, v.name, total, userId);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'invoice.receive', `${invId} ${v.name} #${invoiceNo || '—'}: parts $${partsTotal} + ship $${ship} + tax $${taxAmt} + other $${oth}${exp ? ` + expensed $${exp} (${String(expensedLabel || '').trim() || 'period expense'})` : ''} = $${total} (${pos.length} PO(s))`]);
  return { id: invId, total, partsTotal, extras, expensed: exp, lines };
}

export async function receivePO(poId, userId) {
  const po = await one('SELECT * FROM purchase_order WHERE id=$1', [poId]);
  if (!po || po.status === 'Received') return false;
  if (po.status === 'Pending Approval') throw new Error('PO is pending approval — cannot receive until approved');
  if (po.status === 'Rejected') throw new Error('PO was rejected');
  if (po.status === 'Cancelled') throw new Error('PO was cancelled as unfulfilled — nothing to receive.');
  const expFlag = (await one('SELECT expendable FROM part WHERE id=$1', [po.part_id]))?.expendable === true;
  if (!expFlag) await q('UPDATE part SET on_hand = on_hand + $1 WHERE id=$2', [po.qty, po.part_id]);
  await q("UPDATE purchase_order SET status='Received', received_at=now(), received_by=$2 WHERE id=$1", [poId, userId || null]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [userId || null, 'po.receive', `${poId}: ${expFlag ? po.qty + ' ' + po.part_id + ' expendable — billed, not stocked' : '+' + po.qty + ' ' + po.part_id}`]);
  // Phase 4: post a vendor bill to accounting on receipt
  const v = await one('SELECT name FROM vendor WHERE id=$1', [po.vendor_id]);
  await postBill(poId, v ? v.name : 'Vendor', po.qty * Number(po.unit_cost), userId);
  return true;
}
