// Warranty & build-history module. Everything hangs off a physical trailer unit
// (trailer.id / VIN from Project 3):
//   - build log: who completed each major step (parts, bending, paint, finish, QC) and when
//   - warranty registration: owner + term, with auto in-warranty/expired status
//   - claims: the repair, itemized parts (cost from parts master) + labor + shipping
//   - rollups: completed inventory by dealer, and warranty cost by model / dealer
import { all, one, q } from './db.js';
import { attachmentsFor } from './portal.js';
import { notifyDealer } from './dealernotify.js';

export const BUILD_STEPS = [
  { key: 'Parts',     label: 'Parts built' },
  { key: 'Bending',   label: 'Metal bent' },
  { key: 'Paint',     label: 'Painted' },
  { key: 'Finishing', label: 'Finished' },
  { key: 'QC',        label: 'QC passed' },
];
const DEFAULT_TERM = 12; // months

function warrantyStatus(reg) {
  if (!reg || !reg.registered_at) return { registered: false, status: 'Unregistered', expiresAt: null, termMonths: null, ownerName: null, ownerContact: null, registeredAt: null };
  // Warranty starts on the sale/invoice date when known, else the registration date.
  const start = reg.sale_date || reg.registered_at;
  const exp = new Date(start);
  exp.setMonth(exp.getMonth() + (Number(reg.term_months) || DEFAULT_TERM));
  const vs = reg.verification_status || 'verified';
  const status = vs === 'pending' ? 'Pending verification'
    : vs === 'rejected' ? 'Rejected'
    : (Date.now() < exp.getTime() ? 'In warranty' : 'Expired');
  return {
    registered: true, status, verificationStatus: vs,
    expiresAt: exp.toISOString(), termMonths: Number(reg.term_months) || DEFAULT_TERM,
    ownerName: reg.owner_name || null, ownerContact: reg.owner_contact || null,
    email: reg.email || null, phone: reg.phone || null, address: reg.warranty_address || null,
    saleDate: reg.sale_date || null, sellingDealer: reg.selling_dealer || null,
    smsOptIn: !!reg.sms_opt_in, emailOptIn: !!reg.email_opt_in,
    within15: reg.within_15_days, source: reg.source || 'staff',
    proofOfSale: reg.proof_of_sale || null, registeredAt: reg.registered_at,
  };
}

async function claimParts(claimId) {
  const parts = await all('SELECT * FROM warranty_claim_part WHERE claim_id=$1 ORDER BY id', [claimId]);
  const partsCost = parts.reduce((s, p) => s + Number(p.unit_cost) * p.qty, 0);
  return { parts: parts.map(p => ({ partId: p.part_id, name: p.part_name, qty: p.qty, unitCost: Number(p.unit_cost), ext: Number(p.unit_cost) * p.qty })), partsCost };
}

async function claimsForTrailer(trailerId) {
  const rows = await all('SELECT * FROM warranty_claim WHERE trailer_id=$1 ORDER BY opened_at DESC', [trailerId]);
  const out = [];
  for (const c of rows) {
    const { parts, partsCost } = await claimParts(c.id);
    out.push({
      id: c.id, status: c.status, issue: c.issue, openedAt: c.opened_at, resolvedAt: c.resolved_at, resolution: c.resolution,
      laborCost: Number(c.labor_cost), shippingCost: Number(c.shipping_cost), partsCost,
      total: partsCost + Number(c.labor_cost) + Number(c.shipping_cost), parts,
      attachments: await attachmentsFor('claim', c.id),
    });
  }
  return out;
}

// Full detail for one trailer: identity, build log, warranty, claims.
export async function trailerDetail(trailerId) {
  const t = await one(`SELECT t.*, m.name AS model, m.category AS type, c.name AS customer
                         FROM trailer t LEFT JOIN model m ON m.id=t.model_id LEFT JOIN customer c ON c.id=t.customer_id
                        WHERE t.id=$1`, [trailerId]);
  if (!t) return null;
  const steps = await all('SELECT * FROM trailer_build_step WHERE trailer_id=$1', [trailerId]);
  const reg = await one('SELECT * FROM warranty_registration WHERE trailer_id=$1', [trailerId]);
  const buildLog = BUILD_STEPS.map(s => {
    const done = steps.find(x => x.step === s.key);
    return { step: s.key, label: s.label, done: !!done, by: done?.employee_name || null, at: done?.completed_at || null, note: done?.note || null };
  });
  const maint = await all('SELECT * FROM maintenance_record WHERE trailer_id=$1 ORDER BY COALESCE(performed_on, created_at::date) DESC, id DESC', [trailerId]).catch(() => []);
  return {
    id: t.id, vin: t.vin, model: t.model, type: t.type, customer: t.customer, orderId: t.order_id,
    buildLog, warranty: warrantyStatus(reg), claims: await claimsForTrailer(trailerId),
    maintenance: maint.map(m => ({ id: m.id, item: m.item, performedOn: m.performed_on, note: m.note, source: m.source, submittedBy: m.submitted_by, createdAt: m.created_at })),
    regAttachments: await attachmentsFor('registration', t.id),
  };
}

export async function logBuildStep(trailerId, step, { employeeId, employeeName, note }, user) {
  if (!BUILD_STEPS.some(s => s.key === step)) throw new Error('unknown build step');
  if (!await one('SELECT id FROM trailer WHERE id=$1', [trailerId])) throw new Error('trailer not found');
  await q(`INSERT INTO trailer_build_step(trailer_id,step,employee_id,employee_name,note,logged_by,completed_at)
           VALUES($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT(trailer_id,step) DO UPDATE SET employee_id=$3,employee_name=$4,note=$5,logged_by=$6,completed_at=now()`,
    [trailerId, step, employeeId || null, employeeName || null, note || null, user?.id || null]);
  return trailerDetail(trailerId);
}

export async function registerWarranty(trailerId, { ownerName, ownerContact, termMonths, note }, user) {
  if (!await one('SELECT id FROM trailer WHERE id=$1', [trailerId])) throw new Error('trailer not found');
  await q(`INSERT INTO warranty_registration(trailer_id,owner_name,owner_contact,term_months,note,registered_by,registered_at)
           VALUES($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT(trailer_id) DO UPDATE SET owner_name=$2,owner_contact=$3,term_months=$4,note=$5,registered_by=$6`,
    [trailerId, ownerName || null, ownerContact || null, Number(termMonths) || DEFAULT_TERM, note || null, user?.id || null]);
  return trailerDetail(trailerId);
}

export async function openClaim(trailerId, { issue, laborCost, shippingCost, parts }, user) {
  if (!await one('SELECT id FROM trailer WHERE id=$1', [trailerId])) throw new Error('trailer not found');
  const id = 'WC-' + (5001 + (await all('SELECT id FROM warranty_claim', [])).length);
  await q(`INSERT INTO warranty_claim(id,trailer_id,issue,labor_cost,shipping_cost,opened_by) VALUES($1,$2,$3,$4,$5,$6)`,
    [id, trailerId, issue || null, Number(laborCost) || 0, Number(shippingCost) || 0, user?.id || null]);
  if (Array.isArray(parts)) {
    for (const p of parts) {
      let unit = Number(p.unitCost) || 0, name = p.name || null;
      if (p.partId) { const pm = await one('SELECT name,cost FROM part WHERE id=$1', [p.partId]); if (pm) { unit = Number(pm.cost); name = pm.name; } }
      await q(`INSERT INTO warranty_claim_part(claim_id,part_id,part_name,qty,unit_cost) VALUES($1,$2,$3,$4,$5)`,
        [id, p.partId || null, name, Number(p.qty) || 1, unit]);
    }
  }
  return id;
}

export async function resolveClaim(claimId, resolution) {
  const c = await one('SELECT trailer_id FROM warranty_claim WHERE id=$1', [claimId]);
  if (!c) throw new Error('claim not found');
  await q(`UPDATE warranty_claim SET status='Resolved', resolved_at=now(), resolution=$1 WHERE id=$2`, [resolution || null, claimId]);
  const t = await one('SELECT customer_id, vin FROM trailer WHERE id=$1', [c.trailer_id]);
  if (t) await notifyDealer(t.customer_id, 'claim', `Warranty claim ${claimId} (VIN ${t.vin}) was resolved.`, claimId);
  return claimId;
}

// Completed inventory (trailers with a VIN) grouped by dealer, with warranty status.
export async function byDealer() {
  const rows = await all(`SELECT c.name AS dealer, t.id, t.vin, t.serial, t.order_id, m.name AS model, m.category AS type,
                                 r.registered_at, r.term_months, r.sale_date, r.verification_status
                            FROM trailer t
                            LEFT JOIN customer c ON c.id=t.customer_id
                            LEFT JOIN model m ON m.id=t.model_id
                            LEFT JOIN warranty_registration r ON r.trailer_id=t.id
                           WHERE t.vin IS NOT NULL
                           ORDER BY c.name, t.serial`, []);
  const map = new Map();
  for (const r of rows) {
    const key = r.dealer || 'Unassigned';
    if (!map.has(key)) map.set(key, { dealer: key, trailers: [] });
    map.get(key).trailers.push({
      id: r.id, vin: r.vin, model: r.model, type: r.type, orderId: r.order_id,
      warranty: warrantyStatus(r.registered_at ? { registered_at: r.registered_at, term_months: r.term_months, sale_date: r.sale_date, verification_status: r.verification_status } : null),
    });
  }
  return [...map.values()];
}

export async function claimsList() {
  const rows = await all(`SELECT wc.*, t.vin, m.name AS model, cu.name AS dealer
                            FROM warranty_claim wc
                            LEFT JOIN trailer t ON t.id=wc.trailer_id
                            LEFT JOIN model m ON m.id=t.model_id
                            LEFT JOIN customer cu ON cu.id=t.customer_id
                           ORDER BY wc.opened_at DESC`, []);
  const out = [];
  for (const c of rows) {
    const { partsCost } = await claimParts(c.id);
    out.push({
      id: c.id, trailerId: c.trailer_id, vin: c.vin, model: c.model, dealer: c.dealer,
      status: c.status, issue: c.issue, openedAt: c.opened_at,
      total: partsCost + Number(c.labor_cost) + Number(c.shipping_cost),
    });
  }
  return out;
}

// Warranty cost rollups: totals + by model (with claim rate per units built) + by dealer +
// by part — the quality feedback loop: which model, and which component, generates the cost.
export async function summary() {
  // Every claim with its full cost (labor + shipping + parts) and its trailer's model/dealer.
  const claims = await all(`
    SELECT wc.id, wc.status,
           (wc.labor_cost + wc.shipping_cost
            + COALESCE((SELECT SUM(qty * unit_cost) FROM warranty_claim_part WHERE claim_id = wc.id), 0)) AS cost,
           COALESCE(m.name, '—') AS model, COALESCE(cu.name, '—') AS dealer
      FROM warranty_claim wc
      LEFT JOIN trailer t ON t.id = wc.trailer_id
      LEFT JOIN model m ON m.id = t.model_id
      LEFT JOIN customer cu ON cu.id = t.customer_id`, []);
  // Units built per model — the denominator for a claim RATE (claims per trailer shipped).
  const unitRows = await all(`SELECT COALESCE(m.name, '—') AS model, COUNT(*)::int AS units
                                FROM trailer t LEFT JOIN model m ON m.id=t.model_id
                               WHERE t.vin IS NOT NULL GROUP BY COALESCE(m.name, '—')`, []).catch(() => []);
  const unitsByModel = Object.fromEntries(unitRows.map(r => [r.model, Number(r.units)]));
  let totalCost = 0, openClaims = 0;
  const byModel = {}, byDealer = {};
  for (const c of claims) {
    const cost = Number(c.cost) || 0;
    totalCost += cost;
    if (c.status === 'Open') openClaims++;
    (byModel[c.model] = byModel[c.model] || { model: c.model, claims: 0, cost: 0 }).claims++;
    byModel[c.model].cost += cost;
    byDealer[c.dealer] = (byDealer[c.dealer] || 0) + cost;
  }
  // Which parts fail: frequency (distinct claims), quantity consumed, and dollars.
  const byPart = (await all(`
    SELECT COALESCE(part_id, part_name, '—') AS key, MAX(COALESCE(part_name, part_id)) AS name, MAX(part_id) AS part_id,
           COUNT(DISTINCT claim_id)::int AS claims, SUM(qty)::int AS qty, COALESCE(SUM(qty * unit_cost), 0) AS cost
      FROM warranty_claim_part GROUP BY COALESCE(part_id, part_name, '—') ORDER BY cost DESC`, []).catch(() => []))
    .map(r => ({ partId: r.part_id, name: r.name, claims: r.claims, qty: Number(r.qty) || 0, cost: Number(r.cost) || 0 }));
  return {
    totalClaims: claims.length, openClaims, totalCost,
    byModel: Object.values(byModel).map(x => {
      const units = unitsByModel[x.model] || 0;
      return { model: x.model, claims: x.claims, cost: x.cost, avgCost: x.claims ? x.cost / x.claims : 0,
               unitsBuilt: units, claimRatePct: units > 0 ? (x.claims / units) * 100 : null };
    }).sort((a, b) => b.cost - a.cost),
    byDealer: Object.entries(byDealer).map(([dealer, cost]) => ({ dealer, cost })).sort((a, b) => b.cost - a.cost),
    byPart,
  };
}

// Count of open claims — used by the Action Inbox.
export async function openClaimCount() {
  const r = await one(`SELECT COUNT(*)::int AS n FROM warranty_claim WHERE status='Open'`, []).catch(() => null);
  return r ? Number(r.n) : 0;
}
