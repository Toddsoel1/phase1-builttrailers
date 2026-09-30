// Historical trailer import — one-time, reviewed load of the pre-app VIN/MSO/invoice log.
// Hard wall from live records: writes ONLY historical_trailer, a sibling of trailer with no
// shared write path. Never touches Production Flow, VIN labels, or the MSO certificate counter.
import zlib from 'node:zlib';
import { q, all, one } from './db.js';

// ---- minimal .xlsx reader (zip + sheet XML; no dependency) ----
function zipEntries(buf) {
  // End-of-central-directory: scan the tail for PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/^\//, '');
    entries[name] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return {
    read(name) {
      const e = entries[name];
      if (!e) return null;
      const nl = buf.readUInt16LE(e.localOff + 26), xl = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + nl + xl;
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported zip compression (method ${e.method}).`);
    },
  };
}

const unesc = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const tText = (xml) => [...String(xml).matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => unesc(m[1])).join('');
const colIdx = (ref) => { let n = 0; for (const ch of ref) { if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64); else break; } return n - 1; };

// Returns rows of cells: { s: display string, num: number|null (raw numeric value) }
export function readSheet(buf, wantSheetName) {
  const z = zipEntries(buf);
  const wb = z.read('xl/workbook.xml');
  if (!wb) throw new Error('Not an .xlsx workbook (xl/workbook.xml missing).');
  const sheets = [...wb.toString('utf8').matchAll(/<(?:\w+:)?sheet\s[^>]*?\/>/g)].map(m => {
    const name = /name="([^"]*)"/.exec(m[0])?.[1] || '';
    const rid = /r:id="([^"]*)"/.exec(m[0])?.[1] || '';
    return { name: unesc(name), rid };
  });
  const hit = sheets.find(s => s.name.trim().toLowerCase() === wantSheetName.toLowerCase());
  if (!hit) throw new Error(`This workbook has no "${wantSheetName}" tab (found: ${sheets.map(s => s.name).join(', ') || 'none'}). Upload the cleaned log — only its Import Ready tab is ever loaded.`);
  const rels = z.read('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const rel = [...rels.matchAll(/<Relationship\s[^>]*?\/>/g)].map(m => ({
    id: /Id="([^"]*)"/.exec(m[0])?.[1], target: /Target="([^"]*)"/.exec(m[0])?.[1],
  })).find(r => r.id === hit.rid);
  const target = (rel?.target || 'worksheets/sheet1.xml').replace(/^\/?(xl\/)?/, '');
  const sheetXml = z.read('xl/' + target)?.toString('utf8');
  if (!sheetXml) throw new Error(`Worksheet ${target} missing from the workbook.`);
  const sstXml = z.read('xl/sharedStrings.xml')?.toString('utf8') || '';
  const sst = [...sstXml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => tText(m[1]));

  const rows = [];
  for (const rm of sheetXml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<(?:\w+:)?c\b([^>]*?)\/>|<(?:\w+:)?c\b([^>]*?)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const attrs = cm[1] ?? cm[2] ?? '', inner = cm[3] || '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const idx = ref ? colIdx(ref) : cells.length;
      const type = /t="(\w+)"/.exec(attrs)?.[1] || '';
      let s = '', num = null;
      if (type === 'inlineStr') s = tText(inner);
      else {
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
        if (v !== undefined) {
          if (type === 's') s = sst[Number(v)] ?? '';
          else if (type === 'str') s = unesc(v);
          else if (type === 'b') s = v === '1' ? 'Y' : 'N';
          else if (type === 'e') s = '';
          else { num = Number(v); s = Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100); }
        }
      }
      cells[idx] = { s: s.trim(), num };
    }
    rows.push(cells);
  }
  return rows;
}

// ---- field mapping (spec §4) ----
const FIELD_BY_HEADER = [ // [normalized-header prefix, field] — longest/most specific first
  ['finalvin', 'vin'], ['tempvin', null], ['vinlabelprinted', null],
  ['msoprintdate', 'mso_issued_date'], ['mso', 'mso_number'],
  ['customeraddress', 'customer_address'], ['customer', 'customer_name'],
  ['shipdate', 'ship_date'], ['deliverydate', 'delivery_date'], ['deliveryreceipt', 'delivery_confirmed'],
  ['invoicedate', 'invoice_date'], ['invoicedue', 'invoice_due'], ['invoice', 'invoice_no'],
  ['amtdue', 'amt_due'], ['amtreceived', 'amt_received'],
  ['paymentdates', 'payment_dates'], ['multiplepayments', 'multi_payment'], ['paymenttype', 'payment_type'],
  ['model', 'model_text'], ['notes', 'notes'],
];
const DATE_FIELDS = new Set(['mso_issued_date', 'ship_date', 'delivery_date', 'invoice_date', 'invoice_due', 'payment_dates']);
const serialToISO = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function mapRows(rows) {
  if (!rows.length) throw new Error('The Import Ready tab is empty.');
  const headers = rows[0].map(c => (c?.s || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const fieldOf = headers.map(h => { const hitEntry = FIELD_BY_HEADER.find(([p]) => h.startsWith(p)); return hitEntry ? hitEntry[1] : undefined; });
  if (!fieldOf.includes('vin')) throw new Error('Could not find the "Final VIN" column — is this the cleaned Import Ready layout?');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    if (!cells.some(c => c && c.s !== '')) continue; // fully blank line
    const rec = { _row: i + 1 }; // 1-based spreadsheet row number
    fieldOf.forEach((f, ci) => {
      if (!f) return;
      const cell = cells[ci];
      let v = cell?.s || '';
      if (cell?.num != null && DATE_FIELDS.has(f) && cell.num > 20000 && cell.num < 60000) v = serialToISO(cell.num);
      if (f === 'delivery_confirmed') rec[f] = v ? /^y/i.test(v) : null;
      else if (f === 'multi_payment') rec[f] = /^y/i.test(v);
      else rec[f] = v;
    });
    rec.vin = String(rec.vin || '').toUpperCase().replace(/\s+/g, '');
    out.push(rec);
  }
  return out;
}

// ---- validation (spec §5) + preview/commit/rollback ----
export async function previewImport(buf, filename, byName) {
  const mapped = mapRows(readSheet(buf, 'Import Ready'));
  const counts = {};
  for (const r of mapped) counts[r.vin] = (counts[r.vin] || 0) + 1;
  const [live, hist, models] = await Promise.all([
    all('SELECT vin FROM trailer WHERE vin IS NOT NULL', []),
    all('SELECT vin FROM historical_trailer', []),
    all('SELECT id FROM model', []),
  ]);
  const taken = new Set([...live.map(r => r.vin), ...hist.map(r => r.vin)].map(v => String(v).toUpperCase()));
  const modelById = new Map(models.map(m => [String(m.id).toUpperCase(), m.id]));

  const ready = [], errors = [];
  const warn = { noCustomer: 0, unmatchedModel: 0, splitPayment: 0 };
  const unmatchedModels = new Set();
  for (const r of mapped) {
    if (!VIN_RE.test(r.vin)) { errors.push({ row: r._row, vin: r.vin || '(blank)', reason: 'VIN is not a valid 17-character VIN (letters I, O, Q are never used)' }); continue; }
    if (counts[r.vin] > 1) { errors.push({ row: r._row, vin: r.vin, reason: `VIN appears ${counts[r.vin]}× in this file — resolve which record is authoritative first` }); continue; }
    if (taken.has(r.vin)) { errors.push({ row: r._row, vin: r.vin, reason: 'VIN already exists in the app (live or previously imported) — skipped to prevent double-import' }); continue; }
    const flags = [];
    if (!r.customer_name) { flags.push('no_customer'); warn.noCustomer++; }
    r.model_id = modelById.get(String(r.model_text || '').toUpperCase()) || null;
    if (!r.model_id && r.model_text) { flags.push('unmatched_model'); warn.unmatchedModel++; unmatchedModels.add(r.model_text); }
    if (r.multi_payment) { flags.push('split_payment'); warn.splitPayment++; }
    r.flags = flags;
    ready.push(r);
  }
  const summary = {
    filename, total: mapped.length, ready: ready.length, errorCount: errors.length,
    errors: errors.slice(0, 200), warnings: warn,
    unmatchedModels: [...unmatchedModels].sort().slice(0, 80),
    modelMatched: ready.filter(r => r.model_id).length,
  };
  const b = await one(
    `INSERT INTO history_import_batch(filename, status, row_count, summary, rows_json, created_by)
     VALUES ($1,'preview',$2,$3,$4,$5) RETURNING id`,
    [filename, ready.length, JSON.stringify(summary), JSON.stringify(ready), byName]);
  return { batchId: b.id, ...summary };
}

async function loadBatch(id) {
  const b = await one('SELECT * FROM history_import_batch WHERE id=$1', [id]);
  if (!b) throw new Error('Import batch not found.');
  return b;
}

export async function commitBatch(id, byName) {
  const b = await loadBatch(id);
  if (b.status !== 'preview') throw new Error(`This batch is ${b.status} — only a previewed batch can be imported.`);
  const rows = JSON.parse(b.rows_json || '[]');
  const taken = new Set((await all(`SELECT vin FROM trailer WHERE vin IS NOT NULL UNION SELECT vin FROM historical_trailer`, [])).map(r => String(r.vin).toUpperCase()));
  const clash = rows.filter(r => taken.has(r.vin));
  if (clash.length) throw new Error(`${clash.length} VIN(s) were imported by another batch since this preview (e.g. ${clash[0].vin}). Re-upload the file for a fresh preview.`);
  try {
    for (const r of rows) {
      await q(`INSERT INTO historical_trailer(vin,batch_id,model_text,model_id,mso_number,mso_issued_date,customer_name,customer_address,
                 ship_date,delivery_date,delivery_confirmed,invoice_no,invoice_date,invoice_due,amt_due,amt_received,payment_dates,
                 multi_payment,payment_type,notes,flags)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [r.vin, id, r.model_text || null, r.model_id || null, r.mso_number || null, r.mso_issued_date || null,
         r.customer_name || null, r.customer_address || null, r.ship_date || null, r.delivery_date || null,
         r.delivery_confirmed, r.invoice_no || null, r.invoice_date || null, r.invoice_due || null,
         r.amt_due || null, r.amt_received || null, r.payment_dates || null, !!r.multi_payment,
         r.payment_type || null, r.notes || null, JSON.stringify(r.flags || [])]);
    }
  } catch (e) {
    await q('DELETE FROM historical_trailer WHERE batch_id=$1', [id]); // no half-imported batches
    throw new Error('Import failed mid-batch and was fully undone: ' + e.message, { cause: e });
  }
  await q(`UPDATE history_import_batch SET status='imported', imported_at=now(), imported_by=$2 WHERE id=$1`, [id, byName]);
  return { imported: rows.length };
}

export async function rollbackBatch(id, byName) {
  const b = await loadBatch(id);
  if (b.status !== 'imported') throw new Error(`Only an imported batch can be rolled back (this one is ${b.status}).`);
  await q('DELETE FROM historical_trailer WHERE batch_id=$1', [id]);
  await q(`UPDATE history_import_batch SET status='rolled_back', rolled_back_at=now(), rolled_back_by=$2 WHERE id=$1`, [id, byName]);
  return { removed: b.row_count };
}

export async function discardBatch(id) {
  const b = await loadBatch(id);
  if (b.status !== 'preview') throw new Error('Only an un-imported preview can be discarded.');
  await q(`UPDATE history_import_batch SET status='discarded', rows_json=NULL WHERE id=$1`, [id]);
  return { ok: true };
}

export async function listBatches() {
  const rows = await all(`SELECT id, filename, status, row_count, summary, created_by, created_at, imported_at, imported_by, rolled_back_at, rolled_back_by
                            FROM history_import_batch ORDER BY id DESC LIMIT 25`, []);
  return rows.map(r => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null, rows_json: undefined }));
}

export async function records({ q: qs, batchId, limit = 100 } = {}) {
  const args = []; const where = [];
  if (qs) { args.push('%' + String(qs).replace(/[\\%_]/g, '\\$&') + '%'); where.push(`(vin ILIKE $${args.length} OR customer_name ILIKE $${args.length} OR model_text ILIKE $${args.length} OR mso_number ILIKE $${args.length} OR invoice_no ILIKE $${args.length})`); }
  if (batchId) { args.push(batchId); where.push(`batch_id=$${args.length}`); }
  args.push(Math.min(Number(limit) || 100, 500));
  const rows = await all(`SELECT * FROM historical_trailer ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY vin LIMIT $${args.length}`, args);
  return rows.map(r => ({ ...r, flags: r.flags ? JSON.parse(r.flags) : [] }));
}

export const searchHistorical = (like) =>
  all(`SELECT vin, model_text, model_id, customer_name, mso_number, invoice_no FROM historical_trailer
        WHERE vin ILIKE $1 OR customer_name ILIKE $1 OR mso_number ILIKE $1 OR invoice_no ILIKE $1 ORDER BY vin LIMIT 5`, [like]);
