// 📐 Engineering package — the professional BOM layer that lets one document drive the floor,
// purchasing, and inventory:
//   • BOM worksheet: every component with qty/uom/stage, unit + extended cost, vendor,
//     vendor part # and manufacturer part #.
//   • Cut list: each MADE part (weldment) carries cut items (sticks cut from stock); the model
//     cut list expands them by BOM qty and auto-numbers C01, C02, …
//   • Steel: estimated weight from published lb/ft per profile, and material yield — cuts are
//     packed into purchased stock lengths (first-fit-decreasing, 1/8" kerf) to count sticks.
//   • Welds: inches of weld per weldment and per trailer.
//   • Revisions: every structural BOM change bumps model.bom_rev and logs who/what/when, so a
//     printed worksheet can be checked against the current rev.
// The office owns the data (cut items, profiles, part numbers); demo rows seed only under
// SEED_DEMO so a fresh production database starts clean.
import { all, one, q } from './db.js';

// Published weights for the stock Built actually buys (HSS per AISC/steel tables, A513 tube).
// stock_length_ft = the stick length purchased; office-editable.
const STEEL_PROFILES = [
  ['HSS 2x2x3/16', 4.32, 24],
  ['HSS 2x3x3/16', 5.59, 24],
  ['HSS 2x4x3/16', 6.87, 24],
  ['HSS 3x3x3/16', 6.87, 24],
  ['HSS 3x3x1/4', 8.81, 24],
  ['HSS 3x4x1/4', 10.58, 24],
  ['HSS 4x4x1/4', 11.97, 24],
  ['Tube 1x2x14ga', 1.60, 24],
  ['Tube 2x2x14ga', 2.16, 24],
  ['Angle 2x2x3/16', 2.44, 20],
];
const KERF_IN = 0.125; // blade width lost per cut

// Demo cut items (SEED_DEMO only): teaching data so the screens show real math — the office
// replaces these with the real cut sheets.
const DEMO_CUTS = {
  'MAKE-FRM-G23TR': [
    ['Main rail', 'HSS 2x3x3/16', 306, 2, 18],
    ['Crossmember', 'HSS 2x2x3/16', 80, 5, 14],
    ['Rear crossmember', 'HSS 2x2x3/16', 96, 1, 16],
  ],
  'MAKE-TNG-G23TR': [
    ['Tongue tube', 'HSS 4x4x1/4', 84, 1, 28],
    ['Gusset plate, 3/16" HR', null, 12, 2, 20],
  ],
  'MAKE-FRM-GS20TAN': [
    ['Main rail', 'HSS 2x3x3/16', 264, 2, 18],
    ['Crossmember', 'HSS 2x2x3/16', 76, 4, 14],
  ],
};

export async function ensureEngineering() {
  for (const [profile, lb, stock] of STEEL_PROFILES)
    await q('INSERT INTO steel_profile(profile,lb_per_ft,stock_length_ft) VALUES($1,$2,$3) ON CONFLICT(profile) DO NOTHING', [profile, lb, stock]);
  if (process.env.SEED_DEMO !== '1') return;
  for (const [partId, cuts] of Object.entries(DEMO_CUTS)) {
    if (!await one('SELECT id FROM part WHERE id=$1', [partId])) continue;
    if (await one('SELECT id FROM cut_item WHERE part_id=$1', [partId])) continue; // office data wins
    let seq = 1;
    for (const [description, profile, lengthIn, qty, weldIn] of cuts)
      await q('INSERT INTO cut_item(part_id,seq,description,profile,length_in,qty,weld_in) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [partId, seq++, description, profile, lengthIn, qty, weldIn]);
  }
}

// ---- revisions ----------------------------------------------------------------------------
export async function bumpBomRev(modelId, change, userId) {
  const r = await one('UPDATE model SET bom_rev=COALESCE(bom_rev,1)+1 WHERE id=$1 RETURNING bom_rev', [modelId]);
  if (!r) return null;
  await q('INSERT INTO bom_revision(model_id,rev,change,changed_by) VALUES($1,$2,$3,$4)', [modelId, r.bom_rev, change, userId || null]);
  return r.bom_rev;
}

// ---- cut items (per made part) ------------------------------------------------------------
export async function addCut(partId, { description, profile, lengthIn, qty, weldIn }) {
  const p = await one('SELECT id, type FROM part WHERE id=$1', [partId]);
  if (!p) throw new Error('Part not found.');
  if (p.type !== 'M') throw new Error('Cut items belong to MADE parts (weldments) — this is a purchased part.');
  const d = String(description || '').trim();
  if (!d) throw new Error('Describe the cut (e.g. "Main rail").');
  if (!(Number(lengthIn) > 0)) throw new Error('Cut length (inches) must be positive.');
  const seq = Number((await one('SELECT COALESCE(MAX(seq),0)+1 AS s FROM cut_item WHERE part_id=$1', [partId])).s);
  const r = await one(`INSERT INTO cut_item(part_id,seq,description,profile,length_in,qty,weld_in)
                       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [partId, seq, d, String(profile || '').trim() || null, Number(lengthIn), Number(qty) || 1, Number(weldIn) || 0]);
  return { id: r.id, seq };
}
export async function updateCut(cutId, fields) {
  const cur = await one('SELECT * FROM cut_item WHERE id=$1', [cutId]);
  if (!cur) throw new Error('Cut item not found.');
  const v = (x, f) => fields[x] !== undefined ? fields[x] : cur[f];
  const lengthIn = Number(v('lengthIn', 'length_in'));
  if (!(lengthIn > 0)) throw new Error('Cut length (inches) must be positive.');
  await q(`UPDATE cut_item SET description=$1, profile=$2, length_in=$3, qty=$4, weld_in=$5 WHERE id=$6`,
    [String(v('description', 'description') || '').trim() || cur.description,
     fields.profile !== undefined ? (String(fields.profile || '').trim() || null) : cur.profile,
     lengthIn, Number(v('qty', 'qty')) || 1, Number(v('weldIn', 'weld_in')) || 0, cutId]);
  return { ok: true };
}
export async function deleteCut(cutId) {
  await q('DELETE FROM cut_item WHERE id=$1', [cutId]);
  return { ok: true };
}
export async function upsertProfile(profile, lbPerFt, stockLengthFt) {
  const p = String(profile || '').trim();
  if (!p) throw new Error('Profile name required.');
  await q(`INSERT INTO steel_profile(profile,lb_per_ft,stock_length_ft) VALUES($1,$2,$3)
           ON CONFLICT(profile) DO UPDATE SET lb_per_ft=EXCLUDED.lb_per_ft, stock_length_ft=EXCLUDED.stock_length_ft`,
    [p, Number(lbPerFt) || 0, Number(stockLengthFt) || 24]);
  return { ok: true };
}

// ---- the package --------------------------------------------------------------------------
const ftIn = totalIn => {
  const ft = Math.floor(totalIn / 12), inch = +(totalIn - ft * 12).toFixed(2);
  return ft ? `${ft}' ${inch}"` : `${inch}"`;
};

// First-fit-decreasing stick packing with kerf: how many purchased sticks a profile's cuts need.
// Cuts longer than the stock length can't be packed at all — they're counted separately as
// oversize (special-order lengths) and stay OUT of the stick count and yield math.
function packSticks(lengths, stockIn) {
  const fit = lengths.filter(l => l <= stockIn);
  const sticks = [];
  for (const len of fit.sort((a, b) => b - a)) {
    const i = sticks.findIndex(rem => rem >= len + KERF_IN || rem >= len);
    if (i >= 0) sticks[i] -= (len + KERF_IN);
    else sticks.push(stockIn - len - KERF_IN);
  }
  return { sticks: sticks.length, oversize: lengths.length - fit.length, fitIn: fit.reduce((s, l) => s + l, 0) };
}

export async function engineeringPackage(modelId) {
  const model = await one('SELECT id, name, category, price, COALESCE(bom_rev,1) AS bom_rev FROM model WHERE id=$1', [modelId]);
  if (!model) return null;

  const worksheet = await all(
    `SELECT b.part_id, b.qty, COALESCE(b.stage,'Build') AS stage, p.name, p.type, p.uom, p.cost,
            p.vendor_part_no, p.mfr_part_no, v.name AS vendor
       FROM bom_line b JOIN part p ON p.id=b.part_id LEFT JOIN vendor v ON v.id=p.vendor_id
      WHERE b.model_id=$1 ORDER BY COALESCE(b.stage,'Build'), p.type DESC, b.part_id`, [modelId]);
  const wsRows = worksheet.map(r => ({
    partId: r.part_id, name: r.name, type: r.type, stage: r.stage, qty: Number(r.qty), uom: r.uom,
    unitCost: Number(r.cost) || 0, extCost: +((Number(r.cost) || 0) * Number(r.qty)).toFixed(2),
    vendor: r.vendor || null, vendorPartNo: r.vendor_part_no || null, mfrPartNo: r.mfr_part_no || null,
  }));

  const labor = await all(`SELECT ws, hours, COALESCE(stage,'Build') AS stage FROM model_labor WHERE model_id=$1 ORDER BY ws`, [modelId]);

  // Cut list: made parts' cut items × BOM qty, numbered in order.
  const cutRows = await all(
    `SELECT b.qty AS bom_qty, p.id AS part_id, p.name AS part_name,
            c.id AS cut_id, c.seq, c.description, c.profile, c.length_in, c.qty AS cut_qty, c.weld_in
       FROM bom_line b JOIN part p ON p.id=b.part_id AND p.type='M'
       JOIN cut_item c ON c.part_id = p.id
      WHERE b.model_id=$1 ORDER BY p.id, c.seq, c.id`, [modelId]);
  const cutList = cutRows.map((r, i) => {
    const perTrailer = Number(r.cut_qty) * Number(r.bom_qty);
    return {
      no: 'C' + String(i + 1).padStart(2, '0'), cutId: r.cut_id,
      weldment: r.part_name, weldmentId: r.part_id,
      description: r.description, profile: r.profile,
      lengthIn: Number(r.length_in), length: ftIn(Number(r.length_in)),
      qtyPerAsm: Number(r.cut_qty), asmPerTrailer: Number(r.bom_qty), qtyPerTrailer: perTrailer,
      weldPerAsm: Number(r.weld_in), // per piece — the editor edits this raw value
      weldIn: +(Number(r.weld_in) * perTrailer).toFixed(1), // per trailer for this row
    };
  });

  // Steel summary per profile: total length, weight, sticks needed, and yield.
  const profiles = Object.fromEntries((await all('SELECT * FROM steel_profile', [])).map(p =>
    [p.profile, { lbPerFt: Number(p.lb_per_ft), stockFt: Number(p.stock_length_ft) }]));
  const byProfile = {};
  for (const c of cutList) {
    if (!c.profile) continue;
    const g = (byProfile[c.profile] ||= { lengths: [], totalIn: 0 });
    for (let i = 0; i < c.qtyPerTrailer; i++) g.lengths.push(c.lengthIn);
    g.totalIn += c.lengthIn * c.qtyPerTrailer;
  }
  const steel = Object.entries(byProfile).map(([profile, g]) => {
    const p = profiles[profile];
    const stockIn = p ? p.stockFt * 12 : null;
    const pack = stockIn ? packSticks(g.lengths, stockIn) : null;
    return {
      profile, cuts: g.lengths.length, totalIn: +g.totalIn.toFixed(1), totalFt: +(g.totalIn / 12).toFixed(1),
      lbPerFt: p ? p.lbPerFt : null,
      weightLb: p ? +((g.totalIn / 12) * p.lbPerFt).toFixed(1) : null,
      stockLengthFt: p ? p.stockFt : null,
      sticks: pack ? pack.sticks : null, oversize: pack ? pack.oversize : 0,
      yieldPct: pack && pack.sticks ? +((pack.fitIn / (pack.sticks * stockIn)) * 100).toFixed(1) : null,
    };
  }).sort((a, b) => (b.weightLb || 0) - (a.weightLb || 0));

  const weldByWeldment = {};
  for (const c of cutList) weldByWeldment[c.weldment] = +((weldByWeldment[c.weldment] || 0) + c.weldIn).toFixed(1);
  const weldTotalIn = +Object.values(weldByWeldment).reduce((s, w) => s + w, 0).toFixed(1);

  const revHistory = await all(
    `SELECT r.rev, r.change, r.created_at, u.name AS by FROM bom_revision r LEFT JOIN app_user u ON u.id=r.changed_by
      WHERE r.model_id=$1 ORDER BY r.rev DESC LIMIT 12`, [modelId]);

  return {
    model: { id: model.id, name: model.name, category: model.category, rev: Number(model.bom_rev) },
    worksheet: wsRows, labor,
    cutList, steel,
    welds: { totalIn: weldTotalIn, totalFt: +(weldTotalIn / 12).toFixed(1), byWeldment: weldByWeldment },
    revHistory,
    totals: {
      materialCost: +wsRows.reduce((s, r) => s + r.extCost, 0).toFixed(2),
      laborHours: +labor.reduce((s, l) => s + Number(l.hours), 0).toFixed(1),
      steelWeightLb: +steel.reduce((s, p) => s + (p.weightLb || 0), 0).toFixed(1),
      weldIn: weldTotalIn, cutCount: cutList.reduce((s, c) => s + c.qtyPerTrailer, 0),
    },
    profiles: Object.entries(profiles).map(([profile, p]) => ({ profile, lbPerFt: p.lbPerFt, stockLengthFt: p.stockFt })),
  };
}
