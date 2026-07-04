// Seed the database: schema + real Built Trailers catalog + roles/users.
// Idempotent — safe to re-run. Default password for every seeded user: built2026
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, q } from '../src/db.js';
import { ensureSchema } from './migrate.js';
import { hashPassword } from '../src/auth.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(__dir, 'catalog.json'), 'utf8'));

const VENDORS = [
  ['v_axle', 'Dexter Axle Co.', 12, 'Net 30'],
  ['v_tire', 'Carlisle Tire & Wheel', 7, 'Net 15'],
  ['v_light', 'Optronics Lighting', 9, 'Net 30'],
  ['v_fast', 'Fastenal', 3, 'Net 15'],
  ['v_marine', 'Trailparts Marine Supply', 8, 'Net 30'],
  ['v_steel', 'Mountain Steel & Lumber', 5, 'Net 30'],
  ['v_paint', 'Sherwin Coatings', 6, 'Net 30'],
  ['v_bbq', 'BBQ Components Co.', 10, 'Net 30'],
  ['INT', 'Manufactured In-House', 0, 'WIP'],
];
const ROLES = [
  ['General Manager', 'admin'], ['Office Manager', 'admin'], ['Shop Manager', 'admin'],
  ['Sales', 'editor'], ['Rep Specialist', 'editor'], ['Watercraft Lead', 'editor'],
  ['Boat Lead', 'editor'], ['Utility Lead', 'editor'], ['Utility Specialist', 'editor'],
  ['Shop Specialist', 'editor'], ['Shop Assistant Specialist', 'viewer'], ['Painter', 'editor'],
  ['Final Assembly Specialist', 'editor'], ['QC Specialist', 'editor'], ['External Viewer', 'viewer'],
];
const USERS = [
  ['u1', 'Todd Soelberg', 'General Manager', null],
  ['u2', 'Maria Chen', 'Shop Manager', 'u1'],
  ['u3', 'Dave Olsen', 'Office Manager', 'u1'],
  ['u4', 'Angela Ruiz', 'Sales', 'u1'],
  ['u5', 'Mike Tran', 'Rep Specialist', 'u4'],
  ['u6', 'Carlos Reyes', 'Boat Lead', 'u2'],
  ['u7', 'Jenna Pratt', 'Watercraft Lead', 'u2'],
  ['u8', 'Sam Whitfield', 'Utility Lead', 'u2'],
  ['u9', 'Lena Brooks', 'Final Assembly Specialist', 'u8'],
  ['u10', 'Priya Nair', 'Painter', 'u2'],
  ['u11', 'Rosa Mendez', 'QC Specialist', 'u2'],
  ['u12', 'Tom Galloway', 'Shop Specialist', 'u8'],
  ['u13', 'Investor / Lender', 'External Viewer', null],
];

function makeUsername(name, seen) {
  const p = name.trim().split(/\s+/);
  let base = ((p[0][0] || '') + (p[p.length - 1] || '')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  let un = base, i = 1;
  while (seen.has(un)) un = base + (++i);
  seen.add(un);
  return un;
}

// Ensure the permission roles exist — idempotent, never deletes. Safe to run on every boot.
async function ensureRoles() {
  for (const [name, tier] of ROLES)
    await q('INSERT INTO role(name,tier) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, tier]);
}

// On a genuinely empty database, create a single owner admin so the app is usable — without
// loading any demo data. Credentials come from env; falls back to a default that MUST be changed.
async function ensureOwnerAdmin() {
  const have = Number((await q('SELECT count(*)::int AS c FROM app_user')).rows[0].c);
  if (have > 0) return;
  const username = process.env.OWNER_USERNAME || 'tsoelberg';
  const name = process.env.OWNER_NAME || 'Owner';
  const pw = process.env.OWNER_PASSWORD || 'built2026';
  await q('INSERT INTO app_user(id,name,username,password_hash,title,role) VALUES ($1,$2,$3,$4,$5,$6)',
    ['owner', name, username, hashPassword(pw), 'General Manager', 'admin']);
  if (process.env.OWNER_PASSWORD) console.log(`Created owner admin "${username}".`);
  else console.warn(`⚠ Created owner admin "${username}" with the DEFAULT password "built2026" — change it now (or set OWNER_PASSWORD).`);
}

async function run() {
  const kind = await initDb();
  console.log('DB:', kind);
  // base schema + incremental migrations (shared with server boot — one source of truth)
  await ensureSchema();
  // Fail-SAFE guard: only ever (re)seed a verifiably EMPTY database, and never wipe on error.
  // If app_user can't be read, ABORT — a transient DB hiccup must never trigger a wipe.
  let userCount;
  try {
    userCount = Number((await q('SELECT count(*)::int AS c FROM app_user')).rows[0].c);
  } catch (e) {
    console.error('Could not read app_user — refusing to seed to avoid data loss:', e.message);
    process.exit(1);
  }
  if (userCount > 0) {
    console.log(`Already seeded (${userCount} users) — leaving all data untouched.`);
    await ensureRoles();          // keep permission roles current; never touches user/business data
    process.exit(0);
  }
  // Empty database. In production (no SEED_DEMO) DO NOT load demo data and DO NOT delete
  // anything — just ensure roles + an owner admin so the app is usable. The destructive demo
  // seed below runs ONLY when SEED_DEMO=1 (local/dev), so a deploy can never auto-wipe prod.
  if (process.env.SEED_DEMO !== '1') {
    await ensureRoles();
    await ensureOwnerAdmin();
    console.log('Empty DB — created roles + owner admin only. Set SEED_DEMO=1 to load full demo data.');
    process.exit(0);
  }
  console.log('SEED_DEMO=1 — loading the full demo dataset (clears existing rows first).');
  // clear (children first)
  for (const t of ['approval_request', 'approval_rule', 'notification', 'win_reaction', 'win', 'self_goal', 'user_outcome', 'time_off', 'employee',
                   'accounting_event', 'vendor_invoice', 'purchase_order', 'sales_order',
                   'customer_allowed_type', 'customer', 'trailer_type',
                   'audit_log', 'model_labor', 'bom_line', 'model', 'part', 'vendor', 'app_user', 'role']) {
    await q(`DELETE FROM ${t};`);
  }
  // roles
  for (const [name, tier] of ROLES) await q('INSERT INTO role(name,tier) VALUES ($1,$2)', [name, tier]);
  const tierOf = Object.fromEntries(ROLES.map(([n, t]) => [n, t]));
  // users (two passes for manager FK)
  const seen = new Set();
  const pwHash = hashPassword('built2026');
  for (const [id, name, title] of USERS) {
    const un = makeUsername(name, seen);
    await q('INSERT INTO app_user(id,name,username,password_hash,title,role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name, un, pwHash, title, tierOf[title] || 'viewer']);
  }
  for (const [id, , , mgr] of USERS) if (mgr) await q('UPDATE app_user SET manager_id=$1 WHERE id=$2', [mgr, id]);
  // phones for approvers (used by approval SMS notifications)
  await q("UPDATE app_user SET phone='208-555-0101' WHERE id='u1'"); // GM
  await q("UPDATE app_user SET phone='208-555-0102' WHERE id='u2'"); // Shop Manager
  await q("UPDATE app_user SET phone='208-555-0103' WHERE id='u3'"); // Office Manager / Accounting
  // vendors
  for (const v of VENDORS) await q('INSERT INTO vendor(id,name,lead_days,terms) VALUES ($1,$2,$3,$4)', v);
  // parts
  for (const p of catalog.parts) {
    await q(`INSERT INTO part(id,name,type,vendor_id,uom,spec,cost,on_hand,reorder,cushion,lot)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [p.id, p.name, p.type, p.vendor || 'INT', p.uom || '', p.spec || '',
       p.cost || 0, p.onHand || 0, p.reorder || 0, p.cushion || 0, p.lot || 1]);
  }
  // models + bom + labor
  for (const m of catalog.models) {
    await q('INSERT INTO model(id,name,category,axle,price,cap) VALUES ($1,$2,$3,$4,$5,$6)',
      [m.id, m.name, m.cat || '', m.axle || '', m.price || 0, m.cap || 0]);
    for (const b of m.bom) await q('INSERT INTO bom_line(model_id,part_id,qty) VALUES ($1,$2,$3)', [m.id, b.p, b.q]);
    for (const l of (m.labor || [])) await q('INSERT INTO model_labor(model_id,ws,hours) VALUES ($1,$2,$3)', [m.id, l.ws, l.h]);
  }
  // ===== Phase 2 seed: trailer types, dealers, orders =====
  const cats = [...new Set(catalog.models.map(m => m.cat))];
  const types = [...cats, 'Custom'];
  for (const t of types) await q('INSERT INTO trailer_type(name) VALUES ($1)', [t]);

  const CUSTOMERS = [
    ['c1', 'Lakeside Boat Co.', 'Dealership', 'orders@lakesideboat.com', '(801) 555-0110', 'u4', ['Boat']],
    ['c2', 'High Desert Powersports', 'Dealership', 'purchasing@hdpowersports.com', '(435) 555-0132', 'u5', ['Utility', 'Watercraft']],
    ['c3', 'Cache Valley Trailer Sales', 'Dealership', 'buy@cvtrailers.com', '(435) 555-0177', 'u4', [...cats, 'Custom']],
    ['c4', 'Red Rock Ranch Supply', 'Dealership', 'ranch@redrock.com', '(435) 555-0148', 'u5', ['Utility', 'Landscape']],
    ['c5', 'Summit Outdoor & BBQ', 'Dealership', 'sales@summitoutdoor.com', '(801) 555-0190', 'u4', ['BBQ', 'Utility']],
    ['c6', 'Direct / Retail (walk-in)', 'Retail', '', '', 'u4', [...cats, 'Custom']],
  ];
  for (const [id, name, kind, contact, phone, rep, allowed] of CUSTOMERS) {
    await q('INSERT INTO customer(id,name,kind,contact,phone,rep_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, kind, contact, phone, rep]);
    for (const t of allowed) await q('INSERT INTO customer_allowed_type(customer_id,type) VALUES ($1,$2)', [id, t]);
  }
  // Demo dealer-locator data (address + geocode) so the public dealer feed has complete entries.
  for (const [id, addr, city, st, zip, lat, lng] of [
    ['c1', '123 Boulder Ave', 'St. George', 'UT', '84770', 37.0965, -113.5684],
    ['c2', '456 Dixie Dr', 'Hurricane', 'UT', '84737', 37.1753, -113.2899],
    ['c3', '789 Main St', 'Logan', 'UT', '84321', 41.7355, -111.8344],
    ['c4', '321 Ranch Rd', 'Cedar City', 'UT', '84720', 37.6775, -113.0619],
    ['c5', '654 Summit Way', 'Provo', 'UT', '84601', 40.2338, -111.6585],
  ]) await q('UPDATE customer SET address=$2,city=$3,state=$4,zip=$5,lat=$6,lng=$7 WHERE id=$1', [id, addr, city, st, zip, lat, lng]);

  const ORDERS = [
    ['SO-1042', 'c4', 'LS7X14T', 2, 'In Production', '2026-06-26', 0.3, 'Sales', 'u5'],
    ['SO-1043', 'c2', 'UT7X14T', 3, 'Confirmed', '2026-07-05', 0.3, 'Sales', 'u5'],
    ['SO-1044', 'c1', 'G25TR', 1, 'Scheduled', '2026-07-02', 0.5, 'Sales', 'u4'],
    ['SO-1045', 'c3', 'WC4PT', 1, 'Quote', '2026-07-18', 0.0, 'Sales', 'u4'],
    ['SO-1046', 'c2', 'WC217', 2, 'QC', '2026-06-22', 0.3, 'Sales', 'u5'],
    ['SO-1047', 'c5', 'BBQ1', 1, 'Confirmed', '2026-07-12', 0.3, 'Sales', 'u4'],
    ['SO-1048', 'c6', 'UT5X10S', 4, 'In Production', '2026-06-28', 0.3, 'Sales', 'u4'],
  ];
  for (const [id, cust, model, qty, stage, due, dep, ch, rep] of ORDERS) {
    await q('INSERT INTO sales_order(id,customer_id,model_id,qty,stage,due,deposit,channel,rep_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, cust, model, qty, stage, due, dep, ch, rep]);
  }

  // open POs in flight
  const POS = [
    ['PO-3301', 'v_axle', 'BUY-AXL-3500', 40, 118, '2026-06-12', '2026-06-24'],
    ['PO-3302', 'v_tire', 'BUY-TIR-001', 80, 58, '2026-06-15', '2026-06-22'],
  ];
  for (const [id, ven, part, qty, unit, placed, eta] of POS) {
    await q('INSERT INTO purchase_order(id,vendor_id,part_id,qty,unit_cost,placed,eta,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, ven, part, qty, unit, placed, eta, 'Open']);
  }

  // sample accounting ledger entries (so the page isn't empty before any ship/receive)
  await q(`INSERT INTO accounting_event(kind,ref,party,amount,mode,status) VALUES
     ('invoice','SO-1039','Cache Valley Trailer Sales',10100,'simulated','posted'),
     ('bill','PO-3290','Dexter Axle Co.',4720,'simulated','posted')`);

  // ===== Phase 5 seed: employees, schedules, time off, outcomes, goals, wins =====
  const DEF = JSON.stringify({ Mon: ['07:00', '15:30'], Tue: ['07:00', '15:30'], Wed: ['07:00', '15:30'], Thu: ['07:00', '15:30'], Fri: ['07:00', '15:30'], Sat: null, Sun: null });
  const FOUR_TEN = JSON.stringify({ Mon: ['06:00', '16:30'], Tue: ['06:00', '16:30'], Wed: ['06:00', '16:30'], Thu: ['06:00', '16:30'], Fri: null, Sat: null, Sun: null });
  const EMPS = [
    ['e1', 'Carlos Reyes', 'Welding', 31, 42, 'u2', 96, DEF],
    ['e2', 'Jenna Pratt', 'Welding', 29, 40, 'u2', 88, DEF],
    ['e3', 'Sam Whitfield', 'Assembly', 26, 44, 'u2', 72, DEF],
    ['e4', 'Lena Brooks', 'Assembly', 25, 40, 'u8', 64, DEF],
    ['e5', 'Marcus Webb', 'Wiring', 28, 38, 'u2', 40, DEF],
    ['e6', 'Priya Nair', 'Paint', 27, 40, 'u2', 80, DEF],
    ['e7', 'Tom Galloway', 'Cutting', 24, 41, 'u8', 56, FOUR_TEN],
    ['e8', 'Rosa Mendez', 'Final QC', 30, 40, 'u2', 92, DEF],
  ];
  for (const e of EMPS) await q('INSERT INTO employee(id,name,workstation,base_rate,hours_wk,mgr_id,pto_balance,schedule) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', e);

  const TIMEOFF = [
    ['TO-2001', 'e5', 'PTO', '2026-06-29', '2026-07-01', 24, 'Family trip', 'Pending Manager', '2026-06-16', null, null, null, null],
    ['TO-2002', 'e4', 'Sick', '2026-06-16', '2026-06-16', 8, 'Doctor appointment', 'Approved - To Payroll', '2026-06-15', 'Sam Whitfield (Utility Lead)', '2026-06-15', null, null],
    ['TO-2003', 'e7', 'PTO', '2026-06-22', '2026-06-23', 16, 'Moving', 'Processed', '2026-06-10', 'Sam Whitfield (Utility Lead)', '2026-06-11', 'Dave Olsen (Office Manager)', '2026-06-12'],
    ['TO-2004', 'e8', 'Unpaid', '2026-07-06', '2026-07-06', 8, 'Personal', 'Pending Manager', '2026-06-17', null, null, null, null],
  ];
  for (const t of TIMEOFF) await q('INSERT INTO time_off(id,emp_id,type,start_date,end_date,hours,reason,status,submitted_on,mgr_by,mgr_on,pay_by,pay_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', t);

  const OUT = {
    u1: ['Review production board & cash position; clear blockers', 'Hit weekly build target; margins on plan', 'Monthly revenue & margin targets; capacity plan on track'],
    u2: ['Every workstation staffed & fed; daily build count met', 'Weekly unit output by model; scrap under 2%', 'Monthly throughput & on-time delivery; cross-train one specialist'],
    u8: ['Utility/landscape daily build count; deck quality', 'Weekly utility output target met', 'Monthly utility units; standard-hour adherence'],
    u11: ['Inspect every completed unit; log defects', 'Weekly QC throughput; zero escapes', 'Monthly first-pass yield above 97%'],
  };
  for (const [uid, o] of Object.entries(OUT))
    await q('INSERT INTO user_outcome(user_id,day,week,month,set_by,set_on) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)', [uid, o[0], o[1], o[2], 'System (default)']);

  const GOALS = [
    ['SG-1', 'u8', 'Learn TIG welding for aluminum boat parts', 'Quarter'],
    ['SG-2', 'u10', 'Cut paint waste 10% with new flash-off process', 'Month'],
    ['SG-3', 'u4', 'Open 2 new dealership accounts', 'Quarter'],
  ];
  for (const g of GOALS) await q('INSERT INTO self_goal(id,user_id,text,horizon) VALUES ($1,$2,$3,$4)', g);

  const WINS = [
    ['W-1', 'individual', 'u11', '100% first-pass yield this week', 'Zero defects escaped across 14 inspected units.', 'u2', '2026-06-15'],
    ['W-2', 'workstation', 'Welding', 'Zero rework on 12 frames', 'Clean welds, no grind-backs all week.', 'u6', '2026-06-14'],
    ['W-3', 'department', 'Sales', 'Record month: 18 dealer orders', 'Best booking month in company history.', 'u1', '2026-06-12'],
  ];
  for (const w of WINS) await q('INSERT INTO win(id,scope,target,title,detail,by_user,created_on) VALUES ($1,$2,$3,$4,$5,$6,$7)', w);
  const REACTS = [['W-1', '🎉', 'u1'], ['W-1', '🙌', 'u3'], ['W-2', '💪', 'u1'], ['W-2', '💪', 'u2'], ['W-3', '🎉', 'u2'], ['W-3', '🎉', 'u4']];
  for (const r of REACTS) await q('INSERT INTO win_reaction(win_id,emoji,user_id) VALUES ($1,$2,$3)', r);

  await q(`INSERT INTO notification(channel,recipient,body,kind,ref,mode,status) VALUES
     ('sms','High Desert Powersports','Your 3x Utility Trailer 7X14 Tandem (SO-1043) is now Confirmed.','order-status','SO-1043','simulated','sent'),
     ('sms','Purchasing','Low stock alert: Ball Coupler 2" below reorder point.','alert','BUY-COUP-200','simulated','sent')`);

  // Default approval rules: PO thresholds + new-vendor approvals
  // seq=1 = Accounting (Office Mgr), seq=2 = GM for larger amounts
  const RULES = [
    ['rule_po_acct',  'po', 500,    null,  'u3', 1, 'app', 'PO $500+ → Accounting'],
    ['rule_po_mgr',   'po', 2500,   null,  'u2', 2, 'app', 'PO $2,500+ → Shop Manager'],
    ['rule_po_gm',    'po', 5000,   null,  'u1', 3, 'app', 'PO $5,000+ → General Manager'],
    ['rule_vend_acct','vendor', null, null, 'u3', 1, 'app', 'New vendor → Accounting'],
    ['rule_vend_gm',  'vendor', null, null, 'u1', 2, 'app', 'New vendor → General Manager'],
  ];
  for (const [id, type, min, max, approver, seq, notify, label] of RULES) {
    await q('INSERT INTO approval_rule(id,type,min_amount,max_amount,approver_id,seq,notify,label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, type, min, max, approver, seq, notify, label]);
  }

  const counts = {};
  for (const t of ['role', 'app_user', 'vendor', 'part', 'model', 'bom_line', 'model_labor', 'trailer_type', 'customer', 'sales_order', 'purchase_order', 'accounting_event', 'employee', 'time_off', 'win', 'notification']) {
    counts[t] = Number((await q(`SELECT count(*)::int AS c FROM ${t}`)).rows[0].c);
  }
  console.log('Seeded:', JSON.stringify(counts));
  console.log('Login: username "tsoelberg" (General Manager) / password "built2026"');
  process.exit(0);
}
run().catch(e => { console.error('SEED FAILED:', e); process.exit(1); });
