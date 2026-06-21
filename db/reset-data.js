// Wipes all transactional/business data from the live database.
// Keeps: roles, users, vendors, parts, models, BOMs, trailer types.
// Wipes: orders, customers, accounting, invoices, employees, time-off,
//        goals, wins, notifications, approvals, support tickets, audit logs.
import { initDb, q } from '../src/db.js';

const WIPE = [
  'support_message',
  'support_ticket',
  'win_reaction',
  'win',
  'self_goal',
  'user_outcome',
  'time_off',
  'employee',
  'approval_request',
  'approval_rule',
  'notification',
  'qbo_error_log',
  'sms_optin',
  'accounting_event',
  'vendor_invoice',
  'purchase_order',
  'audit_log',
  'sales_order',
  'customer_allowed_type',
  'customer',
];

async function run() {
  await initDb();
  console.log('Connected. Wiping transactional data...');
  for (const table of WIPE) {
    await q(`DELETE FROM ${table}`);
    console.log(`  ✓ ${table}`);
  }
  // Zero out all inventory on-hand quantities
  await q(`UPDATE part SET on_hand=0`);
  console.log('  ✓ part.on_hand — zeroed out');
  // Remove all non-admin seed users (no activity exists after wiping above)
  const deleted = await q(`DELETE FROM app_user WHERE username != 'tsoelberg' RETURNING username`);
  console.log(`  ✓ app_user — removed ${deleted.rows.length} test accounts`);
  console.log('Done. Ready for real data.');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
