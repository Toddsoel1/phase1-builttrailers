// Public warranty-registration portal. Used by the unauthenticated /register page
// so dealerships or end-user owners can register a trailer at the time of sale,
// submit warranty claims, and log maintenance — all keyed by VIN. Submissions land
// as "pending" for internal staff to verify against the uploaded proof of sale.
import { all, one, q } from './db.js';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

const REG_WINDOW_DAYS = 15;       // dealer must register within 15 days of sale
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_UPLOAD = 10 * 1024 * 1024;

// Minimal public lookup: confirm a VIN exists and whether it's already registered.
// Deliberately returns no internal/customer data.
export async function publicTrailerLookup(vin) {
  const t = await one(`SELECT t.id, t.vin, m.name AS model FROM trailer t LEFT JOIN model m ON m.id=t.model_id WHERE upper(t.vin)=upper($1)`, [String(vin || '').trim()]);
  if (!t) return { found: false };
  const reg = await one(`SELECT verification_status FROM warranty_registration WHERE trailer_id=$1`, [t.id]);
  return { found: true, model: t.model, registered: !!reg, status: reg ? reg.verification_status : null };
}

function within15(saleDate) {
  if (!saleDate) return null;
  const days = Math.floor((Date.now() - new Date(saleDate).getTime()) / 86400000);
  return days >= 0 && days <= REG_WINDOW_DAYS;
}

// Decode a base64 data URL and save it; returns the stored path (or null).
async function saveUpload(trailerId, dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD) throw new Error('Proof-of-sale file is too large (max 10 MB).');
  const ext = (m[1].split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  await mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${trailerId}-${Date.now()}.${ext}`;
  await writeFile(path.join(UPLOAD_DIR, name), buf);
  return `${UPLOAD_DIR}/${name}`;
}

export async function submitRegistration(data) {
  const { vin, ownerName, saleDate, warrantyAddress, email, phone, sellingDealer,
          smsOptIn, emailOptIn, proofOfSale, source, termMonths, dealerCustomerId } = data || {};
  if (!vin) throw new Error('VIN is required.');
  if (!ownerName) throw new Error('Owner full name is required.');
  if (!saleDate) throw new Error('Date of purchase is required.');
  if (!email && !phone) throw new Error('An email or phone number is required.');
  const t = await one(`SELECT id, customer_id FROM trailer WHERE upper(vin)=upper($1)`, [String(vin).trim()]);
  if (!t) throw new Error('That VIN was not found. Please check the 17-character VIN on your trailer.');

  const proofPath = (typeof proofOfSale === 'string' && proofOfSale.startsWith('data:')) ? await saveUpload(t.id, proofOfSale) : null;
  const w15 = within15(saleDate);
  // Self-validation: a dealership registering one of its OWN VINs (we already know
  // which VINs were sold to whom) within the 15-day window is auto-verified — no
  // staff step. Everything the system can't confirm defaults to the manual queue,
  // so dealers and owners are never blocked at submission time.
  const vinMatchesDealer = source === 'dealer' && dealerCustomerId && t.customer_id && String(t.customer_id) === String(dealerCustomerId);
  const status = (vinMatchesDealer && w15 === true) ? 'verified' : 'pending';

  await q(`INSERT INTO warranty_registration
      (trailer_id, owner_name, owner_contact, registered_at, term_months, email, phone, warranty_address,
       sale_date, selling_dealer, sms_opt_in, email_opt_in, proof_of_sale, verification_status, within_15_days, source, submitted_by)
      VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$16,$13,$14,$15)
      ON CONFLICT(trailer_id) DO UPDATE SET owner_name=$2, owner_contact=$3, term_months=$4, email=$5, phone=$6,
        warranty_address=$7, sale_date=$8, selling_dealer=$9, sms_opt_in=$10, email_opt_in=$11,
        proof_of_sale=COALESCE($12, warranty_registration.proof_of_sale), verification_status=$16,
        within_15_days=$13, source=$14, submitted_by=$15`,
    [t.id, ownerName, phone || email || null, Number(termMonths) || 12, email || null, phone || null, warrantyAddress || null,
     saleDate, sellingDealer || null, !!smsOptIn, !!emailOptIn, proofPath, w15, source || 'owner', ownerName, status]);

  // NOTE: opt-in delivery of the maintenance schedule / T&Cs / app link is captured here;
  // SMS uses the existing Twilio path, email delivery needs an email provider (flagged).
  return { ok: true, within15: w15, status, autoVerified: status === 'verified' };
}

export async function submitPublicClaim(data) {
  const { vin, issue, submittedBy, contact } = data || {};
  if (!vin) throw new Error('VIN is required.');
  if (!issue) throw new Error('Please describe the issue.');
  const t = await one(`SELECT id FROM trailer WHERE upper(vin)=upper($1)`, [String(vin).trim()]);
  if (!t) throw new Error('That VIN was not found.');
  const id = 'WC-' + (5001 + (await all('SELECT id FROM warranty_claim', [])).length);
  await q(`INSERT INTO warranty_claim(id,trailer_id,issue,source,submitted_by,contact) VALUES($1,$2,$3,'portal',$4,$5)`,
    [id, t.id, issue, submittedBy || null, contact || null]);
  return { id };
}

export async function submitMaintenance(data) {
  const { vin, item, performedOn, note, submittedBy } = data || {};
  if (!vin || !item) throw new Error('VIN and a maintenance item are required.');
  const t = await one(`SELECT id FROM trailer WHERE upper(vin)=upper($1)`, [String(vin).trim()]);
  if (!t) throw new Error('That VIN was not found.');
  await q(`INSERT INTO maintenance_record(trailer_id,item,performed_on,note,source,submitted_by) VALUES($1,$2,$3,$4,'portal',$5)`,
    [t.id, item, performedOn || null, note || null, submittedBy || null]);
  return { ok: true };
}

// ---- internal staff review ----
export async function pendingRegistrations() {
  const rows = await all(`SELECT r.trailer_id, r.owner_name, r.email, r.phone, r.warranty_address, r.sale_date,
                                 r.selling_dealer, r.sms_opt_in, r.email_opt_in, r.proof_of_sale, r.within_15_days,
                                 r.registered_at, r.source, t.vin, m.name AS model, c.name AS dealer
                            FROM warranty_registration r
                            JOIN trailer t ON t.id=r.trailer_id
                            LEFT JOIN model m ON m.id=t.model_id
                            LEFT JOIN customer c ON c.id=t.customer_id
                           WHERE r.verification_status='pending'
                           ORDER BY r.registered_at DESC`, []);
  return rows.map(r => ({
    trailerId: r.trailer_id, vin: r.vin, model: r.model, dealer: r.dealer, ownerName: r.owner_name,
    email: r.email, phone: r.phone, address: r.warranty_address, saleDate: r.sale_date, sellingDealer: r.selling_dealer,
    smsOptIn: r.sms_opt_in, emailOptIn: r.email_opt_in, proofOfSale: r.proof_of_sale, within15: r.within_15_days,
    registeredAt: r.registered_at, source: r.source,
  }));
}

export async function reviewRegistration(trailerId, decision) {
  if (!await one('SELECT trailer_id FROM warranty_registration WHERE trailer_id=$1', [trailerId])) throw new Error('registration not found');
  const status = decision === 'approve' ? 'verified' : 'rejected';
  await q(`UPDATE warranty_registration SET verification_status=$1 WHERE trailer_id=$2`, [status, trailerId]);
  return { status };
}

export async function pendingRegistrationCount() {
  const r = await one(`SELECT COUNT(*)::int AS n FROM warranty_registration WHERE verification_status='pending'`, []).catch(() => null);
  return r ? Number(r.n) : 0;
}
