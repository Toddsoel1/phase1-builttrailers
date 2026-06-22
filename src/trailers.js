// Trailer units — one row per physical trailer (a sales order of qty N yields N
// units). Holds the assigned VIN and is the anchor that the warranty module
// (build log, registration, claims) will hang off of.
import { all, one, q } from './db.js';
import { generateVin, vinConfig, setVinConfig } from './vin.js';

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
    const { vin, serial } = await generateVin({ modelId: o.model_id, category: o.category });
    await q(`UPDATE trailer SET vin=$1, serial=$2, status='VIN Assigned', vin_assigned_at=now(), vin_assigned_by=$3 WHERE id=$4`,
      [vin, serial, user?.id || null, u.id]);
    assigned.push({ id: u.id, vin });
  }
  return assigned;
}

export { vinConfig, setVinConfig };
