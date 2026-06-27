// Boat Trailer Builder — the reference catalog (Nautique boats + configurable options) plus the
// idempotent seeder that guarantees it exists in every environment, and read helpers.
//
// Design: the configurator sits ON TOP of the existing Boat-category base models. Each boat maps
// to a base trailer model (which already carries a full BOM); the option choices contribute
// part deltas (add/remove, optionally per-axle) so the configurator engine (Phase 1B) can compute
// the final BOM, inventory consumption, and cost. Every dollar figure (part cost + dealer price)
// seeds at 0 and is editable by the office in the admin screen (Phase 1E) — nothing is invented.
import { q, all } from './db.js';

// Purchased parts the configurator needs that the base parts catalog doesn't have yet.
// Seeded at cost 0 (TBD) and flagged in `spec`; the office sets real costs in the admin screen.
const NEW_PARTS = [
  ['BUY-BRK-EOH',    'Brake Kit, Electric-Over-Hydraulic (per axle)'],
  ['BUY-BRK-DISC',   'Brake Kit, Disc (per axle)'],
  ['BUY-BRK-SURGE',  'Brake Actuator, Surge'],
  ['BUY-LAD-001',    'Front Boarding Ladder'],
  ['BUY-WHL-PREM',   'Wheel/Rim, Premium Aluminum'],
  ['BUY-WHL-BLK',    'Wheel/Rim, Blackout'],
  ['BUY-WNC-ELEC',   'Winch, Electric'],
  ['BUY-WPLATE-001', 'Winch Stand Plate, Fulton F2'],
  ['BUY-FLK-001',    'Metal Flake Additive (per build)'],
  ['BUY-AXL-5200',   'Straight Axle, 5200lb'],
];

const MAKES = [['NQ', 'Nautique']];

// id, make, display name, length (ft), base trailer model id (must exist in `model`).
// Nautique model numbers encode length, so sizing keys off length. More of the lineup
// (G21, GS22, S21/S23/S25, Ski) gets added once the office confirms each one's base trailer.
const BOAT_MODELS = [
  ['NQ-GS20', 'NQ', 'Super Air Nautique GS20', 20, 'GS20TAN'],
  ['NQ-G23',  'NQ', 'Super Air Nautique G23',  23, 'G23TR'],
  ['NQ-GS24', 'NQ', 'Super Air Nautique GS24', 24, 'GS24TR'],
  ['NQ-G25',  'NQ', 'Super Air Nautique G25',  25, 'G25TR'],
];

const STANDARD_COLORS = ['Mystic White', 'Lunar White', 'Sahara Sand', 'Teton Green', 'Haze Grey',
  'Mojave Brown', 'Tungsten Grey', 'Jet Black', 'Victory Red', 'Canyon Red', 'Captiva Green',
  'Steel Blue', 'Canaveral Blue', 'Masters Blue', 'Mariner Blue'];
const FLAKE_COLORS = ['Anthracite Metal Flake', 'Jet Black Metal Flake', 'Medallion Metal Flake',
  'Victory Red Metal Flake', 'Canaveral Blue Metal Flake', 'Masters Blue Metal Flake', 'Mariner Blue Metal Flake'];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// The colors as choices. Flake colors carry the metal-flake additive part (primary only) and are
// the upcharge (dealer_price set by the office); the fender list is the same colors at no charge.
function colorChoices(fender) {
  const pre = fender ? 'fcolor_' : 'color_';
  const std = STANDARD_COLORS.map((name, i) => ({ id: pre + slug(name), name, default: i === 0 }));
  const flk = FLAKE_COLORS.map(name => ({
    id: pre + slug(name), name, note: 'Metal flake',
    parts: fender ? [] : [['BUY-FLK-001', 'add', false, 1]],
  }));
  return [...std, ...flk];
}

// Option groups. A choice's `parts` are [partId, op('add'|'remove'), perAxle, qty]; per-axle parts
// are multiplied by the base model's axle count at submit. Default/standard choices that already
// match the base BOM carry no parts. Prices are 0 until the office sets them.
const GROUPS = [
  { id: 'axle_type', name: 'Axle Type', step: 3, ui: 'single', required: true, help: 'Sprung is standard; torsion rides smoother and is sealed.',
    choices: [
      { id: 'axle_sprung', name: 'Sprung (Leaf Spring)', default: true },
      { id: 'axle_torsion', name: 'Torsion', parts: [
        ['BUY-AXL-3500T', 'add', true, 1], ['BUY-AXL-3500', 'remove', true, 1],
        ['BUY-SPR-3500', 'remove', true, 2], ['BUY-UBT-001', 'remove', true, 2]] },
    ] },
  { id: 'brakes', name: 'Brakes', step: 3, ui: 'single', required: true, help: 'Electric-over-hydraulic is standard.',
    choices: [
      { id: 'brk_eoh', name: 'Electric Over Hydraulic', default: true, parts: [['BUY-BRK-EOH', 'add', true, 1]] },
      { id: 'brk_surge', name: 'Surge', parts: [['BUY-BRK-SURGE', 'add', false, 1]] },
      { id: 'brk_disc', name: 'Disc', parts: [['BUY-BRK-DISC', 'add', true, 1]] },
    ] },
  { id: 'front_ladder', name: 'Front Ladder', step: 4, ui: 'bool', required: false,
    choices: [{ id: 'ladder_yes', name: 'Front Ladder', parts: [['BUY-LAD-001', 'add', false, 1]] }] },
  { id: 'spare_tire', name: 'Spare Tire', step: 4, ui: 'bool', required: false, help: 'Includes the spare tire mount.',
    choices: [{ id: 'spare_yes', name: 'Spare Tire + Mount', parts: [['BUY-SPM-001', 'add', false, 1], ['BUY-TIR-001', 'add', false, 1]] }] },
  { id: 'paint_style', name: 'Paint Style', step: 5, ui: 'single', required: true,
    choices: [{ id: 'paint_single', name: 'Single Color', default: true }, { id: 'paint_twotone', name: 'Two-Tone (frame + fender)' }] },
  { id: 'paint_color', name: 'Color', step: 5, ui: 'single', required: true, help: 'Primary (frame) color.' },
  { id: 'paint_fender_color', name: 'Fender Color', step: 5, ui: 'single', required: false, help: 'Two-tone builds only.' },
  { id: 'wheels', name: 'Wheels', step: 6, ui: 'single', required: true,
    choices: [
      { id: 'wheel_std', name: 'Standard Aluminum', default: true },
      { id: 'wheel_prem', name: 'Premium Aluminum', parts: [['BUY-WHL-PREM', 'add', true, 2], ['BUY-WHL-001', 'remove', true, 2]] },
      { id: 'wheel_blk', name: 'Blackout Package', parts: [['BUY-WHL-BLK', 'add', true, 2], ['BUY-WHL-001', 'remove', true, 2]] },
    ] },
  { id: 'fender_style', name: 'Fender Style', step: 7, ui: 'single', required: true,
    choices: [{ id: 'fender_squared', name: 'Squared Style', default: true }] },
  { id: 'winch_stand', name: 'Winch Stand', step: 8, ui: 'single', required: true,
    choices: [
      { id: 'winch_f2', name: 'Fulton F2', default: true },
      { id: 'winch_f2plate', name: 'Fulton F2 Plate', parts: [['BUY-WPLATE-001', 'add', false, 1]] },
      { id: 'winch_elec', name: 'Electric', parts: [['BUY-WNC-ELEC', 'add', false, 1]] },
    ] },
];

function choicesFor(g) {
  if (g.id === 'paint_color') return colorChoices(false);
  if (g.id === 'paint_fender_color') return colorChoices(true);
  return g.choices || [];
}

// Idempotent: creates the catalog where missing and NEVER overwrites edited rows (ON CONFLICT DO
// NOTHING preserves office-set prices/costs). Runs at server boot, after ensureSchema.
export async function ensureBoatCatalog() {
  for (const [id, name] of NEW_PARTS)
    await q(`INSERT INTO part(id,name,type,uom,cost,spec) VALUES($1,$2,'P','EA',0,'TBD — set cost') ON CONFLICT(id) DO NOTHING`, [id, name]);
  for (const [id, name] of MAKES)
    await q(`INSERT INTO boat_make(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, [id, name]);
  let bs = 0;
  for (const [id, make, name, len, base] of BOAT_MODELS)
    await q(`INSERT INTO boat_model(id,make_id,name,length_ft,base_model_id,sort) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, [id, make, name, len, base, bs++]);
  let gs = 0;
  for (const g of GROUPS) {
    await q(`INSERT INTO option_group(id,name,step,ui,required,help,sort) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [g.id, g.name, g.step, g.ui, !!g.required, g.help || null, gs++]);
    let cs = 0;
    for (const c of choicesFor(g)) {
      await q(`INSERT INTO option_choice(id,group_id,name,is_default,sort,note) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
        [c.id, g.id, c.name, !!c.default, cs++, c.note || null]);
      for (const [partId, op, perAxle, qty] of (c.parts || []))
        await q(`INSERT INTO option_choice_part(choice_id,part_id,qty,op,per_axle) VALUES($1,$2,$3,$4,$5) ON CONFLICT(choice_id,part_id,op) DO NOTHING`,
          [c.id, partId, qty, op, !!perAxle]);
    }
  }
}

// Full catalog for the configurator/admin: boats (with base trailer), and option groups with
// their choices (and the parts each choice drives, for the spec/BOM views).
export async function getCatalog() {
  const makes = await all('SELECT id,name FROM boat_make WHERE active ORDER BY sort,name', []);
  const boats = await all(
    `SELECT b.id, b.make_id, b.name, b.length_ft, b.beam_in, b.dry_weight_lb, b.base_model_id,
            m.name AS base_model_name, m.axle, m.price AS base_price
       FROM boat_model b LEFT JOIN model m ON m.id = b.base_model_id
      WHERE b.active ORDER BY b.sort, b.length_ft`, []);
  const groups = await all('SELECT id,name,step,ui,required,help FROM option_group WHERE active ORDER BY step,sort', []);
  const choices = await all(
    `SELECT id, group_id, name, dealer_price, is_default, sort, note FROM option_choice WHERE active ORDER BY group_id, sort`, []);
  const parts = await all('SELECT choice_id, part_id, qty, op, per_axle FROM option_choice_part', []);
  const byGroup = {};
  for (const c of choices) (byGroup[c.group_id] ||= []).push({ ...c, parts: parts.filter(p => p.choice_id === c.id) });
  return { makes, boats, groups: groups.map(g => ({ ...g, choices: byGroup[g.id] || [] })) };
}
