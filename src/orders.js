// Phase 2 — Sales orders, dealer authorization, type-based fulfillment, inventory consume.
import { all, one, q } from './db.js';
import { postInvoice, postCOGS } from './accounting.js';
import { userHasTitle } from './auth.js';
import { consumeStage, orderWip, PROD_STAGES } from './wip.js';

export const STAGES = ['Quote', 'Confirmed', 'Scheduled', 'Build', 'Paint/Powder Coat', 'Finish', 'Ready'];
const SALES_TITLES = ['Sales', 'Rep Specialist', 'General Manager'];
// Titles allowed to reorder the production queue (in addition to any admin)
const PRODUCTION_TITLES = ['Sales', 'Rep Specialist', 'General Manager', 'Shop Manager', 'Office Manager'];

export function canSell(user) {
  // Sales titles sell; so does any editor-or-above title granted the 'neworder' section in the
  // Job Titles matrix — so the checkbox works instead of silently requiring a hard-coded title.
  return !!user && (user.role === 'admin' || userHasTitle(user, SALES_TITLES)
    || (user.role !== 'viewer' && Array.isArray(user.sections) && user.sections.includes('neworder')));
}
export function canReorderProduction(user) {
  return !!user && (user.role === 'admin' || userHasTitle(user, PRODUCTION_TITLES));
}

export async function trailerTypes() {
  return (await all('SELECT name FROM trailer_type ORDER BY name', [])).map(r => r.name);
}

export async function customersWithTypes() {
  const custs = await all(`SELECT c.*, u.name AS rep_name FROM customer c LEFT JOIN app_user u ON u.id=c.rep_id ORDER BY c.id`, []);
  const allowed = await all('SELECT customer_id, type FROM customer_allowed_type', []);
  return custs.map(c => ({
    id: c.id, name: c.name, kind: c.kind, contact: c.contact, phone: c.phone,
    rep: c.rep_name, repId: c.rep_id, active: c.active !== false,
    smsConsent: !!c.sms_consent, smsConsentAt: c.sms_consent_at || null,
    address: c.address || null, city: c.city || null, state: c.state || null, zip: c.zip || null,
    lat: c.lat == null ? null : Number(c.lat), lng: c.lng == null ? null : Number(c.lng),
    allowed: allowed.filter(a => a.customer_id === c.id).map(a => a.type)
  }));
}

export async function allowedTypesFor(custId) {
  return (await all('SELECT type FROM customer_allowed_type WHERE customer_id=$1', [custId])).map(r => r.type);
}

// enrich orders with model, type, revenue
export async function ordersFull() {
  const rows = await all(`
    SELECT o.*, m.name AS model_name, m.category AS type, m.price,
           c.name AS customer_name, u.name AS rep_name,
           (SELECT COUNT(*)::int FROM andon_event a WHERE a.order_id=o.id AND a.resolved_at IS NULL) AS andon_open
      FROM sales_order o
      LEFT JOIN model m ON m.id=o.model_id
      LEFT JOIN customer c ON c.id=o.customer_id
      LEFT JOIN app_user u ON u.id=o.rep_id
     ORDER BY o.production_seq NULLS LAST, o.created_at, o.id`, []);
  return rows.map(o => ({
    id: o.id, customerId: o.customer_id, customer: o.customer_name, modelId: o.model_id,
    model: o.model_name, type: o.type || 'Custom', qty: o.qty, stage: o.stage, due: o.due,
    deposit: Number(o.deposit), channel: o.channel, rep: o.rep_name, consumed: o.consumed, billed: !!o.billed,
    prodSeq: o.production_seq == null ? null : Number(o.production_seq),
    price: Number(o.price || 0), revenue: Number(o.price || 0) * o.qty,
    andonOpen: Number(o.andon_open || 0)
  }));
}

// Resequence the production queue. `ids` is the full ordered list of order IDs;
// each is assigned production_seq = its 1-based position.
export async function setProductionOrder(ids) {
  for (let i = 0; i < ids.length; i++) {
    await q('UPDATE sales_order SET production_seq=$1 WHERE id=$2', [i + 1, ids[i]]);
  }
  return ids.length;
}

// Relieve inventory + close out an order's books at invoice time.
export async function consumeInventory(orderId, userId) {
  const o = await one('SELECT * FROM sales_order WHERE id=$1', [orderId]);
  if (!o) return;
  // Consume any production stage not yet completed via the daily updates (catch-up), so a
  // trailer's full BOM is relieved from inventory exactly once — whether stage-by-stage on
  // the floor or all at once here. consumeStage is idempotent per (order, stage).
  if (!o.consumed) {
    for (const st of PROD_STAGES) await consumeStage(orderId, st, { userId });
    await q('UPDATE sales_order SET consumed=true WHERE id=$1', [orderId]);
    await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
      [userId || null, 'order.consume', `${orderId} — inventory relieved`]);
  }
  // Bill once (idempotent on `billed`), independent of consume. Skipped if billed as part of
  // an invoice batch (invoice_batch_id) so a trailer is never invoiced twice.
  if (!o.invoice_batch_id && !o.billed) {
    const info = await one(`SELECT m.id AS model_id, m.name AS model, m.price, c.name AS customer FROM sales_order o
                              LEFT JOIN model m ON m.id=o.model_id
                              LEFT JOIN customer c ON c.id=o.customer_id WHERE o.id=$1`, [orderId]);
    if (info) {
      // One QuickBooks line per trailer (with its VIN), booked against the model's own
      // Product/Service — so QBO income reports split by what was actually sold.
      const unit = Number(info.price || 0);
      const vins = await all('SELECT vin FROM trailer WHERE order_id=$1 AND vin IS NOT NULL ORDER BY serial', [orderId]);
      const lines = Array.from({ length: o.qty }, (_, i) => ({
        modelId: info.model_id, model: info.model, qty: 1, amount: unit,
        description: `${info.model || 'Trailer'}${vins[i] ? ' — VIN ' + vins[i].vin : ''} (order ${orderId})`,
      }));
      await postInvoice(orderId, info.customer || 'Customer', unit * o.qty, userId, lines);
    }
    // Relieve the accumulated WIP cost into COGS.
    const cogs = await orderWip(orderId);
    if (cogs > 0) await postCOGS(orderId, cogs, userId);
    await q('UPDATE sales_order SET billed=true WHERE id=$1', [orderId]);
  }
}
