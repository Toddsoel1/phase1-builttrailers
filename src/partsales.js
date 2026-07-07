// Over-the-counter part sales — the whole transaction in one action so nobody steps outside
// the app: stock down, revenue posted (QBO invoice with "Parts & Accessories" lines), and the
// parts' cost relieved to COGS, exactly like a trailer sale.
import { all, one, q } from './db.js';
import { postInvoice, postCOGS } from './accounting.js';

const MARKUP = () => Number(process.env.PARTS_MARKUP || 1.5); // suggested retail = cost × markup

export function suggestedPrice(cost) {
  return Math.round(Number(cost || 0) * MARKUP() * 100) / 100;
}

// lines: [{ partId, qty, unitPrice }] — unitPrice is what the office agreed to charge.
// Overselling (qty > on hand) requires allowNegative: the part is physically leaving either
// way, so the caller confirms and the count goes negative until receiving/cycle count fixes it.
export async function sellParts({ customerId, customerName, lines, note, allowNegative }, user) {
  const cleaned = (Array.isArray(lines) ? lines : [])
    .map(l => ({ partId: String(l.partId || '').trim(), qty: Number(l.qty), unitPrice: Number(l.unitPrice) }))
    .filter(l => l.partId);
  if (!cleaned.length) throw new Error('Add at least one part to the sale.');
  for (const l of cleaned) {
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw new Error(`Quantity for ${l.partId} must be greater than zero.`);
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) throw new Error(`Price for ${l.partId} is missing.`);
  }

  let party = String(customerName || '').trim();
  if (customerId) {
    const c = await one('SELECT id, name FROM customer WHERE id=$1', [customerId]);
    if (!c) throw new Error('Customer not found.');
    party = c.name;
  }
  if (!party) throw new Error('Pick a customer or enter a walk-in name.');

  const parts = {};
  for (const l of cleaned) {
    const p = await one('SELECT id, name, cost, on_hand, active FROM part WHERE id=$1', [l.partId]);
    if (!p) throw new Error(`Part ${l.partId} not found.`);
    if (p.active === false) throw new Error(`Part ${l.partId} is inactive.`);
    parts[l.partId] = p;
    if (Number(p.on_hand) < l.qty && !allowNegative)
      throw new Error(`Only ${Number(p.on_hand)} × ${l.partId} on hand (selling ${l.qty}). Confirm to sell anyway — stock will go negative until it's corrected.`);
  }

  const total = Math.round(cleaned.reduce((a, l) => a + l.qty * l.unitPrice, 0) * 100) / 100;
  const costTotal = Math.round(cleaned.reduce((a, l) => a + l.qty * Number(parts[l.partId].cost || 0), 0) * 100) / 100;

  const sale = await one(
    `INSERT INTO part_sale(customer_id, party, total, cost_total, note, sold_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [customerId || null, party, total, costTotal, String(note || '').trim() || null, user?.id || null]);
  const ref = 'PS-' + sale.id;
  for (const l of cleaned) {
    await q(`INSERT INTO part_sale_line(sale_id, part_id, qty, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
      [sale.id, l.partId, l.qty, l.unitPrice, Number(parts[l.partId].cost || 0)]);
    await q('UPDATE part SET on_hand = on_hand - $1 WHERE id=$2', [l.qty, l.partId]);
  }

  // Revenue: one invoice, one line per part, booked to a QBO item named "Parts & Accessories"
  // (falls back to the generic item until the office creates it). Cost: the same Dr COGS /
  // Cr Inventory journal a trailer sale posts.
  const invLines = cleaned.map(l => ({
    model: 'Parts & Accessories', qty: l.qty, amount: Math.round(l.qty * l.unitPrice * 100) / 100,
    description: `${l.qty}× ${parts[l.partId].name || l.partId} (${l.partId})`,
  }));
  await postInvoice(ref, party, total, user?.id || null, invLines);
  if (costTotal > 0) await postCOGS(ref, costTotal, user?.id || null);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [user?.id || null, 'part.sale', `${ref} ${party} — ${cleaned.map(l => `${l.qty}× ${l.partId}`).join(', ')} = $${total}`]);

  return { id: sale.id, ref, total, costTotal, margin: Math.round((total - costTotal) * 100) / 100 };
}

export async function listSales(limit = 50) {
  const sales = await all(
    `SELECT s.*, u.name AS sold_by_name FROM part_sale s
      LEFT JOIN app_user u ON u.id = s.sold_by ORDER BY s.id DESC LIMIT $1`, [limit]);
  const out = [];
  for (const s of sales) {
    const lines = await all('SELECT part_id, qty, unit_price, unit_cost FROM part_sale_line WHERE sale_id=$1 ORDER BY id', [s.id]);
    out.push({
      id: s.id, ref: 'PS-' + s.id, party: s.party, customerId: s.customer_id,
      total: Number(s.total), costTotal: Number(s.cost_total),
      margin: Math.round((Number(s.total) - Number(s.cost_total)) * 100) / 100,
      note: s.note, soldBy: s.sold_by_name, soldAt: s.sold_at,
      items: lines.map(l => `${Number(l.qty)}× ${l.part_id}`).join(', '),
      lines: lines.map(l => ({ partId: l.part_id, qty: Number(l.qty), unitPrice: Number(l.unit_price), unitCost: Number(l.unit_cost) })),
    });
  }
  return out;
}
