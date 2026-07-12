// 🔩 Dealer parts channel — the aftermarket catalog and ordering system for dealerships:
//   • Lookup by VIN (the exact parts on THAT trailer — base BOM + the unit's configured
//     deltas), or by part number / description / build stage. Pre-app VINs fall back to the
//     current parts for the same trailer model (decoded from Built's own 7XJ VIN scheme when
//     possible, otherwise the dealer picks the model).
//   • Standard aftermarket pricing derives from the parts master, so it populates the moment
//     BOMs and part costs are real: dealer cost = 50% margin + an additional 25% margin;
//     MSRP = 50% margin over dealer cost; MAP = 40% margin over dealer cost. Dealers see
//     dealer / MSRP / MAP — never Built's cost.
//   • Orders flow received → fulfilled → ready → picked up / shipped. Fulfillment relieves
//     stock and parks the value in the "Dealer fulfillment" inventory bucket; completion
//     auto-invoices (+ COGS) and the bucket empties — off the inventory reports.
// Effective dating: dealer unit prices freeze at submission; unit costs freeze at fulfillment.
import { all, one, q } from './db.js';
import { postInvoice, postCOGS } from './accounting.js';

const r2 = n => Math.round(Number(n) * 100) / 100;
// Margins are fractions OF PRICE (the same convention as model margins elsewhere in the app):
// price at margin m = cost / (1 - m).
const AFTERMARKET_MARGIN = 0.50; // Built's base aftermarket margin
const DEALER_ADDL_MARGIN = 0.25; // stacked on top → the dealer's cost
const MSRP_MARGIN = 0.50;        // dealer's retail margin at MSRP
const MAP_MARGIN = 0.40;         // minimum advertised price margin

export function partPricing(cost) {
  const dealerPrice = r2((Number(cost) || 0) / (1 - AFTERMARKET_MARGIN) / (1 - DEALER_ADDL_MARGIN));
  return { dealerPrice, msrp: r2(dealerPrice / (1 - MSRP_MARGIN)), map: r2(dealerPrice / (1 - MAP_MARGIN)) };
}

// Cost 0 = pricing not yet populated: the catalog says "Call for price" instead of quoting $0,
// and the part can't be ordered until Built publishes a cost.
const priced = p => {
  const base = { partId: p.part_id || p.id, name: p.name, uom: p.uom || 'EA',
    stage: p.stage || null, qty: p.qty != null ? Number(p.qty) : null };
  if (!(Number(p.cost) > 0)) return { ...base, unpriced: true, dealerPrice: null, msrp: null, map: null };
  return { ...base, ...partPricing(p.cost) };
};

// Flag which unpriced lines this dealership has already asked about.
export async function annotateRequested(lines, customerId) {
  if (!customerId || !Array.isArray(lines) || !lines.some(l => l.unpriced)) return lines;
  const open = new Set((await all(`SELECT part_id FROM price_request WHERE customer_id=$1 AND status='open'`, [customerId])).map(r => r.part_id));
  for (const l of lines) if (l.unpriced) l.priceRequested = open.has(l.partId);
  return lines;
}

export async function requestPrice(d, partId, note) {
  if (!d.customer_id) throw new Error('Your account is not linked to a dealer record yet — contact Built Trailers.');
  const p = await one('SELECT id, cost, active FROM part WHERE id=$1', [String(partId || '').trim()]);
  if (!p || p.active === false) throw new Error('Part not found in the catalog.');
  if (Number(p.cost) > 0) throw new Error('This part is already priced — refresh the catalog.');
  if (await one(`SELECT id FROM price_request WHERE part_id=$1 AND customer_id=$2 AND status='open'`, [p.id, d.customer_id]))
    throw new Error('You already have a price request in for this part — Built Trailers is on it.');
  await q('INSERT INTO price_request(part_id, customer_id, dealer_user_id, note) VALUES ($1,$2,$3,$4)',
    [p.id, d.customer_id, d.id || null, String(note || '').trim() || null]);
  return { ok: true, requested: true };
}

export async function listPriceRequests() {
  return (await all(
    `SELECT r.id, r.part_id, r.note, r.created_at, c.name AS dealership, p.name AS part_name, p.cost
       FROM price_request r JOIN customer c ON c.id=r.customer_id JOIN part p ON p.id=r.part_id
      WHERE r.status='open' ORDER BY r.id`, [])).map(r => ({
    id: r.id, partId: r.part_id, partName: r.part_name, dealership: r.dealership,
    note: r.note, at: r.created_at, currentCost: Number(r.cost) || 0,
  }));
}

// Resolving usually means publishing the cost right here — pricing goes live for every dealer
// the moment it lands. Any open request for the same part resolves with it.
export async function resolvePriceRequest(id, cost, user) {
  const r = await one(`SELECT * FROM price_request WHERE id=$1 AND status='open'`, [id]);
  if (!r) throw new Error('Price request not found (or already resolved).');
  if (cost != null && cost !== '') {
    if (!(Number(cost) > 0)) throw new Error('Cost must be greater than zero.');
    await q('UPDATE part SET cost=$1 WHERE id=$2', [Number(cost), r.part_id]);
  }
  const priced2 = Number((await one('SELECT cost FROM part WHERE id=$1', [r.part_id]))?.cost) > 0;
  if (!priced2) throw new Error('Set the part\'s cost first (or enter one here) — resolving without a price would send the dealer back to "Call for price".');
  await q(`UPDATE price_request SET status='resolved', resolved_at=now(), resolved_by=$1 WHERE part_id=$2 AND status='open'`,
    [user?.id || null, r.part_id]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [user?.id || null, 'dealerparts.price', `${r.part_id} priced${cost != null && cost !== '' ? ' at $' + Number(cost) : ''} — request #${id} resolved`]).catch(() => {});
  return { ok: true, ...partPricing(Number((await one('SELECT cost FROM part WHERE id=$1', [r.part_id])).cost)) };
}

// A model's current parts list (optionally with one order's configured deltas applied — the
// exact build). Dealers get pricing tiers only; Built's cost never leaves this module.
async function modelParts(modelId, orderId) {
  const lines = await all(
    `SELECT b.part_id, b.qty, COALESCE(b.stage,'Build') AS stage, p.name, p.uom, p.cost
       FROM bom_line b JOIN part p ON p.id=b.part_id
      WHERE b.model_id=$1 AND p.active <> false ORDER BY COALESCE(b.stage,'Build'), p.name`, [modelId]);
  const map = new Map(lines.map(l => [l.part_id, { ...l, qty: Number(l.qty) }]));
  if (orderId) {
    for (const d of await all('SELECT part_id, qty, stage FROM order_bom_delta WHERE order_id=$1', [orderId])) {
      const cur = map.get(d.part_id);
      if (cur) {
        cur.qty += Number(d.qty);
        if (cur.qty <= 0) map.delete(d.part_id);
      } else if (Number(d.qty) > 0) {
        const p = await one('SELECT id, name, uom, cost FROM part WHERE id=$1', [d.part_id]);
        if (p) map.set(d.part_id, { part_id: p.id, name: p.name, uom: p.uom, cost: p.cost, stage: d.stage || 'Build', qty: Number(d.qty) });
      }
    }
  }
  return [...map.values()].map(priced);
}

// A model's current parts, priced — the "suggested parts" view when a dealer picks a model.
export const catalogForModel = modelId => modelParts(modelId, null);

// VIN lookup. The owning dealership sees the EXACT build (base + configured deltas); a unit
// sold through another channel, or a pre-app VIN, gets the model's CURRENT parts as a
// suggestion. Built's own 7XJ VINs decode to body/length/axles for the model match.
export async function vinLookup(vinRaw, customerId) {
  const vin = String(vinRaw || '').trim().toUpperCase();
  if (!vin) throw new Error('Enter a VIN.');
  const t = await one(
    `SELECT t.id, t.vin, t.model_id, t.customer_id, t.order_id, m.name AS model_name, m.category
       FROM trailer t JOIN model m ON m.id = t.model_id WHERE upper(t.vin)=upper($1)`, [vin]);
  if (t) {
    const exact = !!customerId && t.customer_id === customerId;
    return {
      found: true, exact, suggested: !exact, vin, modelId: t.model_id, modelName: t.model_name,
      note: exact ? 'Exact parts for this trailer as built.'
        : 'Current parts for this trailer\'s model — the unit was not sold through your dealership, so the factory configuration isn\'t shown.',
      lines: await modelParts(t.model_id, exact ? t.order_id : null),
    };
  }
  // Pre-app VIN: decode Built's filed scheme (pos 5 body, pos 6-7 length ft, pos 8 axles).
  if (vin.length === 17 && vin.startsWith('7XJ')) {
    const body = vin[4], len = Number(vin.slice(5, 7)), axles = Number(vin[7]);
    const matches = await all(
      `SELECT id, name FROM model WHERE upper(COALESCE(body_code,''))=$1 AND length_ft=$2 AND axles=$3 ORDER BY id`,
      [body, len, axles]).catch(() => []);
    if (matches.length) {
      return {
        found: false, suggested: true, vin, modelId: matches[0].id, modelName: matches[0].name,
        altModels: matches.slice(1),
        note: 'This VIN predates the system — showing the current parts for the same trailer model.',
        lines: await modelParts(matches[0].id, null),
      };
    }
  }
  const models = await all(`SELECT id, name, category FROM model ORDER BY category, id`, []);
  return { found: false, unknown: true, vin, models,
    note: 'VIN not on file — pick the trailer model to see its current parts.' };
}

// Free search: part number, description, or spec; optionally only parts used in a given build
// stage ("portion of the trailer").
export async function catalogSearch({ q: term, stage } = {}) {
  const like = '%' + String(term || '').trim() + '%';
  const args = [like];
  let sql = `SELECT p.id, p.name, p.uom, p.cost FROM part p
              WHERE p.active <> false AND (p.id ILIKE $1 OR p.name ILIKE $1 OR COALESCE(p.spec,'') ILIKE $1)`;
  if (stage) { args.push(stage); sql += ` AND EXISTS (SELECT 1 FROM bom_line b WHERE b.part_id=p.id AND COALESCE(b.stage,'Build')=$2)`; }
  sql += ' ORDER BY p.name LIMIT 60';
  return (await all(sql, args)).map(priced);
}

// ---- ordering ------------------------------------------------------------------------------
const STATUS_FLOW = { received: 'fulfill', fulfilled: 'ready', ready: 'complete' };
export const statusLabel = o =>
  o.status === 'received' ? 'Received'
    : o.status === 'fulfilled' ? 'Fulfilled'
      : o.status === 'ready' ? (o.method === 'ship' ? 'Ready to ship' : 'Ready for pickup')
        : o.status === 'completed' ? (o.method === 'ship' ? 'Shipped' : 'Picked up')
          : 'Cancelled';

export async function submitPartsOrder(d, { vin, method, note, lines }) {
  if (!d.customer_id) throw new Error('Your account is not linked to a dealer record yet — contact Built Trailers.');
  const m = method === 'ship' ? 'ship' : 'pickup';
  const cleaned = (Array.isArray(lines) ? lines : [])
    .map(l => ({ partId: String(l.partId || '').trim(), qty: Number(l.qty) })).filter(l => l.partId);
  if (!cleaned.length) throw new Error('Add at least one part to the order.');
  const rows = [];
  for (const l of cleaned) {
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw new Error(`Quantity for ${l.partId} must be greater than zero.`);
    const p = await one('SELECT id, name, cost, active FROM part WHERE id=$1', [l.partId]);
    if (!p || p.active === false) throw new Error(`Part ${l.partId} isn't in the current catalog.`);
    if (!(Number(p.cost) > 0)) throw new Error(`${l.partId} is "Call for price" — submit a price request from the catalog and Built Trailers will publish it.`);
    rows.push({ ...l, unitPrice: partPricing(p.cost).dealerPrice }); // price frozen NOW
  }
  const total = r2(rows.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  const o = await one(
    `INSERT INTO dealer_parts_order(customer_id, method, vin, note, dealer_user_id, total)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [d.customer_id, m, String(vin || '').trim().toUpperCase() || null, String(note || '').trim() || null, d.id || null, total]);
  for (const l of rows)
    await q('INSERT INTO dealer_parts_line(order_id, part_id, qty, unit_price) VALUES ($1,$2,$3,$4)', [o.id, l.partId, l.qty, l.unitPrice]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [null, 'dealerparts.submit', `DP-${o.id} ${d.customer_id} — ${rows.map(l => `${l.qty}× ${l.partId}`).join(', ')} = $${total}`]).catch(() => {});
  return { id: o.id, ref: 'DP-' + o.id, total, status: 'received' };
}

async function ordersWithLines(where, args) {
  const orders = await all(
    `SELECT o.*, c.name AS dealership FROM dealer_parts_order o JOIN customer c ON c.id=o.customer_id
      ${where} ORDER BY o.id DESC LIMIT 100`, args);
  const out = [];
  for (const o of orders) {
    const lines = await all(
      `SELECT l.part_id, l.qty, l.unit_price, p.name, p.on_hand FROM dealer_parts_line l
        LEFT JOIN part p ON p.id=l.part_id WHERE l.order_id=$1 ORDER BY l.id`, [o.id]);
    out.push({
      id: o.id, ref: 'DP-' + o.id, dealership: o.dealership, customerId: o.customer_id,
      status: o.status, statusLabel: statusLabel(o), method: o.method, vin: o.vin, note: o.note,
      total: Number(o.total), invoiceRef: o.invoice_ref || null,
      createdAt: o.created_at, fulfilledAt: o.fulfilled_at, readyAt: o.ready_at, completedAt: o.completed_at,
      lines: lines.map(l => ({ partId: l.part_id, name: l.name || l.part_id, qty: Number(l.qty),
        unitPrice: Number(l.unit_price), short: o.status === 'received' && Number(l.on_hand) < Number(l.qty) })),
    });
  }
  return out;
}
export const dealerPartsOrders = customerId => ordersWithLines('WHERE o.customer_id=$1', [customerId]);
export const staffPartsOrders = status =>
  status ? ordersWithLines('WHERE o.status=$1', [status]) : ordersWithLines(`WHERE o.status <> 'cancelled'`, []);

// Sales advances the order. fulfill = the physical pick: stock down, costs frozen, value into
// the Dealer-fulfillment bucket. complete = it left the building: invoice + COGS post, and the
// bucket lets go. Cancelling after fulfillment restocks.
export async function advancePartsOrder(id, action, { force } = {}, user) {
  const o = await one('SELECT o.*, c.name, c.bill_name FROM dealer_parts_order o JOIN customer c ON c.id=o.customer_id WHERE o.id=$1', [id]);
  if (!o) throw new Error('Parts order not found.');
  const lines = await all('SELECT * FROM dealer_parts_line WHERE order_id=$1 ORDER BY id', [id]);
  const ref = 'DP-' + o.id;

  if (action === 'cancel') {
    if (o.status === 'completed') throw new Error('Already invoiced — handle returns through accounting.');
    if (o.status === 'cancelled') throw new Error('Already cancelled.');
    if (['fulfilled', 'ready'].includes(o.status))
      for (const l of lines) await q('UPDATE part SET on_hand = on_hand + $1 WHERE id=$2', [Number(l.qty), l.part_id]);
    await q(`UPDATE dealer_parts_order SET status='cancelled' WHERE id=$1`, [id]);
    await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)', [user?.id || null, 'dealerparts.cancel', ref]).catch(() => {});
    return { ok: true, status: 'cancelled' };
  }
  if (STATUS_FLOW[o.status] !== action) throw new Error(`Order is "${statusLabel(o)}" — the next step is "${STATUS_FLOW[o.status] || 'none'}".`);

  if (action === 'fulfill') {
    const parts = {};
    const short = [];
    for (const l of lines) {
      const p = await one('SELECT id, cost, on_hand FROM part WHERE id=$1', [l.part_id]);
      if (!p) throw new Error(`Part ${l.part_id} no longer exists.`);
      parts[l.part_id] = p;
      if (Number(p.on_hand) < Number(l.qty)) short.push(`${l.part_id} (${Number(p.on_hand)} on hand, need ${Number(l.qty)})`);
    }
    if (short.length && !force)
      throw new Error(`Short stock: ${short.join('; ')}. Confirm to fulfill anyway — counts go negative until corrected.`);
    let costTotal = 0;
    for (const l of lines) {
      const cost = Number(parts[l.part_id].cost) || 0;
      costTotal += cost * Number(l.qty);
      await q('UPDATE dealer_parts_line SET unit_cost=$1 WHERE id=$2', [cost, l.id]);
      await q('UPDATE part SET on_hand = on_hand - $1 WHERE id=$2', [Number(l.qty), l.part_id]);
    }
    await q(`UPDATE dealer_parts_order SET status='fulfilled', cost_total=$1, fulfilled_at=now() WHERE id=$2`, [r2(costTotal), id]);
  } else if (action === 'ready') {
    await q(`UPDATE dealer_parts_order SET status='ready', ready_at=now() WHERE id=$1`, [id]);
  } else if (action === 'complete') {
    const party = o.bill_name || o.name; // corporate bill-to when the dealership has one
    const invLines = lines.map(l => ({
      model: 'Parts & Accessories', qty: Number(l.qty), amount: r2(Number(l.qty) * Number(l.unit_price)),
      description: `${Number(l.qty)}× ${l.part_id} — dealer parts order ${ref}`,
    }));
    await postInvoice(ref, party, Number(o.total), user?.id || null, invLines);
    if (Number(o.cost_total) > 0) await postCOGS(ref, Number(o.cost_total), user?.id || null);
    await q(`UPDATE dealer_parts_order SET status='completed', invoice_ref=$1, completed_at=now() WHERE id=$2`, [ref, id]);
  } else {
    throw new Error('Unknown action.');
  }
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [user?.id || null, 'dealerparts.' + action, ref]).catch(() => {});
  const after = await one('SELECT status, method FROM dealer_parts_order WHERE id=$1', [id]);
  return { ok: true, status: after.status, statusLabel: statusLabel(after) };
}
