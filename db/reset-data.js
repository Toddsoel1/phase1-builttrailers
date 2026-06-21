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
  console.log('Done. All business data cleared.');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
