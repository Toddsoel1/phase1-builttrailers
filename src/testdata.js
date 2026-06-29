// Test mode — provision flagged test dealer/owner portal accounts, and a FAILPROOF, admin-only
// wipe of all test data. Everything hangs off an is_test customer (dealer side) or is_test owner.
// Every DELETE here is scoped by a subquery on is_test, so real data can never be touched — if
// there is no test data the subqueries are empty and every delete is a 0-row no-op.
import { q, all, one } from './db.js';
import { hashPassword } from './auth.js';

// Constant SQL fragments (no user input) tracing the test-data graph from the is_test anchors.
const TEST_CUST = `(SELECT id FROM customer WHERE is_test=true)`;
const TEST_ORD = `(SELECT id FROM sales_order WHERE customer_id IN ${TEST_CUST})`;
const TEST_TRL = `(SELECT id FROM trailer WHERE order_id IN ${TEST_ORD})`;
const TEST_OWNER = `(SELECT id FROM owner_user WHERE is_test=true)`;
export const TEST_FILTERS = { TEST_CUST, TEST_ORD, TEST_TRL, TEST_OWNER };

// Fixed, known test credentials — these accounts are test-flagged, isolated from the Action Inbox,
// and wiped on demand, so a memorable password is an acceptable trade for easy testing.
const DEALER_EMAIL = 'dealer@builttrailers.test';
const OWNER_EMAIL = 'owner@builttrailers.test';
const TEST_PW = 'builttest2026';
const rows = r => r.rowCount ?? r.affectedRows ?? 0;          // pg vs PGlite

export async function testStatus() {
  const c = async sql => Number((await one(sql))?.n || 0);
  return {
    customers: await c(`SELECT COUNT(*)::int AS n FROM customer WHERE is_test=true`),
    dealers: await c(`SELECT COUNT(*)::int AS n FROM dealer_user WHERE is_test=true`),
    owners: await c(`SELECT COUNT(*)::int AS n FROM owner_user WHERE is_test=true`),
    orders: await c(`SELECT COUNT(*)::int AS n FROM sales_order WHERE customer_id IN ${TEST_CUST}`),
    trailers: await c(`SELECT COUNT(*)::int AS n FROM trailer WHERE order_id IN ${TEST_ORD}`),
    dealerEmail: DEALER_EMAIL, ownerEmail: OWNER_EMAIL, password: TEST_PW,
  };
}

// Create (or reset the password of) a pre-approved, test-flagged dealer + owner login. The dealer
// is linked to a test dealership authorized for every trailer category, so it can configure boats.
export async function provisionTestAccounts() {
  let cust = await one(`SELECT * FROM customer WHERE is_test=true ORDER BY id LIMIT 1`);
  if (!cust) {
    await q(`INSERT INTO customer(id,name,kind,is_test,active) VALUES('TESTDLR','🧪 Test Dealership','Dealership',true,true) ON CONFLICT(id) DO NOTHING`);
    for (const t of ['Boat', 'Watercraft', 'Utility', 'Landscape', 'BBQ'])
      await q(`INSERT INTO customer_allowed_type(customer_id,type) VALUES('TESTDLR',$1) ON CONFLICT DO NOTHING`, [t]);
    cust = await one(`SELECT * FROM customer WHERE id='TESTDLR'`);
  }
  const hash = hashPassword(TEST_PW);
  await q(`INSERT INTO dealer_user(id,email,password_hash,name,dealership_name,customer_id,status,role,is_test)
           VALUES('TESTDEALER',$1,$2,'Test Dealer','🧪 Test Dealership',$3,'active','admin',true)
           ON CONFLICT(email) DO UPDATE SET password_hash=$2, status='active', is_test=true, customer_id=$3`,
    [DEALER_EMAIL, hash, cust.id]);
  await q(`INSERT INTO owner_user(id,email,password_hash,name,status,is_test)
           VALUES('TESTOWNER',$1,$2,'Test Owner','active',true)
           ON CONFLICT(email) DO UPDATE SET password_hash=$2, status='active', is_test=true`,
    [OWNER_EMAIL, hash]);
  return { dealer: { email: DEALER_EMAIL, password: TEST_PW }, owner: { email: OWNER_EMAIL, password: TEST_PW } };
}

// Failproof wipe: delete child rows first, then parents — every statement scoped to is_test.
export async function wipeTestData() {
  const counts = {};
  const del = async (label, sql) => { counts[label] = (counts[label] || 0) + rows(await q(sql)); };
  // configured-build + WIP + print rows for test orders
  await del('builds', `DELETE FROM order_build_option WHERE order_id IN ${TEST_ORD}`);
  await del('builds', `DELETE FROM order_bom_delta WHERE order_id IN ${TEST_ORD}`);
  await del('builds', `DELETE FROM order_build WHERE order_id IN ${TEST_ORD}`);
  await del('wip', `DELETE FROM inventory_consumption WHERE order_id IN ${TEST_ORD}`);
  await del('wip', `DELETE FROM work_log WHERE order_id IN ${TEST_ORD}`);
  await del('wip', `DELETE FROM order_stage_done WHERE order_id IN ${TEST_ORD}`);
  await del('print', `DELETE FROM print_job WHERE order_id IN ${TEST_ORD} OR unit_id IN ${TEST_TRL}`);
  // warranty + maintenance on test trailers, and anything the test owner submitted
  await del('claims', `DELETE FROM warranty_claim_part WHERE claim_id IN (SELECT id FROM warranty_claim WHERE trailer_id IN ${TEST_TRL} OR submitted_by IN ${TEST_OWNER})`);
  await del('claims', `DELETE FROM warranty_claim WHERE trailer_id IN ${TEST_TRL} OR submitted_by IN ${TEST_OWNER}`);
  await del('registrations', `DELETE FROM warranty_registration WHERE trailer_id IN ${TEST_TRL}`);
  await del('maintenance', `DELETE FROM maintenance_record WHERE trailer_id IN ${TEST_TRL} OR submitted_by IN ${TEST_OWNER}`);
  await del('trailers', `DELETE FROM trailer WHERE order_id IN ${TEST_ORD}`);
  // push subscriptions for the test dealer/owner
  await del('push', `DELETE FROM push_subscription WHERE (owner_type='dealer' AND owner_id IN ${TEST_CUST}) OR (owner_type='owner' AND owner_id IN ${TEST_OWNER})`);
  // test orders, dealer scaffolding, and the accounts/customer themselves
  await del('notifications', `DELETE FROM dealer_notification WHERE customer_id IN ${TEST_CUST}`);
  await del('orders', `DELETE FROM sales_order WHERE customer_id IN ${TEST_CUST}`);
  await del('dealers', `DELETE FROM dealer_user WHERE is_test=true OR customer_id IN ${TEST_CUST}`);
  await del('owners', `DELETE FROM owner_user WHERE is_test=true`);
  await del('allowedTypes', `DELETE FROM customer_allowed_type WHERE customer_id IN ${TEST_CUST}`);
  await del('customers', `DELETE FROM customer WHERE is_test=true`);
  return counts;
}
