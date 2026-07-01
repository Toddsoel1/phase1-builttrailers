// Public warranty-registration portal. Used by the unauthenticated /register page
// so dealerships or end-user owners can register a trailer at the time of sale,
// submit warranty claims, and log maintenance — all keyed by VIN. Submissions land
// as "pending" for internal staff to verify against the uploaded proof of sale.
import { all, one, q } from './db.js';
import { notifyDealer } from './dealernotify.js';
import { sendWarrantyWelcome } from './email.js';
import { extractBuyersOrder } from './ocr.js';
import { putDataUrl } from './storage.js';

const REG_WINDOW_DAYS = 15;       // dealer must register within 15 days of sale
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

// Decode a base64 data URL and store it (R2 in prod, local disk in dev) — returns the
// opaque storage ref saved in the DB, or null when there's no data URL to store.
async function saveUpload(prefix, dataUrl) {
  return putDataUrl(prefix, dataUrl, { maxBytes: MAX_UPLOAD, tooLargeMsg: 'Proof-of-sale file is too large (max 10 MB).' });
}

// Save a list of attachments (photos / video / receipts) against a claim or
// registration. Each item is { dataUrl, name, kind }. Returns how many saved.
export async function saveAttachments(entityType, entityId, items, by) {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items.slice(0, 10)) {
    if (!it || typeof it.dataUrl !== 'string' || !it.dataUrl.startsWith('data:')) continue;
    const ct = (/^data:([^;]+)/.exec(it.dataUrl) || [])[1] || '';
    const kind = it.kind || (ct.startsWith('video') ? 'video' : ct.startsWith('image') ? 'photo' : 'document');
    let filePath;
    try { filePath = await saveUpload(`${entityType}-${entityId}`, it.dataUrl); } catch { continue; }
    if (!filePath) continue;
    await q(`INSERT INTO attachment(entity_type,entity_id,kind,file_path,original_name,content_type,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [entityType, String(entityId), kind, filePath, it.name || null, ct || null, by || null]);
    n++;
  }
  return n;
}
export async function attachmentsFor(entityType, entityId) {
  return (await all('SELECT id,kind,file_path,original_name,created_at FROM attachment WHERE entity_type=$1 AND entity_id=$2 ORDER BY id', [entityType, String(entityId)]).catch(() => []))
    .map(a => ({ id: a.id, kind: a.kind, path: a.file_path, name: a.original_name, at: a.created_at }));
}

// ---- document library (manuals, spec sheets, warranty terms) ----
export async function addDocument({ title, modelId, category, dataUrl }, by) {
  if (!title) throw new Error('A title is required.');
  if (!dataUrl || !dataUrl.startsWith('data:')) throw new Error('Please choose a file.');
  const filePath = await saveUpload('doc', dataUrl);
  if (!filePath) throw new Error('Could not save the file.');
  const ct = (/^data:([^;]+)/.exec(dataUrl) || [])[1] || null;
  const r = await one(`INSERT INTO document(title,model_id,category,file_path,content_type,uploaded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [title, modelId || null, category || null, filePath, ct, by || null]);
  return { id: r.id };
}
// Official BUILT documents bundled with the app (public/docs) — always present in the
// library, downloadable directly, and not deletable. Admin-uploaded documents follow.
const BUILTIN_DOCS = [
  { id: 'warranty-policy',      title: 'Limited Warranty Policy',      category: 'Warranty',    url: '/docs/BUILT-Trailers-Limited-Warranty-Policy.docx',      builtin: true },
  { id: 'maintenance-schedule', title: 'Routine Maintenance Schedule', category: 'Maintenance', url: '/docs/BUILT-Trailers-Routine-Maintenance-Schedule.docx', builtin: true },
];
export async function listDocuments() {
  const db = (await all(`SELECT d.id,d.title,d.category,d.model_id,m.name AS model,d.created_at
                       FROM document d LEFT JOIN model m ON m.id=d.model_id
                      ORDER BY d.category NULLS FIRST, d.title`, []).catch(() => []))
    .map(d => ({ id: d.id, title: d.title, category: d.category, modelId: d.model_id, model: d.model, at: d.created_at }));
  return [...BUILTIN_DOCS, ...db];
}
export async function getDocumentPath(id) {
  return one(`SELECT file_path AS path, content_type AS ct FROM document WHERE id=$1`, [id]);
}
export async function deleteDocument(id) { await q(`DELETE FROM document WHERE id=$1`, [id]); return { ok: true }; }

export async function submitRegistration(data) {
  const { vin, ownerName, saleDate, warrantyAddress, city, state, zip, email, phone, sellingDealer,
          smsOptIn, emailOptIn, proofOfSale, source, termMonths, dealerCustomerId, attachments } = data || {};
  if (!vin) throw new Error('VIN is required.');
  if (!ownerName) throw new Error('Owner full name is required.');
  if (!saleDate) throw new Error('Date of purchase is required.');
  if (!email && !phone) throw new Error('An email or phone number is required.');
  const t = await one(`SELECT id, customer_id FROM trailer WHERE upper(vin)=upper($1)`, [String(vin).trim()]);
  if (!t) throw new Error('That VIN was not found. Please check the 17-character VIN on your trailer.');

  const hasProof = typeof proofOfSale === 'string' && proofOfSale.startsWith('data:');
  const proofPath = hasProof ? await saveUpload(t.id, proofOfSale) : null;
  const w15 = within15(saleDate);

  // OCR the buyer's order/invoice (when one is attached): confirm the sale date and
  // capture sale price + accessories (staff-only margin intel) with no manual step.
  // Returns null when OCR is unavailable or unreadable — we just fall back to manual.
  let ocr = null;
  if (hasProof) { try { ocr = await extractBuyersOrder(proofOfSale); } catch (e) { console.warn('OCR:', e.message); } }
  const enteredDate = String(saleDate).slice(0, 10);
  const dateConfirmed = !!(ocr?.saleDate && ocr.saleDate === enteredDate);

  // Self-validation: auto-verify within the 15-day window when EITHER the VIN belongs
  // to the submitting dealer (we already know which VINs went to whom) OR the uploaded
  // document's date matches what was entered. Anything we can't confirm stays pending,
  // so dealers and owners are never blocked at submission time.
  const vinMatchesDealer = source === 'dealer' && dealerCustomerId && t.customer_id && String(t.customer_id) === String(dealerCustomerId);
  const status = (w15 === true && (vinMatchesDealer || dateConfirmed)) ? 'verified' : 'pending';

  await q(`INSERT INTO warranty_registration
      (trailer_id, owner_name, owner_contact, registered_at, term_months, email, phone, warranty_address, city, state, zip,
       sale_date, selling_dealer, sms_opt_in, email_opt_in, proof_of_sale, verification_status, within_15_days, source, submitted_by,
       sale_price, accessories, ocr_sale_date)
      VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT(trailer_id) DO UPDATE SET owner_name=$2, owner_contact=$3, term_months=$4, email=$5, phone=$6,
        warranty_address=$7, city=$8, state=$9, zip=$10, sale_date=$11, selling_dealer=$12, sms_opt_in=$13, email_opt_in=$14,
        proof_of_sale=COALESCE($15, warranty_registration.proof_of_sale), verification_status=$16,
        within_15_days=$17, source=$18, submitted_by=$19,
        sale_price=COALESCE($20, warranty_registration.sale_price),
        accessories=COALESCE($21, warranty_registration.accessories),
        ocr_sale_date=COALESCE($22, warranty_registration.ocr_sale_date)`,
    [t.id, ownerName, phone || email || null, Number(termMonths) || 12, email || null, phone || null, warrantyAddress || null,
     city || null, state || null, zip || null, saleDate, sellingDealer || null, !!smsOptIn, !!emailOptIn, proofPath,
     status, w15, source || 'owner', ownerName, ocr?.salePrice ?? null, ocr?.accessories ?? null, ocr?.saleDate ?? null]);

  // NOTE: opt-in delivery of the maintenance schedule / T&Cs / app link is captured here;
  // SMS uses the existing Twilio path, email delivery needs an email provider (flagged).
  await saveAttachments('registration', t.id, attachments, ownerName);
  return { ok: true, within15: w15, status, autoVerified: status === 'verified', dateConfirmed };
}

export async function submitPublicClaim(data) {
  const { vin, issue, submittedBy, contact, attachments } = data || {};
  if (!vin) throw new Error('VIN is required.');
  if (!issue) throw new Error('Please describe the issue.');
  const t = await one(`SELECT id FROM trailer WHERE upper(vin)=upper($1)`, [String(vin).trim()]);
  if (!t) throw new Error('That VIN was not found.');
  const id = 'WC-' + (5001 + (await all('SELECT id FROM warranty_claim', [])).length);
  await q(`INSERT INTO warranty_claim(id,trailer_id,issue,source,submitted_by,contact) VALUES($1,$2,$3,'portal',$4,$5)`,
    [id, t.id, issue, submittedBy || null, contact || null]);
  const photos = await saveAttachments('claim', id, attachments, submittedBy);
  return { id, attachments: photos };
}

export async function submitMaintenance(data) {
  const { vin, item, performedOn, note, mileage, parts, submittedBy } = data || {};
  if (!vin || !item) throw new Error('VIN and a maintenance item are required.');
  const t = await one(`SELECT id FROM trailer WHERE upper(vin)=upper($1)`, [String(vin).trim()]);
  if (!t) throw new Error('That VIN was not found.');
  await q(`INSERT INTO maintenance_record(trailer_id,item,performed_on,note,mileage,parts,source,submitted_by) VALUES($1,$2,$3,$4,$5,$6,'portal',$7)`,
    [t.id, item, performedOn || null, note || null, mileage || null, parts || null, submittedBy || null]);
  return { ok: true };
}

// ---- internal staff review ----
export async function pendingRegistrations() {
  const rows = await all(`SELECT r.trailer_id, r.owner_name, r.email, r.phone, r.warranty_address, r.city, r.state, r.zip, r.sale_date,
                                 r.selling_dealer, r.sms_opt_in, r.email_opt_in, r.proof_of_sale, r.within_15_days,
                                 r.registered_at, r.source, r.sale_price, r.accessories, r.ocr_sale_date, t.vin, m.name AS model, m.price AS our_price, c.name AS dealer
                            FROM warranty_registration r
                            JOIN trailer t ON t.id=r.trailer_id
                            LEFT JOIN model m ON m.id=t.model_id
                            LEFT JOIN customer c ON c.id=t.customer_id
                           WHERE r.verification_status='pending'
                           ORDER BY r.registered_at DESC`, []);
  return rows.map(r => ({
    trailerId: r.trailer_id, vin: r.vin, model: r.model, dealer: r.dealer, ownerName: r.owner_name,
    email: r.email, phone: r.phone, address: r.warranty_address, city: r.city, state: r.state, zip: r.zip,
    saleDate: r.sale_date, sellingDealer: r.selling_dealer,
    smsOptIn: r.sms_opt_in, emailOptIn: r.email_opt_in, proofOfSale: r.proof_of_sale, within15: r.within_15_days,
    registeredAt: r.registered_at, source: r.source,
    // Built Trailers staff only — never exposed to dealer/owner endpoints
    salePrice: r.sale_price != null ? Number(r.sale_price) : null, accessories: r.accessories || null, ourPrice: Number(r.our_price || 0),
    ocrSaleDate: r.ocr_sale_date || null, dateConfirmed: !!(r.ocr_sale_date && r.sale_date && String(r.ocr_sale_date).slice(0, 10) === String(r.sale_date).slice(0, 10)),
  }));
}

export async function reviewRegistration(trailerId, decision, extras = {}) {
  if (!await one('SELECT trailer_id FROM warranty_registration WHERE trailer_id=$1', [trailerId])) throw new Error('registration not found');
  const status = decision === 'approve' ? 'verified' : 'rejected';
  // Capture margin intel (sale price + accessories) read from the buyer's order — staff only.
  await q(`UPDATE warranty_registration SET verification_status=$1,
             sale_price=COALESCE($2, sale_price), accessories=COALESCE($3, accessories) WHERE trailer_id=$4`,
    [status, extras.salePrice != null && extras.salePrice !== '' ? Number(extras.salePrice) : null, extras.accessories || null, trailerId]);
  const t = await one('SELECT customer_id, vin FROM trailer WHERE id=$1', [trailerId]);
  if (t) await notifyDealer(t.customer_id, 'registration', `Warranty registration for VIN ${t.vin} was ${status === 'verified' ? 'verified' : 'rejected'}.`, t.vin);
  // Opt-in welcome email once the warranty is verified (no-ops until RESEND_API_KEY is set).
  if (status === 'verified' && t) {
    const reg = await one('SELECT owner_name, email, email_opt_in FROM warranty_registration WHERE trailer_id=$1', [trailerId]);
    if (reg?.email && reg.email_opt_in) {
      const m = await one('SELECT m.name AS model FROM trailer tr LEFT JOIN model m ON m.id=tr.model_id WHERE tr.id=$1', [trailerId]);
      try { await sendWarrantyWelcome({ email: reg.email, ownerName: reg.owner_name, vin: t.vin, model: m?.model }); } catch (e) { console.warn('welcome email:', e.message); }
    }
  }
  return { status };
}

export async function pendingRegistrationCount() {
  const r = await one(`SELECT COUNT(*)::int AS n FROM warranty_registration WHERE verification_status='pending'`, []).catch(() => null);
  return r ? Number(r.n) : 0;
}

// Built Trailers staff only: dealer-margin intelligence captured from buyers' orders.
// Compares each model's avg retail sale price (what dealers sold for) to our price
// (what dealers pay us) and tallies accessory frequency. Never exposed to dealers/owners.
export async function marginReport() {
  const byModel = await all(`SELECT m.name AS model, m.price AS our_price,
                                    COUNT(r.sale_price)::int AS n, AVG(r.sale_price) AS avg_sale,
                                    MIN(r.sale_price) AS min_sale, MAX(r.sale_price) AS max_sale
                               FROM warranty_registration r
                               JOIN trailer t ON t.id=r.trailer_id JOIN model m ON m.id=t.model_id
                              WHERE r.sale_price IS NOT NULL
                              GROUP BY m.name, m.price ORDER BY m.name`, []).catch(() => []);
  const accRows = await all(`SELECT accessories FROM warranty_registration WHERE accessories IS NOT NULL AND accessories<>''`, []).catch(() => []);
  const accCount = {};
  for (const row of accRows)
    for (const a of String(row.accessories).split(/[,\n;]+/).map(s => s.trim()).filter(Boolean))
      accCount[a.toLowerCase()] = (accCount[a.toLowerCase()] || 0) + 1;
  // By dealer: who marks our trailers up the most (avg over their model mix).
  const byDealer = await all(`SELECT COALESCE(c.name, r.selling_dealer, '—') AS dealer,
                                     COUNT(r.sale_price)::int AS n,
                                     AVG(r.sale_price) AS avg_sale, AVG(r.sale_price - m.price) AS avg_margin,
                                     SUM(r.sale_price - m.price) AS total_margin
                                FROM warranty_registration r
                                JOIN trailer t ON t.id=r.trailer_id JOIN model m ON m.id=t.model_id
                                LEFT JOIN customer c ON c.id=t.customer_id
                               WHERE r.sale_price IS NOT NULL
                               GROUP BY COALESCE(c.name, r.selling_dealer, '—')
                               ORDER BY total_margin DESC NULLS LAST`, []).catch(() => []);
  // Over time: monthly trend (sale date; falls back to when it was registered).
  const byMonth = await all(`SELECT to_char(COALESCE(r.sale_date, r.registered_at::date), 'YYYY-MM') AS month,
                                    COUNT(r.sale_price)::int AS n,
                                    AVG(r.sale_price) AS avg_sale, AVG(r.sale_price - m.price) AS avg_margin,
                                    SUM(r.sale_price - m.price) AS total_margin
                               FROM warranty_registration r
                               JOIN trailer t ON t.id=r.trailer_id JOIN model m ON m.id=t.model_id
                              WHERE r.sale_price IS NOT NULL
                              GROUP BY 1 ORDER BY 1`, []).catch(() => []);
  return {
    byModel: byModel.map(r => {
      const our = Number(r.our_price) || 0, avg = Number(r.avg_sale) || 0;
      return { model: r.model, ourPrice: our, n: r.n, avgSale: avg, minSale: Number(r.min_sale) || 0, maxSale: Number(r.max_sale) || 0,
        dealerMargin: avg - our, dealerMarginPct: our > 0 ? (avg - our) / avg : null };
    }),
    byDealer: byDealer.map(r => ({ dealer: r.dealer, n: r.n, avgSale: Number(r.avg_sale) || 0,
      avgMargin: Number(r.avg_margin) || 0, totalMargin: Number(r.total_margin) || 0 })),
    byMonth: byMonth.map(r => ({ month: r.month, n: r.n, avgSale: Number(r.avg_sale) || 0,
      avgMargin: Number(r.avg_margin) || 0, totalMargin: Number(r.total_margin) || 0 })),
    accessories: Object.entries(accCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };
}
