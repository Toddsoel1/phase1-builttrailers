// Trailer units — one row per physical trailer (a sales order of qty N yields N
// units). Holds the assigned VIN and is the anchor that the warranty module
// (build log, registration, claims) will hang off of.
import { all, one, q } from './db.js';
import { generateVin, vinConfig, setVinConfig, nhtsaCheckUnits } from './vin.js';

async function nextTrailerId() {
  const n = (await all('SELECT id FROM trailer', [])).length;
  return 'T-' + String(10001 + n);
}

export async function listTrailers() {
  const config = await vinConfig();
  // Orders that still have trailers without a VIN (qty > VINs assigned for that order)
  const pending = await all(
    `SELECT o.id, o.qty, o.stage, m.name AS model, m.category AS type, c.name AS customer,
            COALESCE(t.cnt, 0)::int AS assigned
       FROM sales_order o
       LEFT JOIN model m ON m.id = o.model_id
       LEFT JOIN customer c ON c.id = o.customer_id
       LEFT JOIN (SELECT order_id, COUNT(*) AS cnt FROM trailer WHERE vin IS NOT NULL GROUP BY order_id) t
              ON t.order_id = o.id
      WHERE o.qty > COALESCE(t.cnt, 0)
      ORDER BY o.production_seq NULLS LAST, o.id`, []);
  // Every trailer that has a VIN (the registry / completed-inventory list)
  const registry = await all(
    `SELECT t.id, t.vin, t.serial, t.vin_assigned_at, t.order_id,
            m.name AS model, m.category AS type, c.name AS customer
       FROM trailer t
       LEFT JOIN model m ON m.id = t.model_id
       LEFT JOIN customer c ON c.id = t.customer_id
      WHERE t.vin IS NOT NULL
      ORDER BY t.serial DESC`, []);
  return {
    config,
    pending: pending.map(o => ({
      orderId: o.id, qty: o.qty, stage: o.stage, model: o.model, type: o.type,
      customer: o.customer, assigned: o.assigned, needed: o.qty - o.assigned,
    })),
    registry: registry.map(t => ({
      id: t.id, vin: t.vin, serial: t.serial, model: t.model, type: t.type,
      customer: t.customer, orderId: t.order_id, assignedAt: t.vin_assigned_at,
    })),
  };
}

// Ensure the order has qty trailer units, then assign a VIN to any without one.
export async function assignVinsForOrder(orderId, user) {
  const o = await one(
    `SELECT o.*, m.category AS category FROM sales_order o
       LEFT JOIN model m ON m.id = o.model_id WHERE o.id = $1`, [orderId]);
  if (!o) throw new Error('order not found');

  let units = await all('SELECT * FROM trailer WHERE order_id=$1 ORDER BY id', [orderId]);
  while (units.length < o.qty) {
    const id = await nextTrailerId();
    await q(`INSERT INTO trailer(id,order_id,model_id,customer_id,status) VALUES($1,$2,$3,$4,'Pending')`,
      [id, orderId, o.model_id, o.customer_id]);
    units.push(await one('SELECT * FROM trailer WHERE id=$1', [id]));
  }

  const assigned = [];
  for (const u of units) {
    if (u.vin) continue;
    const { vin, serial } = await generateVin(o.model_id);
    await q(`UPDATE trailer SET vin=$1, serial=$2, status='VIN Assigned', vin_assigned_at=now(), vin_assigned_by=$3 WHERE id=$4`,
      [vin, serial, user?.id || null, u.id]);
    assigned.push({ id: u.id, vin });
  }
  // Every new VIN gets verified against the NHTSA vPIC decoder, off the critical path —
  // a network hiccup must never block a stage move. Failures surface in the Print Center.
  if (assigned.length)
    nhtsaCheckUnits({ unitIds: assigned.map(a => a.id) })
      .then(r => { if (r.failed) console.warn(`NHTSA: ${r.failed}/${r.checked} new VIN(s) failed vPIC verification`); })
      .catch(e => console.warn('NHTSA check:', e.message));
  return assigned;
}

const PAINT = 'Paint/Powder Coat';

// Stage-driven unit lifecycle (idempotent): VINs are created when an order enters Build; the
// VIN print job queues for the office when Paint begins; the MSO print job queues when Paint
// is completed. A print/VIN side effect must never make a stage move fail.
export async function afterStageChange(orderId, fromStage, toStage, user) {
  try {
    if (toStage === 'Build') await assignVinsForOrder(orderId, user);
    if (toStage === PAINT) await queuePrints(orderId, 'vin');
    if (fromStage === PAINT) await queuePrints(orderId, 'mso');
  } catch (e) { console.warn('afterStageChange:', e.message); }
}

// One print job per VIN'd unit on the order — idempotent (a unit can't be queued twice for the
// same kind). MSOs are HELD for stock units (no customer yet): the MSO names the buyer, so it
// only queues once a dealer/customer has been assigned (the trailer is sold).
async function queuePrints(orderId, kind) {
  const units = await all('SELECT id, customer_id FROM trailer WHERE order_id=$1 AND vin IS NOT NULL', [orderId]);
  for (const u of units) {
    if (kind === 'mso' && !u.customer_id) continue; // stock build — hold the MSO until sold
    await q(`INSERT INTO print_job(unit_id,order_id,kind) VALUES($1,$2,$3) ON CONFLICT(unit_id,kind) DO NOTHING`, [u.id, orderId, kind]);
  }
}

// When a stock order is sold (a customer is assigned), release any held MSOs — but only if the
// trailer has already passed Paint. If it hasn't, the MSO will queue normally at paint-complete.
// "Past paint" = the order is at Finish/Ready, or Paint is recorded done in the daily-update log.
export async function releaseMsosIfPaintDone(orderId) {
  const o = await one('SELECT stage FROM sales_order WHERE id=$1', [orderId]);
  const pastPaint = (o && ['Finish', 'Ready'].includes(o.stage))
    || !!await one(`SELECT 1 AS x FROM order_stage_done WHERE order_id=$1 AND stage=$2`, [orderId, PAINT]);
  if (!pastPaint) return 0;
  await queuePrints(orderId, 'mso');
  return (await all(`SELECT id FROM trailer WHERE order_id=$1 AND vin IS NOT NULL`, [orderId])).length;
}

// The office print center: queued (unprinted) VIN labels and/or MSOs, oldest first.
export async function printQueue(kind) {
  const rows = await all(
    `SELECT pj.id, pj.kind, pj.queued_at, t.id AS unit_id, t.vin, t.serial, t.order_id,
            t.nhtsa_ok, t.nhtsa_note, m.name AS model, m.category AS type, m.axle, c.name AS customer
       FROM print_job pj
       JOIN trailer t ON t.id = pj.unit_id
       LEFT JOIN model m ON m.id = t.model_id
       LEFT JOIN customer c ON c.id = t.customer_id
      WHERE pj.status='queued'${kind ? ' AND pj.kind=$1' : ''}
      ORDER BY pj.queued_at`, kind ? [kind] : []);
  return rows.map(r => ({ jobId: r.id, kind: r.kind, queuedAt: r.queued_at, unitId: r.unit_id,
    vin: r.vin, serial: r.serial, orderId: r.order_id, model: r.model, type: r.type, axle: r.axle, customer: r.customer,
    nhtsaOk: r.nhtsa_ok, nhtsaNote: r.nhtsa_note }));
}

export async function markPrinted(jobId, user) {
  if (!await one('SELECT id FROM print_job WHERE id=$1', [jobId])) throw new Error('print job not found');
  await q(`UPDATE print_job SET status='printed', printed_at=now(), printed_by=$1 WHERE id=$2`, [user?.id || null, jobId]);
  return { ok: true };
}

// Correct a VIN after the fact (crossed stickers, etc.). Every build detail stays with the unit
// because the build log, registration, claims and consumption all key on the trailer id — not the
// VIN — so only the vin column changes. The endpoint restricts this to OM/GM/Admin.
export async function correctVin(unitId, newVin) {
  const u = await one('SELECT * FROM trailer WHERE id=$1', [unitId]);
  if (!u) throw new Error('Trailer unit not found.');
  const vin = String(newVin || '').trim().toUpperCase();
  if (vin.length !== 17) throw new Error('A VIN must be exactly 17 characters.');
  if (await one('SELECT id FROM trailer WHERE upper(vin)=$1 AND id<>$2', [vin, unitId])) throw new Error('That VIN is already assigned to another unit.');
  // A corrected VIN invalidates the old NHTSA result — clear it and re-verify in the background.
  await q('UPDATE trailer SET vin=$1, nhtsa_checked_at=NULL, nhtsa_ok=NULL, nhtsa_note=NULL WHERE id=$2', [vin, unitId]);
  nhtsaCheckUnits({ unitIds: [unitId] }).catch(e => console.warn('NHTSA check:', e.message));
  return { unitId, oldVin: u.vin, newVin: vin };
}

// Everything the printed traveler needs for one unit (the QR is generated by the endpoint).
export async function travelerData(unitId) {
  const t = await one(
    `SELECT t.*, m.name AS model, m.category AS type, m.axle, o.stage AS order_stage, o.due, o.channel, c.name AS customer
       FROM trailer t LEFT JOIN model m ON m.id=t.model_id
       LEFT JOIN sales_order o ON o.id=t.order_id LEFT JOIN customer c ON c.id=t.customer_id
      WHERE t.id=$1`, [unitId]);
  if (!t) return null;
  const done = (await all(`SELECT stage FROM order_stage_done WHERE order_id=$1`, [t.order_id]).catch(() => [])).map(r => r.stage);
  return {
    unitId: t.id, vin: t.vin, serial: t.serial, model: t.model, type: t.type, axle: t.axle,
    orderId: t.order_id, customer: t.customer || (t.channel === 'Stock' ? 'STOCK — not yet sold' : ''),
    due: t.due, stage: t.order_stage, stagesDone: done,
  };
}

// What the QR on a traveler resolves to — looked up live, so a corrected VIN always shows.
export async function publicUnit(id) {
  const t = await one(`SELECT t.vin, t.status, m.name AS model, m.category AS type
                         FROM trailer t LEFT JOIN model m ON m.id=t.model_id WHERE t.id=$1`, [id]);
  return t ? { vin: t.vin, model: t.model, type: t.type, status: t.status } : null;
}

// Everything the shop-floor station page (the traveler QR's target) needs: the unit, its
// order's current stage, and the boat build config. Deliberately price-free — dealer money
// never renders on the floor.
export async function stationUnit(id) {
  const t = await one(`SELECT t.id, t.vin, t.status, t.order_id, m.name AS model, m.category AS type
                         FROM trailer t LEFT JOIN model m ON m.id=t.model_id WHERE t.id=$1`, [id]);
  if (!t) return null;
  let order = null, boat = null;
  if (t.order_id) {
    const o = await one('SELECT id, stage, qty, due FROM sales_order WHERE id=$1', [t.order_id]);
    if (o) order = { id: o.id, stage: o.stage, qty: o.qty, due: o.due };
    const b = await one('SELECT boat_model, boat_year, boat_length FROM order_build WHERE order_id=$1', [t.order_id]);
    if (b) {
      const opts = await all('SELECT group_name, choice_name FROM order_build_option WHERE order_id=$1 ORDER BY id', [t.order_id]);
      boat = { model: b.boat_model, year: b.boat_year, length: b.boat_length == null ? null : Number(b.boat_length),
               options: opts.map(x => ({ group: x.group_name, choice: x.choice_name })) };
    }
  }
  return { unitId: t.id, vin: t.vin, model: t.model, type: t.type, status: t.status, order, boat };
}

export { vinConfig, setVinConfig };
