// Batch invoicing — group several of a dealer's trailers onto one invoice instead
// of billing each separately, to streamline collections and payments.
//
// An order can belong to at most one batch (sales_order.invoice_batch_id). Posting a
// batch records ONE combined invoice and marks every order in it billed=true; the
// ship-time per-order invoice (orders.js) skips orders that are batch-billed, so a
// trailer is never invoiced twice. Lifecycle: Draft -> Invoiced -> Paid.
import { all, one, q } from './db.js';
import { postInvoice, postCOGS } from './accounting.js';
import { assignVinsForOrder } from './trailers.js';
import { consumeInventory } from './orders.js';
import { orderWip } from './wip.js';

async function nextBatchId() {
  const n = (await all('SELECT id FROM invoice_batch', [])).length;
  return 'IB-' + (2001 + n);
}

// Live sum of a batch's order revenue (model price × qty).
async function batchTotal(batchId) {
  const r = await one(
    `SELECT COALESCE(SUM(m.price * o.qty), 0) AS total
       FROM sales_order o LEFT JOIN model m ON m.id = o.model_id
      WHERE o.invoice_batch_id = $1`, [batchId]);
  return Number(r?.total || 0);
}

// Orders that can be added to a batch for a customer: theirs, not yet billed,
// not already in a batch.
export async function eligibleOrders(customerId) {
  const rows = await all(
    `SELECT o.id, o.qty, o.stage, o.due, m.name AS model, m.category AS type, m.price
       FROM sales_order o LEFT JOIN model m ON m.id = o.model_id
      WHERE o.customer_id = $1 AND o.billed = false AND o.invoice_batch_id IS NULL
      ORDER BY o.production_seq NULLS LAST, o.id`, [customerId]);
  return rows.map(o => ({
    id: o.id, qty: o.qty, stage: o.stage, due: o.due, model: o.model, type: o.type,
    amount: Number(o.price || 0) * o.qty,
  }));
}

export async function listBatches() {
  const rows = await all(
    `SELECT b.id, b.customer_name, b.status, b.note, b.created_at, b.invoiced_at, b.paid_at,
            COUNT(o.id)::int AS order_count,
            COALESCE(SUM(m.price * o.qty), 0) AS calc_total
       FROM invoice_batch b
       LEFT JOIN sales_order o ON o.invoice_batch_id = b.id
       LEFT JOIN model m ON m.id = o.model_id
      GROUP BY b.id, b.customer_name, b.status, b.note, b.created_at, b.invoiced_at, b.paid_at
      ORDER BY b.created_at DESC`, []);
  return rows.map(b => ({
    id: b.id, customer: b.customer_name, status: b.status, note: b.note,
    orderCount: b.order_count, total: Number(b.calc_total || 0),
    createdAt: b.created_at, invoicedAt: b.invoiced_at, paidAt: b.paid_at,
  }));
}

export async function getBatch(id) {
  const b = await one('SELECT * FROM invoice_batch WHERE id=$1', [id]);
  if (!b) return null;
  const orders = await all(
    `SELECT o.id, o.qty, o.stage, o.due, o.model_id, m.name AS model, m.category AS type, m.price
       FROM sales_order o LEFT JOIN model m ON m.id = o.model_id
      WHERE o.invoice_batch_id = $1 ORDER BY o.id`, [id]);
  // One invoice line per physical trailer, each carrying its VIN (or null if not
  // assigned yet). A qty-N order produces N lines.
  const lineItems = [];
  for (const o of orders) {
    const vins = await all('SELECT vin FROM trailer WHERE order_id=$1 AND vin IS NOT NULL ORDER BY serial', [o.id]);
    const unit = Number(o.price || 0);
    for (let i = 0; i < o.qty; i++) {
      lineItems.push({ orderId: o.id, modelId: o.model_id, model: o.model, type: o.type, vin: vins[i] ? vins[i].vin : null, amount: unit });
    }
  }
  return {
    id: b.id, customerId: b.customer_id, customer: b.customer_name, status: b.status,
    note: b.note, createdAt: b.created_at, invoicedAt: b.invoiced_at, paidAt: b.paid_at,
    externalId: b.external_id,
    orders: orders.map(o => ({
      id: o.id, qty: o.qty, stage: o.stage, due: o.due, model: o.model, type: o.type,
      amount: Number(o.price || 0) * o.qty,
    })),
    lineItems,
    total: await batchTotal(id),
  };
}

// Attach only orders that belong to the customer and are still unbilled & unbatched.
async function attachOrders(batchId, customerId, orderIds) {
  for (const oid of orderIds) {
    await q(`UPDATE sales_order SET invoice_batch_id=$1
              WHERE id=$2 AND customer_id=$3 AND billed=false AND invoice_batch_id IS NULL`,
      [batchId, oid, customerId]);
  }
}

export async function createBatch(customerId, orderIds, note, user) {
  const cust = await one('SELECT * FROM customer WHERE id=$1', [customerId]);
  if (!cust) throw new Error('customer not found');
  const id = await nextBatchId();
  await q(`INSERT INTO invoice_batch(id,customer_id,customer_name,status,note,created_by)
           VALUES ($1,$2,$3,'Draft',$4,$5)`, [id, customerId, cust.name, note || null, user?.id || null]);
  if (Array.isArray(orderIds) && orderIds.length) await attachOrders(id, customerId, orderIds);
  return id;
}

export async function addOrders(batchId, orderIds) {
  const b = await one('SELECT * FROM invoice_batch WHERE id=$1', [batchId]);
  if (!b) throw new Error('batch not found');
  if (b.status !== 'Draft') throw new Error('only Draft batches can be modified');
  await attachOrders(batchId, b.customer_id, Array.isArray(orderIds) ? orderIds : []);
  return getBatch(batchId);
}

export async function removeOrder(batchId, orderId) {
  const b = await one('SELECT * FROM invoice_batch WHERE id=$1', [batchId]);
  if (!b) throw new Error('batch not found');
  if (b.status !== 'Draft') throw new Error('only Draft batches can be modified');
  await q(`UPDATE sales_order SET invoice_batch_id=NULL WHERE id=$1 AND invoice_batch_id=$2`, [orderId, batchId]);
  return getBatch(batchId);
}

// Draft -> Invoiced: post ONE combined invoice, mark every order billed.
export async function postBatchInvoice(batchId, user) {
  const b = await one('SELECT * FROM invoice_batch WHERE id=$1', [batchId]);
  if (!b) throw new Error('batch not found');
  if (b.status !== 'Draft') throw new Error('batch has already been invoiced');
  const orders = await all('SELECT id FROM sales_order WHERE invoice_batch_id=$1', [batchId]);
  if (!orders.length) throw new Error('batch has no orders to invoice');
  // Issue VINs for any trailers that don't have one yet, so the invoice never
  // goes out with a "VIN pending" line.
  for (const o of orders) {
    try { await assignVinsForOrder(o.id, user); } catch { /* non-fatal: invoice still posts */ }
  }
  const total = await batchTotal(batchId);
  // One QuickBooks line per trailer, with its VIN in the description, booked against the
  // model's own Product/Service (resolved by SKU = the app's model id).
  const { lineItems } = await getBatch(batchId);
  const lines = lineItems.map(li => ({
    modelId: li.modelId, model: li.model, qty: 1,
    description: `${li.model || 'Trailer'}${li.vin ? ' — VIN ' + li.vin : ''}`,
    amount: li.amount,
  }));
  await postInvoice(batchId, b.customer_name || 'Dealer', total, user?.id || null, lines);
  // The cost side — same as a single-order invoice: catch up any unconsumed stages, then
  // relieve each order's accumulated WIP into COGS. (consumeInventory skips its own billing
  // for batched orders, so nothing double-invoices.)
  for (const o of orders) {
    try {
      await consumeInventory(o.id, user?.id || null);
      const cogs = await orderWip(o.id);
      if (cogs > 0) await postCOGS(o.id, cogs, user?.id || null);
    } catch (e) { console.warn(`batch ${batchId} COGS for ${o.id}:`, e.message); }
  }
  await q(`UPDATE sales_order SET billed=true WHERE invoice_batch_id=$1`, [batchId]);
  await q(`UPDATE invoice_batch SET status='Invoiced', total=$1, invoiced_at=now() WHERE id=$2`, [total, batchId]);
  return getBatch(batchId);
}

// Invoiced -> Paid
export async function markPaid(batchId, user) {
  const b = await one('SELECT * FROM invoice_batch WHERE id=$1', [batchId]);
  if (!b) throw new Error('batch not found');
  if (b.status !== 'Invoiced') throw new Error('only Invoiced batches can be marked paid');
  await q(`UPDATE invoice_batch SET status='Paid', paid_at=now() WHERE id=$1`, [batchId]);
  return getBatch(batchId);
}
