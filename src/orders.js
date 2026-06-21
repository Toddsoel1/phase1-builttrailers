// Phase 2 — Sales orders, dealer authorization, type-based fulfillment, inventory consume.
import { all, one, q } from './db.js';
import { postInvoice } from './accounting.js';

export const STAGES = ['Quote', 'Confirmed', 'Scheduled', 'In Production', 'QC', 'Ready / Shipped'];
const SALES_TITLES = ['Sales', 'Rep Specialist', 'General Manager'];

export function canSell(user) {
  return user && (user.role === 'admin' || SALES_TITLES.includes(user.title));
}

export async function trailerTypes() {
  return (await all('SELECT name FROM trailer_type ORDER BY name', [])).map(r => r.name);
}

export async function customersWithTypes() {
  const custs = await all(`SELECT c.*, u.name AS rep_name FROM customer c LEFT JOIN app_user u ON u.id=c.rep_id ORDER BY c.id`, []);
  const allowed = await all('SELECT customer_id, type FROM customer_allowed_type', []);
  return custs.map(c => ({
    id: c.id, name: c.name, kind: c.kind, contact: c.contact, phone: c.phone,
    rep: c.rep_name, repId: c.rep_id,
    smsConsent: !!c.sms_consent, smsConsentAt: c.sms_consent_at || null,
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
           c.name AS customer_name, u.name AS rep_name
      FROM sales_order o
      LEFT JOIN model m ON m.id=o.model_id
      LEFT JOIN customer c ON c.id=o.customer_id
      LEFT JOIN app_user u ON u.id=o.rep_id
     ORDER BY o.id`, []);
  return rows.map(o => ({
    id: o.id, customerId: o.customer_id, customer: o.customer_name, modelId: o.model_id,
    model: o.model_name, type: o.type || 'Custom', qty: o.qty, stage: o.stage, due: o.due,
    deposit: Number(o.deposit), channel: o.channel, rep: o.rep_name, consumed: o.consumed,
    price: Number(o.price || 0), revenue: Number(o.price || 0) * o.qty
  }));
}

// consume finished-goods inventory for an order's BOM (called once at ship)
export async function consumeInventory(orderId, userId) {
  const o = await one('SELECT * FROM sales_order WHERE id=$1', [orderId]);
  if (!o || o.consumed) return;
  const lines = await all('SELECT part_id, qty FROM bom_line WHERE model_id=$1', [o.model_id]);
  for (const l of lines) {
    await q('UPDATE part SET on_hand = GREATEST(0, on_hand - $1) WHERE id=$2', [Math.round(Number(l.qty) * o.qty), l.part_id]);
  }
  await q('UPDATE sales_order SET consumed=true WHERE id=$1', [orderId]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [userId || null, 'order.ship', `${orderId} shipped — inventory consumed`]);
  // Phase 4: post a customer invoice to accounting on shipment
  const info = await one(`SELECT m.price, c.name AS customer FROM sales_order o
                            LEFT JOIN model m ON m.id=o.model_id
                            LEFT JOIN customer c ON c.id=o.customer_id WHERE o.id=$1`, [orderId]);
  if (info) await postInvoice(orderId, info.customer || 'Customer', Number(info.price || 0) * o.qty, userId);
}
