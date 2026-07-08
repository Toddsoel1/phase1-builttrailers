// Single source of truth for the database STRUCTURE: base tables (schema.sql) + incremental
// column/table migrations. Run by BOTH the server at boot and the seed (db/seed.js), so the
// schema is identical no matter which runs first, and the server never depends on the seed.
// Every statement is idempotent (CREATE/ALTER ... IF NOT EXISTS), so it's safe to re-run.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { q, one } from '../src/db.js';

const colMigrations = [
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'standard'`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS ai_credits_used INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`,
  `CREATE TABLE IF NOT EXISTS role_section (role_name TEXT NOT NULL REFERENCES role(name) ON DELETE CASCADE, section TEXT NOT NULL, PRIMARY KEY (role_name, section))`,
  `CREATE TABLE IF NOT EXISTS user_title (user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE, role_name TEXT NOT NULL REFERENCES role(name) ON DELETE CASCADE, PRIMARY KEY (user_id, role_name))`,
  `ALTER TABLE model_labor ADD COLUMN IF NOT EXISTS rate NUMERIC(8,2) NOT NULL DEFAULT 35`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bom_line_uq ON bom_line(model_id,part_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_ws_uq ON model_labor(model_id,ws)`,
  `CREATE TABLE IF NOT EXISTS bom_change_request (id SERIAL PRIMARY KEY, model_id TEXT NOT NULL, model_name TEXT, requested_by TEXT NOT NULL, requester_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), op TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewer_name TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT)`,
  `CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT)`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS production_seq INTEGER`,
  `CREATE TABLE IF NOT EXISTS invoice_batch (id TEXT PRIMARY KEY, customer_id TEXT, customer_name TEXT, status TEXT NOT NULL DEFAULT 'Draft', total NUMERIC(12,2) NOT NULL DEFAULT 0, note TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), invoiced_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, external_id TEXT)`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS invoice_batch_id TEXT`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS billed BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS trailer (id TEXT PRIMARY KEY, order_id TEXT, model_id TEXT, customer_id TEXT, vin TEXT UNIQUE, serial INTEGER, status TEXT NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), vin_assigned_at TIMESTAMPTZ, vin_assigned_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS trailer_build_step (id SERIAL PRIMARY KEY, trailer_id TEXT NOT NULL, step TEXT NOT NULL, employee_id TEXT, employee_name TEXT, completed_at TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT, logged_by TEXT, UNIQUE(trailer_id, step))`,
  `CREATE TABLE IF NOT EXISTS warranty_registration (trailer_id TEXT PRIMARY KEY, owner_name TEXT, owner_contact TEXT, registered_at TIMESTAMPTZ NOT NULL DEFAULT now(), term_months INTEGER NOT NULL DEFAULT 12, registered_by TEXT, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS warranty_claim (id TEXT PRIMARY KEY, trailer_id TEXT NOT NULL, opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), status TEXT NOT NULL DEFAULT 'Open', issue TEXT, labor_cost NUMERIC(12,2) NOT NULL DEFAULT 0, shipping_cost NUMERIC(12,2) NOT NULL DEFAULT 0, opened_by TEXT, resolved_at TIMESTAMPTZ, resolution TEXT)`,
  `CREATE TABLE IF NOT EXISTS warranty_claim_part (id SERIAL PRIMARY KEY, claim_id TEXT NOT NULL, part_id TEXT, part_name TEXT, qty INTEGER NOT NULL DEFAULT 1, unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0)`,
  // Phase 4 — WIP execution: daily production updates by user/workstation drive stage-
  // completion consumption; consumption is ledgered for per-workstation reporting + WIP value.
  `CREATE TABLE IF NOT EXISTS work_log (id SERIAL PRIMARY KEY, log_date DATE NOT NULL DEFAULT CURRENT_DATE, user_id TEXT, order_id TEXT, workstation TEXT, stage TEXT, hours NUMERIC(8,2) NOT NULL DEFAULT 0, note TEXT, stage_complete BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS order_stage_done (order_id TEXT NOT NULL, stage TEXT NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_by TEXT, workstation TEXT, PRIMARY KEY(order_id, stage))`,
  `CREATE TABLE IF NOT EXISTS inventory_consumption (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(), log_date DATE NOT NULL DEFAULT CURRENT_DATE, order_id TEXT, stage TEXT, workstation TEXT, user_id TEXT, part_id TEXT, qty NUMERIC(12,3) NOT NULL DEFAULT 0, unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0, ext_value NUMERIC(14,2) NOT NULL DEFAULT 0)`,
  // Warranty registration portal: richer registration fields + maintenance log
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS email TEXT`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS warranty_address TEXT`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS sale_date DATE`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS selling_dealer TEXT`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS email_opt_in BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS proof_of_sale TEXT`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'verified'`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS within_15_days BOOLEAN`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS submitted_by TEXT`,
  `ALTER TABLE warranty_claim ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'`,
  `ALTER TABLE warranty_claim ADD COLUMN IF NOT EXISTS submitted_by TEXT`,
  `ALTER TABLE warranty_claim ADD COLUMN IF NOT EXISTS contact TEXT`,
  `CREATE TABLE IF NOT EXISTS maintenance_record (id SERIAL PRIMARY KEY, trailer_id TEXT NOT NULL, item TEXT NOT NULL, performed_on DATE, note TEXT, source TEXT, submitted_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS dealer_user (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT, dealership_name TEXT, customer_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), approved_by TEXT, approved_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS attachment (id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT, file_path TEXT NOT NULL, original_name TEXT, content_type TEXT, uploaded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_attach_entity ON attachment(entity_type, entity_id)`,
  `CREATE TABLE IF NOT EXISTS dealer_notification (id SERIAL PRIMARY KEY, customer_id TEXT NOT NULL, kind TEXT, body TEXT NOT NULL, ref TEXT, read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // Web-push subscriptions: owner_type 'staff' (app_user id) or 'dealer' (customer_id).
  `CREATE TABLE IF NOT EXISTS push_subscription (id SERIAL PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, sub_json TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_push_owner ON push_subscription(owner_type, owner_id)`,
  `CREATE TABLE IF NOT EXISTS document (id SERIAL PRIMARY KEY, title TEXT NOT NULL, model_id TEXT, category TEXT, file_path TEXT NOT NULL, content_type TEXT, uploaded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // Dealership user roles (admin/sales/service/warranty); existing accounts default to admin to keep access.
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'`,
  // Margin intelligence captured from the buyer's order at verification — Built Trailers staff only.
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2)`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS accessories TEXT`,
  // Sale date read off the uploaded buyer's order by OCR; used to auto-confirm the registration date.
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS ocr_sale_date DATE`,
  // Full address (warranty_address holds the street) — required on the owner portal, optional
  // elsewhere (dealer point-of-sale entry keeps its single free-text address field).
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS city TEXT`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS state TEXT`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS zip TEXT`,
  // Soft-inactivate customers/dealers (app use only) to keep the working list clean.
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`,
  // Soft-inactivate parts (app use only — does not touch QuickBooks).
  `ALTER TABLE part ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`,
  // Build lifecycle: remap legacy production stages to Build / Paint/Powder Coat / Finish / Ready.
  `UPDATE sales_order SET stage='Build'  WHERE stage='In Production'`,
  `UPDATE sales_order SET stage='Finish' WHERE stage='QC'`,
  `UPDATE sales_order SET stage='Ready'  WHERE stage='Ready / Shipped'`,
  // Orders imported from QuickBooks are already invoiced there — mark them billed so they
  // drop off the Build board and can never re-post a duplicate invoice.
  `UPDATE sales_order SET billed=true WHERE channel='QuickBooks' AND billed=false`,
  // BOM stage-tagging: each material line and labor step is assigned a build stage
  // (Build / Paint/Powder Coat / Finish) — drives when cost accrues in WIP (phase 4).
  `ALTER TABLE bom_line    ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'Build'`,
  `ALTER TABLE model_labor ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'Build'`,
  // Map each trailer model to its QuickBooks item so Accounting can push BOM cost to QB.
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS qb_item_id TEXT`,
  // Align terminology: the two account kinds are now "Dealership" and "Customer".
  `UPDATE customer SET kind='Customer' WHERE kind='Retail'`,
  // Owner accounts for owner.builttrailers.app — email = username, self-service password reset.
  `CREATE TABLE IF NOT EXISTS owner_user (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'active', reset_token TEXT, reset_expires TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login TIMESTAMPTZ)`,
  // Maintenance log gains mileage/hours + parts columns to match the BUILT maintenance schedule.
  `ALTER TABLE maintenance_record ADD COLUMN IF NOT EXISTS mileage TEXT`,
  `ALTER TABLE maintenance_record ADD COLUMN IF NOT EXISTS parts TEXT`,
  // VIN/MSO print jobs for the office: VIN label queues when paint begins, MSO when paint completes.
  `CREATE TABLE IF NOT EXISTS print_job (id SERIAL PRIMARY KEY, unit_id TEXT NOT NULL, order_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', queued_at TIMESTAMPTZ NOT NULL DEFAULT now(), printed_at TIMESTAMPTZ, printed_by TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_print_job_uq ON print_job(unit_id, kind)`,
  // Cycle counts: the operations specialist records counts; on-hand + the QB posting apply only
  // once the Office/General Manager approves.
  `CREATE TABLE IF NOT EXISTS cycle_count (id SERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', note TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_by TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT, qb_status TEXT, qb_external_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS cycle_count_line (id SERIAL PRIMARY KEY, count_id INTEGER NOT NULL, part_id TEXT NOT NULL, system_qty NUMERIC(14,3) NOT NULL DEFAULT 0, counted_qty NUMERIC(14,3) NOT NULL DEFAULT 0, unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_line ON cycle_count_line(count_id)`,
  // Boat Trailer Builder (dealer portal): a Nautique boat catalog + an office-editable options
  // catalog (each choice wired to real parts for BOM/inventory + a dealer price), and storage of
  // a submitted configuration on the order. Dollar figures seed at 0 and are admin-editable.
  `CREATE TABLE IF NOT EXISTS boat_make (id TEXT PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, sort INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS boat_model (id TEXT PRIMARY KEY, make_id TEXT NOT NULL, name TEXT NOT NULL, length_ft NUMERIC(5,1), beam_in NUMERIC(5,1), dry_weight_lb INTEGER, base_model_id TEXT, active BOOLEAN NOT NULL DEFAULT true, sort INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS option_group (id TEXT PRIMARY KEY, name TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, ui TEXT NOT NULL DEFAULT 'single', required BOOLEAN NOT NULL DEFAULT false, help TEXT, sort INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true)`,
  `CREATE TABLE IF NOT EXISTS option_choice (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, dealer_price NUMERIC(12,2) NOT NULL DEFAULT 0, is_default BOOLEAN NOT NULL DEFAULT false, active BOOLEAN NOT NULL DEFAULT true, sort INTEGER NOT NULL DEFAULT 0, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS option_choice_part (id SERIAL PRIMARY KEY, choice_id TEXT NOT NULL, part_id TEXT NOT NULL, qty NUMERIC(12,3) NOT NULL DEFAULT 1, op TEXT NOT NULL DEFAULT 'add', per_axle BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ocp_uq ON option_choice_part(choice_id, part_id, op)`,
  `CREATE INDEX IF NOT EXISTS idx_choice_group ON option_choice(group_id)`,
  `CREATE TABLE IF NOT EXISTS order_build (order_id TEXT PRIMARY KEY, boat_make TEXT, boat_model TEXT, boat_year INTEGER, boat_length NUMERIC(5,1), base_model_id TEXT, total_price NUMERIC(12,2) NOT NULL DEFAULT 0, note TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS order_build_option (id SERIAL PRIMARY KEY, order_id TEXT NOT NULL, group_id TEXT, group_name TEXT, choice_id TEXT, choice_name TEXT, dealer_price NUMERIC(12,2) NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_obo_order ON order_build_option(order_id)`,
  // Exclusive option groups (axle type, wheels) swap a base BOM part rather than add to it.
  `ALTER TABLE option_group ADD COLUMN IF NOT EXISTS exclusive BOOLEAN NOT NULL DEFAULT false`,
  // Per-order BOM deltas resolved at submit (signed: + adds, - removes), netted against the base
  // model BOM at stage-completion so a configured trailer consumes exactly its real parts.
  `CREATE TABLE IF NOT EXISTS order_bom_delta (id SERIAL PRIMARY KEY, order_id TEXT NOT NULL, part_id TEXT NOT NULL, qty NUMERIC(12,3) NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'Build')`,
  `CREATE INDEX IF NOT EXISTS idx_obd_order ON order_bom_delta(order_id, stage)`,
  // Paragon trailers are Nautique trailers — fold the Paragon make into Nautique.
  `UPDATE boat_model SET make_id='NQ' WHERE make_id='PG'`,
  `DELETE FROM boat_make WHERE id='PG'`,
  // Test mode: flag test customers/dealers/owners so their activity stays out of the Action Inbox
  // and can be wiped (admin only) without ever touching real data.
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE owner_user ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`,
  // Order editing + a reversible reject/cancel that keeps the record (stage -> 'Cancelled').
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS note TEXT`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
  `ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS prev_stage TEXT`,
  // Store the boat catalog id on a build so its configuration can be re-edited later.
  `ALTER TABLE order_build ADD COLUMN IF NOT EXISTS boat_id TEXT`,
  // Public dealer-locator fields on dealership customers (address + geocode). Populated by the office.
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS address TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS city TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS state TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS zip TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6)`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS lng NUMERIC(9,6)`,
  // Dealership address captured at signup (required), carried onto the customer record at approval.
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS address TEXT`,
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS city TEXT`,
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS state TEXT`,
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS zip TEXT`,
  // Self-service email password reset for dealers (mirrors owner_user's reset_token/reset_expires).
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS reset_token TEXT`,
  `ALTER TABLE dealer_user ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ`,
  // Retrofit columns that were added to schema.sql's CREATE TABLE statements after production's
  // tables already existed — CREATE TABLE IF NOT EXISTS never alters an existing table, so any
  // database bootstrapped from the original schema is missing them. vendor.status broke
  // /api/parts (Parts Master) in production the moment a query selected it explicitly.
  `ALTER TABLE vendor ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS phone TEXT`,
  // Tracks the matching QuickBooks Vendor Id once a local vendor is pushed to (or pulled from) QBO.
  `ALTER TABLE vendor ADD COLUMN IF NOT EXISTS qbo_id TEXT`,
  // Staff email (dealer_user/owner_user already use email as their login; staff log in by
  // username, so email is contact info — used for notifications as email features land).
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email TEXT`,
  // One-shot reminder bookkeeping so the daily owner-reminder job never double-sends.
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS expiry_reminder_sent TIMESTAMPTZ`,
  `ALTER TABLE warranty_registration ADD COLUMN IF NOT EXISTS maintenance_reminder_sent TIMESTAMPTZ`,
  // Customer-merge map: which duplicate ids were folded into which survivor. Consulted by the
  // QuickBooks customer pull so a merged-away 'qbo_*' customer can never be resurrected.
  `CREATE TABLE IF NOT EXISTS customer_merge (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, merged_at TIMESTAMPTZ NOT NULL DEFAULT now(), merged_by TEXT)`,
  // Andon: shop-floor problem reports (raised from the traveler QR station page). Open = the
  // floor is waiting; resolved_at - raised_at = blocked time feeding the blocker Pareto.
  `CREATE TABLE IF NOT EXISTS andon_event (id SERIAL PRIMARY KEY, order_id TEXT NOT NULL, unit_id TEXT, stage TEXT, reason TEXT NOT NULL, note TEXT, raised_by TEXT, raised_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_by TEXT, resolved_at TIMESTAMPTZ, resolution TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_andon_open ON andon_event(order_id) WHERE resolved_at IS NULL`,
  // Who completed a stage when it wasn't a logged-in user (shop-floor QR scans record initials).
  `ALTER TABLE order_stage_done ADD COLUMN IF NOT EXISTS completed_label TEXT`,
  // Daily Stand-Up: each worker's default station (drives auto-assignment) + the day's task
  // list — proposed by the generator, approved/adjusted by the Shop Manager, checked off by
  // the worker (or auto-checked when the underlying stage completes). Rows are permanent, so
  // the per-employee planned-vs-actual record IS the table.
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS workstation TEXT`,
  // Weekly work schedule per employee (JSON: {days:[1..4], hours:10, start:"06:00"}). Null =
  // the shop default (Mon–Thu, 10-hour days). Drives stand-up assignment + capacity; shifts
  // and Fri/Sat crews later are just different values here.
  `ALTER TABLE app_user ADD COLUMN IF NOT EXISTS schedule TEXT`,
  // End-of-day 60-second verification: the employee confirms what they completed.
  `CREATE TABLE IF NOT EXISTS day_verification (user_id TEXT NOT NULL, plan_date DATE NOT NULL,
     verified_at TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT, PRIMARY KEY (user_id, plan_date))`,
  // Workstation registry — stations exist beyond what the model routing mentions (Sub-Assembly,
  // made-parts benches...). stage maps a station to the production stage its work belongs to.
  `CREATE TABLE IF NOT EXISTS workstation (name TEXT PRIMARY KEY, stage TEXT, active BOOLEAN NOT NULL DEFAULT true)`,
  // Who built made/sub-assembly parts, when, how many — the person-attributed record behind
  // "My Work" (parts by part number) that stock movements alone never captured.
  `CREATE TABLE IF NOT EXISTS part_build_log (id SERIAL PRIMARY KEY, part_id TEXT NOT NULL,
     qty NUMERIC(12,2) NOT NULL, user_id TEXT, note TEXT, built_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_pbl_user ON part_build_log(user_id, built_at)`,
  // Time surveys: periodic post-verification "how long did these actually take?" — the actuals
  // that audit BOM labor hours and made-part costs. Completed items link back to the survey
  // that covered them, so each is asked about exactly once.
  `CREATE TABLE IF NOT EXISTS time_survey (id SERIAL PRIMARY KEY, user_id TEXT NOT NULL,
     total_minutes INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS time_survey_line (id SERIAL PRIMARY KEY, survey_id INT NOT NULL,
     kind TEXT NOT NULL, order_id TEXT, stage TEXT, model_id TEXT, part_id TEXT,
     description TEXT NOT NULL, qty NUMERIC(12,2) NOT NULL DEFAULT 1, minutes INT NOT NULL DEFAULT 0)`,
  `ALTER TABLE trailer_build_step ADD COLUMN IF NOT EXISTS time_survey_id INT`,
  `ALTER TABLE part_build_log ADD COLUMN IF NOT EXISTS time_survey_id INT`,
  // When the PO actually arrived — the supplier scorecard's raw material (actual vs promised
  // lead time, on-time %), which also self-corrects the MRP's lead-time math.
  `ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS daily_task (id SERIAL PRIMARY KEY, plan_date DATE NOT NULL, user_id TEXT,
     order_id TEXT, stage TEXT, workstation TEXT, description TEXT NOT NULL,
     est_hours NUMERIC(8,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'proposed',
     source TEXT NOT NULL DEFAULT 'auto', assigned_by TEXT, approved_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ, completed_via TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_dtask_date ON daily_task(plan_date, user_id)`,
  // Per-model print specs for the federal VIN label + MSO (from the office's physical samples):
  // GVWR, empty/shipping weight (cargo max = GVWR - empty), tire/rim/PSI, overall length.
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS gvwr_lbs INT`,
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS empty_weight_lbs INT`,
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS tire TEXT`,
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS rim TEXT`,
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS tire_psi INT`,
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS length_ft NUMERIC(5,1)`,
  // VIN positions 4-8 per the filed Part 565 scheme: hitch, body type, (length above), axles.
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS hitch_code TEXT`,
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS body_code TEXT`,
  `ALTER TABLE model ADD COLUMN IF NOT EXISTS axles INT`,
  // The vendor's own part number — what actually goes on POs and vendor communication.
  `ALTER TABLE part ADD COLUMN IF NOT EXISTS vendor_part_no TEXT`,
  // Bill-to vs ship-to per dealership: some dealers bill through a corporate/parent entity.
  // Blank bill_name = bill the dealership itself. The MSO's Sold-to and every invoice use the
  // bill-to; the Bill of Lading and deliveries use the dealership's own (ship-to) address.
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS bill_name TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS bill_address TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS bill_city TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS bill_state TEXT`,
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS bill_zip TEXT`,
  // When the ship-to location can take deliveries: JSON {days:[1..7], start, end, note}.
  `ALTER TABLE customer ADD COLUMN IF NOT EXISTS delivery_window TEXT`,
  // Landed-cost receiving: a vendor invoice covers one or more POs; its shipping/tax/other
  // charges allocate across the lines so parts carry FULLY LANDED cost, and the one bill
  // posted to the books equals the invoice bottom line exactly.
  `ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS shipping NUMERIC(12,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS tax NUMERIC(12,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS other NUMERIC(12,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS other_label TEXT`,
  `ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS parts_total NUMERIC(12,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS invoice_id TEXT`,
  `ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS landed_extra NUMERIC(12,2) NOT NULL DEFAULT 0`,
  // Opening/baseline counts: set on-hand as the starting truth WITHOUT posting a QuickBooks
  // variance — the clean-start tool for the initial wall-to-wall count (QBO gets one manual
  // accountant journal instead of a giant "variance" that would double-count two years of books).
  `ALTER TABLE cycle_count ADD COLUMN IF NOT EXISTS opening BOOLEAN NOT NULL DEFAULT false`,
  // Over-the-counter part sales: one action deducts stock, invoices the buyer, and relieves
  // COGS — so selling a spare fender never means stepping outside the app.
  `CREATE TABLE IF NOT EXISTS part_sale (id SERIAL PRIMARY KEY, customer_id TEXT, party TEXT NOT NULL,
     total NUMERIC(12,2) NOT NULL DEFAULT 0, cost_total NUMERIC(12,2) NOT NULL DEFAULT 0,
     note TEXT, sold_by TEXT, sold_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS part_sale_line (id SERIAL PRIMARY KEY, sale_id INT NOT NULL,
     part_id TEXT NOT NULL, qty NUMERIC(12,2) NOT NULL, unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
     unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_psl_sale ON part_sale_line(sale_id)`,
  // Reprint controls: a reprint requeues the job with a mandatory reason, and every event
  // lands in a permanent register — an MSO is a title document, so duplicates must be traceable.
  `ALTER TABLE print_job ADD COLUMN IF NOT EXISTS reprint_count INT NOT NULL DEFAULT 0`,
  `ALTER TABLE print_job ADD COLUMN IF NOT EXISTS reprint_reason TEXT`,
  `CREATE TABLE IF NOT EXISTS print_reprint (id SERIAL PRIMARY KEY, unit_id TEXT NOT NULL,
     kind TEXT NOT NULL, reason TEXT NOT NULL, requested_by TEXT,
     requested_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // NHTSA vPIC verification per VIN: checked when, pass/fail, and what the decoder said.
  `ALTER TABLE trailer ADD COLUMN IF NOT EXISTS nhtsa_checked_at TIMESTAMPTZ`,
  `ALTER TABLE trailer ADD COLUMN IF NOT EXISTS nhtsa_ok BOOLEAN`,
  `ALTER TABLE trailer ADD COLUMN IF NOT EXISTS nhtsa_note TEXT`,
  // A dealer's "I'll take that one" on an unsold stock build — staff approve (which sells the
  // order via the existing assign-customer path) or decline; competing requests auto-decline.
  `CREATE TABLE IF NOT EXISTS stock_request (id SERIAL PRIMARY KEY, order_id TEXT NOT NULL,
     dealer_user_id TEXT, customer_id TEXT NOT NULL, note TEXT,
     status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     decided_by TEXT, decided_at TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS idx_stockreq_pending ON stock_request(order_id) WHERE status='pending'`,
];

// Admin lockout self-heal, run at every boot. The tier dropdown on the Users screen saves
// instantly, and user edits lazily recompute app_user.role from title tiers — so one stray
// click on "General Manager -> editor" silently demotes the GM on their next profile edit
// (exactly how the owner lost the Users tab in production). Invariants enforced here:
//   1. The General Manager title is always admin tier (the app hardcodes GM as privileged).
//   2. Anyone holding an admin-tier title has role='admin' (promote-only resync — never demotes).
export async function ensureAdminInvariant() {
  const gm = await one(`SELECT tier FROM role WHERE name='General Manager'`, []).catch(() => null);
  if (gm && gm.tier !== 'admin') {
    await q(`UPDATE role SET tier='admin' WHERE name='General Manager'`);
    await q(`INSERT INTO audit_log(user_id,action,detail) VALUES (NULL,'role.selfheal',$1)`,
      [`General Manager tier restored to admin (was ${gm.tier})`]).catch(() => {});
    console.warn(`admin invariant: 'General Manager' tier was '${gm.tier}' — restored to admin`);
  }
  const promoted = await q(`UPDATE app_user SET role='admin'
     WHERE role<>'admin' AND id IN (SELECT ut.user_id FROM user_title ut JOIN role r ON r.name=ut.role_name WHERE r.tier='admin')`).catch(() => null);
  const n = promoted?.rowCount ?? promoted?.affectedRows ?? 0;
  if (n) {
    await q(`INSERT INTO audit_log(user_id,action,detail) VALUES (NULL,'user.selfheal',$1)`,
      [`${n} user(s) holding an admin-tier title promoted back to admin`]).catch(() => {});
    console.warn(`admin invariant: promoted ${n} user(s) holding an admin-tier title back to admin`);
  }
  return { promoted: n, gmRestored: !!(gm && gm.tier !== 'admin') };
}

export async function ensureSchema() {
  // 1) Base tables from schema.sql (split on ';' after stripping line comments).
  const schemaSql = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  const ddl = schemaSql.replace(/--[^\n]*/g, '');
  for (const stmt of ddl.split(';').map(s => s.trim()).filter(Boolean)) {
    await q(stmt).catch(e => console.warn('schema:', e.message));
  }
  // 2) Incremental migrations.
  for (const m of colMigrations) {
    await q(m).catch(e => console.warn('migration:', e.message));
  }
}
