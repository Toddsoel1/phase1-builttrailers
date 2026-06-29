// Boat Trailer Builder — the reference catalog (Nautique boats + configurable options), the
// idempotent seeder, and the configurator engine (sizing, validation, pricing, BOM reconciliation,
// and submit). It sits ON TOP of the existing Boat-category base models: each boat maps to a base
// trailer (which already carries a full BOM), and the option choices contribute part deltas that
// net against that base BOM so a configured trailer consumes exactly its real parts.
//
// Money: every dollar figure (part cost + dealer price) seeds at 0 and is office-editable — the
// seeder preserves edited prices/costs (ON CONFLICT DO NOTHING) while keeping code-owned structure
// (groups, choices, part mappings) in sync. Nothing is invented.
import { q, all, one } from './db.js';

const PAINT = 'Paint/Powder Coat';

// Purchased parts the configurator needs that the base parts catalog doesn't have yet, at cost 0.
const NEW_PARTS = [
  ['BUY-BRK-EOH', 'Brake Kit, Electric-Over-Hydraulic'],
  ['BUY-BRK-DISC', 'Brake Kit, Disc'],
  ['BUY-BRK-SURGE', 'Brake Actuator, Surge'],
  ['BUY-LAD-001', 'Front Boarding Ladder'],
  ['BUY-WHL-PREM', 'Wheel/Rim, Premium Aluminum'],
  ['BUY-WHL-BLK', 'Wheel/Rim, Blackout'],
  ['BUY-WNC-ELEC', 'Winch, Electric'],
  ['BUY-WPLATE-001', 'Winch Stand Plate, Fulton F2'],
  ['BUY-FLK-001', 'Metal Flake Additive (per build)'],
  ['BUY-AXL-5200', 'Straight Axle, 5200lb'],
  ['BUY-WNC-DLS', 'Winch, DL Covered Single Speed'],
  ['BUY-WNC-DLD', 'Winch, DL Covered Dual Speed'],
  ['BUY-MAT-TIGREY', 'Non-Skid Mat, 3-Layer Titanium Grey (Black accent)'],
  ['BUY-MAT-MOCHA', 'Non-Skid Mat, 3-Layer Mocha Brown (Black accent)'],
  ['BUY-MAT-BLACK', 'Non-Skid Mat, 3-Layer Black (White accent)'],
];

const MAKES = [['NQ', 'Nautique'], ['YA', 'Yamaha']];

// id, make, display name, length (ft), base trailer model id (an existing `model` row). Mappings
// marked ASSUMED are inferred by size; the rest match an exact existing base trailer. These are the
// INITIAL values — the office confirms/edits the mapping + dimensions in the admin screen (1E).
const BOAT_MODELS = [
  ['NQ-GS20', 'NQ', 'Super Air Nautique GS20', 20, 'GS20TAN'],
  ['NQ-GS22', 'NQ', 'Super Air Nautique GS22', 22, 'GS24TR'],  // ASSUMED
  ['NQ-GS24', 'NQ', 'Super Air Nautique GS24', 24, 'GS24TR'],
  ['NQ-G21', 'NQ', 'Super Air Nautique G21', 21, 'GS20TAN'],   // ASSUMED
  ['NQ-G23', 'NQ', 'Super Air Nautique G23', 23, 'G23TR'],
  ['NQ-G25', 'NQ', 'Super Air Nautique G25', 25, 'G25TR'],
  ['NQ-S23', 'NQ', 'Super Air Nautique S23', 23, 'G23TR'],     // ASSUMED (shares the G23 trailer)
  ['NQ-S25', 'NQ', 'Super Air Nautique S25', 25, 'G25TR'],     // ASSUMED (shares the G25 trailer)
  ['NQ-SKI', 'NQ', 'Ski Nautique', 20, 'GS20TAN'],             // ASSUMED (shares the GS20 trailer)
  ['PG-G23', 'NQ', 'G23 Paragon', 23, 'P23TR'],
  ['PG-G25', 'NQ', 'G25 Paragon', 25, 'P25TR'],
  ['YA-27', 'YA', "Yamaha 27'", 27, '27TR'],                   // ASSUMED triple (27TAN tandem also exists)
];

const STANDARD_COLORS = ['Mystic White', 'Lunar White', 'Sahara Sand', 'Teton Green', 'Haze Grey',
  'Mojave Brown', 'Tungsten Grey', 'Jet Black', 'Victory Red', 'Canyon Red', 'Captiva Green',
  'Steel Blue', 'Canaveral Blue', 'Masters Blue', 'Mariner Blue'];
const FLAKE_COLORS = ['Anthracite Metal Flake', 'Jet Black Metal Flake', 'Medallion Metal Flake',
  'Victory Red Metal Flake', 'Canaveral Blue Metal Flake', 'Masters Blue Metal Flake', 'Mariner Blue Metal Flake'];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Colors as choices. Flake colors carry the metal-flake additive part (primary only) and are the
// upcharge (price set by the office). The fender list is the same colors at no charge.
function colorChoices(fender) {
  const pre = fender ? 'fcolor_' : 'color_';
  const std = STANDARD_COLORS.map((name, i) => ({ id: pre + slug(name), name, default: i === 0 }));
  const flk = FLAKE_COLORS.map(name => ({
    id: pre + slug(name), name, note: 'Metal flake',
    parts: fender ? [] : [['BUY-FLK-001', 1]],
  }));
  return [...std, ...flk];
}

// Option groups. A choice's `parts` are [partId, qty, op?('add'|'remove')]; quantities match the
// (flat) base-BOM convention. `exclusive` groups (axle type, wheels) swap a base part: at submit
// the engine strips every part the group manages from the base BOM, then adds the selected choice's
// parts — so a base that already carries the chosen variant (e.g. G23 is torsion) never double-counts.
const GROUPS = [
  { id: 'axle_count', name: 'Axle Count', step: 3, ui: 'single', required: true, help: 'Sized to your boat — single/tandem under 22 ft, tandem/triple at 22 ft and over.',
    choices: [
      { id: 'ac_single', name: 'Single Axle' },
      { id: 'ac_tandem', name: 'Tandem Axle', default: true },
      { id: 'ac_triple', name: 'Triple Axle' },
    ] },
  { id: 'axle_type', name: 'Axle Type', step: 3, ui: 'single', required: true, exclusive: true, help: 'Sprung is standard; torsion rides smoother and is sealed.',
    choices: [
      { id: 'axle_sprung', name: 'Sprung (Leaf Spring)', default: true, parts: [['BUY-AXL-3500', 1], ['BUY-SPR-3500', 2]] },
      { id: 'axle_torsion', name: 'Torsion', parts: [['BUY-AXL-3500T', 1]] },
    ] },
  { id: 'brakes', name: 'Brakes', step: 3, ui: 'single', required: true, help: 'Electric-over-hydraulic is standard.',
    choices: [
      { id: 'brk_eoh', name: 'Electric Over Hydraulic', default: true, parts: [['BUY-BRK-EOH', 1]] },
      { id: 'brk_surge', name: 'Surge', parts: [['BUY-BRK-SURGE', 1]] },
      { id: 'brk_disc', name: 'Disc', parts: [['BUY-BRK-DISC', 1]] },
    ] },
  { id: 'front_ladder', name: 'Front Ladder', step: 4, ui: 'bool', required: false,
    choices: [{ id: 'ladder_yes', name: 'Front Ladder', parts: [['BUY-LAD-001', 1]] }] },
  { id: 'spare_tire', name: 'Spare Tire', step: 4, ui: 'bool', required: false, help: 'Includes the spare tire mount.',
    choices: [{ id: 'spare_yes', name: 'Spare Tire + Mount', parts: [['BUY-SPM-001', 1], ['BUY-TIR-001', 1]] }] },
  { id: 'nonskid_mat', name: 'Non-Skid Mat', step: 4, ui: 'single', required: false, help: '3-layer bunk matting.',
    choices: [
      { id: 'mat_none', name: 'None', default: true },
      { id: 'mat_titanium', name: '3-Layer Titanium Grey (Black accent)', parts: [['BUY-MAT-TIGREY', 1]] },
      { id: 'mat_mocha', name: '3-Layer Mocha Brown (Black accent)', parts: [['BUY-MAT-MOCHA', 1]] },
      { id: 'mat_black', name: '3-Layer Black (White accent)', parts: [['BUY-MAT-BLACK', 1]] },
    ] },
  { id: 'paint_style', name: 'Paint Style', step: 5, ui: 'single', required: true,
    choices: [{ id: 'paint_single', name: 'Single Color', default: true }, { id: 'paint_twotone', name: 'Two-Tone (frame + fender)' }] },
  { id: 'paint_color', name: 'Color', step: 5, ui: 'single', required: true, help: 'Primary (frame) color.' },
  { id: 'paint_fender_color', name: 'Fender Color', step: 5, ui: 'single', required: false, help: 'Two-tone builds only.' },
  { id: 'wheels', name: 'Wheels', step: 6, ui: 'single', required: true, exclusive: true,
    choices: [
      { id: 'wheel_std', name: 'Standard Aluminum', default: true, parts: [['BUY-WHL-001', 2]] },
      { id: 'wheel_prem', name: 'Premium Aluminum', parts: [['BUY-WHL-PREM', 2]] },
      { id: 'wheel_blk', name: 'Blackout Package', parts: [['BUY-WHL-BLK', 2]] },
    ] },
  { id: 'fender_style', name: 'Fender Style', step: 7, ui: 'single', required: true,
    choices: [{ id: 'fender_squared', name: 'Squared Style', default: true }] },
  { id: 'winch', name: 'Winch', step: 8, ui: 'single', required: true, help: 'DL covered winch.',
    choices: [
      { id: 'winch_dl_single', name: 'DL Covered Single Speed', default: true, parts: [['BUY-WNC-002', 1, 'remove'], ['BUY-WNC-DLS', 1]] },
      { id: 'winch_dl_dual', name: 'DL Covered Dual Speed', parts: [['BUY-WNC-002', 1, 'remove'], ['BUY-WNC-DLD', 1]] },
    ] },
  { id: 'winch_stand', name: 'Jack Stand', step: 8, ui: 'single', required: true, help: 'Fulton F2 is standard.',
    choices: [
      { id: 'winch_f2', name: 'Fulton F2', default: true },
      { id: 'winch_f2plate', name: 'Fulton F2 Plate' },
      { id: 'winch_elec', name: 'Electric' },
    ] },
];

function choicesFor(g) {
  if (g.id === 'paint_color') return colorChoices(false);
  if (g.id === 'paint_fender_color') return colorChoices(true);
  return g.choices || [];
}
const stageForGroup = g => (g.id === 'paint_color' ? PAINT : 'Build');

// Idempotent seeder. Code-owned structure (groups/choices/part mappings) is kept in sync; office-
// owned money (option_choice.dealer_price, part.cost) and boat dimensions are never overwritten.
export async function ensureBoatCatalog() {
  for (const [id, name] of NEW_PARTS)
    await q(`INSERT INTO part(id,name,type,uom,cost,spec) VALUES($1,$2,'P','EA',0,'TBD — set cost') ON CONFLICT(id) DO NOTHING`, [id, name]);
  for (const [id, name] of MAKES)
    await q(`INSERT INTO boat_make(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, [id, name]);
  let bs = 0;
  // Insert-only: boats are office-owned data once seeded — the admin screen owns the base-trailer
  // mapping + dimensions, so re-seeding never clobbers a correction. New boats added to the list
  // still seed on first boot.
  for (const [id, make, name, len, base] of BOAT_MODELS)
    await q(`INSERT INTO boat_model(id,make_id,name,length_ft,base_model_id,sort) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, [id, make, name, len, base, bs++]);
  // Part mappings are entirely code-owned — reset them so they always match this file.
  await q(`DELETE FROM option_choice_part`).catch(() => {});
  let gs = 0;
  for (const g of GROUPS) {
    await q(`INSERT INTO option_group(id,name,step,ui,required,exclusive,help,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT(id) DO UPDATE SET name=$2,step=$3,ui=$4,required=$5,exclusive=$6,help=$7,sort=$8,active=true`,
      [g.id, g.name, g.step, g.ui, !!g.required, !!g.exclusive, g.help || null, gs++]);
    let cs = 0;
    for (const c of choicesFor(g)) {
      await q(`INSERT INTO option_choice(id,group_id,name,is_default,sort,note) VALUES($1,$2,$3,$4,$5,$6)
               ON CONFLICT(id) DO UPDATE SET group_id=$2,name=$3,is_default=$4,sort=$5,note=$6,active=true`,
        [c.id, g.id, c.name, !!c.default, cs++, c.note || null]);
      for (const [partId, qty, op] of (c.parts || []))
        await q(`INSERT INTO option_choice_part(choice_id,part_id,qty,op) VALUES($1,$2,$3,$4) ON CONFLICT(choice_id,part_id,op) DO NOTHING`,
          [c.id, partId, qty, op || 'add']);
    }
  }
}

// Full catalog for the configurator/admin: boats (+ base trailer & price) and option groups with
// their choices and the parts each choice drives.
export async function getCatalog() {
  const makes = await all('SELECT id,name FROM boat_make WHERE active ORDER BY sort,name', []);
  const boats = await all(
    `SELECT b.id, b.make_id, b.name, b.length_ft, b.beam_in, b.dry_weight_lb, b.base_model_id,
            m.name AS base_model_name, m.axle, m.price AS base_price
       FROM boat_model b LEFT JOIN model m ON m.id = b.base_model_id
      WHERE b.active ORDER BY b.sort, b.length_ft`, []);
  const groups = await all('SELECT id,name,step,ui,required,exclusive,help FROM option_group WHERE active ORDER BY step,sort', []);
  const choices = await all('SELECT id, group_id, name, dealer_price, is_default, sort, note FROM option_choice WHERE active ORDER BY group_id, sort', []);
  const parts = await all('SELECT choice_id, part_id, qty, op FROM option_choice_part', []);
  const byGroup = {};
  for (const c of choices) (byGroup[c.group_id] ||= []).push({ ...c, parts: parts.filter(p => p.choice_id === c.id) });
  return { makes, boats, groups: groups.map(g => ({ ...g, choices: byGroup[g.id] || [] })) };
}

// ---- configurator engine ----------------------------------------------------------------------

// Missing selections, invalid choices, and manufacturing conflicts.
export async function validateBuild(payload, cat) {
  cat ||= await getCatalog();
  const errors = [];
  const sel = payload.selections || {};
  const boat = cat.boats.find(b => b.id === payload.boatId);
  if (!boat) errors.push('Select a boat model.');
  else if (!boat.base_model_id) errors.push(`${boat.name} has no base trailer assigned yet.`);
  for (const g of cat.groups) {
    if (g.required && !sel[g.id]) errors.push(`Choose ${g.name}.`);
    if (sel[g.id] && !g.choices.find(c => c.id === sel[g.id])) errors.push(`Invalid ${g.name} selection.`);
  }
  if (sel.paint_style === 'paint_twotone' && !sel.paint_fender_color) errors.push('Two-tone paint needs a fender color.');
  // Smart axle rule (by boat length): under 22 ft single/tandem, 22 ft and over tandem/triple.
  const len = boat ? Number(boat.length_ft) || 0 : 0;
  if (len && len < 22 && sel.axle_count === 'ac_triple') errors.push('Boats under 22 ft use a single or tandem axle.');
  if (len >= 22 && sel.axle_count === 'ac_single') errors.push('Boats 22 ft and over need a tandem or triple axle.');
  return { ok: errors.length === 0, errors };
}

// Dealer price = base trailer price + the dealer_price of each selected upcharge choice.
export async function priceBuild(payload, cat) {
  cat ||= await getCatalog();
  const sel = payload.selections || {};
  const boat = cat.boats.find(b => b.id === payload.boatId);
  const base = boat ? Number(boat.base_price) || 0 : 0;
  const lines = [];
  for (const g of cat.groups) {
    const c = g.choices.find(x => x.id === sel[g.id]);
    if (c && Number(c.dealer_price) > 0) lines.push({ group: g.name, choice: c.name, price: Number(c.dealer_price) });
  }
  return { base, lines, total: base + lines.reduce((s, l) => s + l.price, 0) };
}

// Final BOM for a configured trailer + the signed deltas vs the base model BOM (what gets stored
// and later netted into stage consumption). Exclusive groups swap; others add/remove.
export async function computeFinalBOM(baseModelId, selections, cat) {
  cat ||= await getCatalog();
  const sel = selections || {};
  const map = new Map();           // part_id -> { qty, stage }
  const baseQty = new Map();
  for (const l of await all('SELECT part_id, qty, stage FROM bom_line WHERE model_id=$1', [baseModelId])) {
    map.set(l.part_id, { qty: Number(l.qty), stage: l.stage || 'Build' });
    baseQty.set(l.part_id, Number(l.qty));
  }
  const bump = (pid, dq, stage) => {
    const e = map.get(pid) || { qty: 0, stage };
    e.qty += dq;
    map.set(pid, e);
  };
  for (const g of cat.groups) {
    const stage = stageForGroup(g);
    if (g.exclusive) {
      for (const c of g.choices) for (const p of c.parts) map.delete(p.part_id);   // strip managed parts
      const c = g.choices.find(x => x.id === sel[g.id]) || g.choices.find(x => x.is_default);
      if (c) for (const p of c.parts) bump(p.part_id, Number(p.qty), stage);
    } else {
      const c = g.choices.find(x => x.id === sel[g.id]);
      if (c) for (const p of c.parts) bump(p.part_id, (p.op === 'remove' ? -1 : 1) * Number(p.qty), stage);
    }
  }
  const lines = [], deltas = [];
  for (const pid of new Set([...map.keys(), ...baseQty.keys()])) {
    const fin = map.get(pid)?.qty || 0;
    if (fin > 0) lines.push({ part_id: pid, qty: fin });
    const d = +(fin - (baseQty.get(pid) || 0)).toFixed(3);
    if (d !== 0) deltas.push({ part_id: pid, qty: d, stage: map.get(pid)?.stage || 'Build' });
  }
  return { lines, deltas };
}

// Validate → price → create the Quote order, persisting the boat, the chosen options, and the BOM
// deltas. Mirrors dealer.placeOrder so configured orders flow through the normal approval pipeline.
export async function submitBuild(actor, payload) {
  const cat = await getCatalog();
  const v = await validateBuild(payload, cat);
  if (!v.ok) { const e = new Error(v.errors.join(' ')); e.status = 400; throw e; }
  const boat = cat.boats.find(b => b.id === payload.boatId);
  const price = await priceBuild(payload, cat);
  const { deltas } = await computeFinalBOM(boat.base_model_id, payload.selections, cat);
  const id = 'SO-' + (1049 + (await all('SELECT id FROM sales_order', [])).length);
  const seq = (await one('SELECT COALESCE(MAX(production_seq),0)+1 AS n FROM sales_order', [])).n;
  await q(`INSERT INTO sales_order(id,customer_id,model_id,qty,stage,due,channel,rep_id,production_seq)
           VALUES($1,$2,$3,$4,'Quote',$5,$6,$7,$8)`,
    [id, payload.customerId || null, boat.base_model_id, payload.qty || 1, payload.due || null, payload.channel || 'Configurator', payload.repId || actor?.id || null, seq]);
  await q(`INSERT INTO order_build(order_id,boat_make,boat_model,boat_year,boat_length,base_model_id,total_price,note,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, boat.make_id, boat.name, payload.year || null, boat.length_ft, boat.base_model_id, price.total, payload.note || null, actor?.id || payload.createdBy || null]);
  const sel = payload.selections || {};
  for (const g of cat.groups) {
    const c = g.choices.find(x => x.id === sel[g.id]);
    if (c) await q(`INSERT INTO order_build_option(order_id,group_id,group_name,choice_id,choice_name,dealer_price) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, g.id, g.name, c.id, c.name, Number(c.dealer_price) || 0]);
  }
  for (const d of deltas)
    await q(`INSERT INTO order_bom_delta(order_id,part_id,qty,stage) VALUES($1,$2,$3,$4)`, [id, d.part_id, d.qty, d.stage]);
  return { orderId: id, total: price.total, boat: boat.name, baseModel: boat.base_model_id };
}

// The stored configuration for an order (for the spec sheets + dealer/staff order views).
export async function orderBuild(orderId) {
  const b = await one('SELECT * FROM order_build WHERE order_id=$1', [orderId]);
  if (!b) return null;
  const options = await all('SELECT group_id, group_name, choice_name, dealer_price FROM order_build_option WHERE order_id=$1 ORDER BY id', [orderId]);
  return { ...b, options };
}

// Full production spec for a configured order: the build + options + the resolved final BOM
// (base model BOM netted with the order's deltas), each part named — drives the build sheet.
export async function orderSpec(orderId) {
  const build = await orderBuild(orderId);
  if (!build) return null;
  const map = new Map();
  for (const l of await all('SELECT b.part_id, b.qty, p.name FROM bom_line b JOIN part p ON p.id=b.part_id WHERE b.model_id=$1', [build.base_model_id]))
    map.set(l.part_id, { part_id: l.part_id, name: l.name, qty: Number(l.qty) });
  for (const d of await all('SELECT d.part_id, d.qty, p.name FROM order_bom_delta d JOIN part p ON p.id=d.part_id WHERE d.order_id=$1', [orderId])) {
    const e = map.get(d.part_id) || { part_id: d.part_id, name: d.name, qty: 0 };
    e.qty += Number(d.qty);
    map.set(d.part_id, e);
  }
  const bom = [...map.values()].filter(x => x.qty > 0).sort((a, b) => a.part_id.localeCompare(b.part_id));
  return { ...build, bom };
}
