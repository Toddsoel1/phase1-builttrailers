// Action Inbox engine — the single source of truth for "what does THIS person
// need to do right now." Used by both the dashboard inbox card (/api/inbox) and
// the 7am SMS briefing (briefing.js) so the two can never disagree.
//
// Each item: { key, icon, label, count, link }
//   link = the in-app page to open (matches a NAV key in index.html)
import { all, one } from './db.js';

// Resolve a raw app_user row into the shape actionItemsFor() expects.
// Admins implicitly have every section (sections = null).
export async function resolveUserForInbox(u) {
  if (u.role === 'admin') return { id: u.id, role: 'admin', sections: null };
  const rows = await all(
    `SELECT DISTINCT rs.section
       FROM user_title ut JOIN role_section rs ON rs.role_name = ut.role_name
      WHERE ut.user_id = $1`, [u.id]).catch(() => []);
  return { id: u.id, role: u.role, sections: rows.map(r => r.section) };
}

// Small helper so a missing table (pre-migration) never breaks the inbox.
async function count(sql, params = []) {
  const r = await one(sql, params).catch(() => null);
  return r ? Number(r.n) : 0;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// user = { id, role, sections }  (sections null = admin = sees everything)
export async function actionItemsFor(user) {
  const items = [];
  const isAdmin = user.role === 'admin';
  const has = s => isAdmin || (Array.isArray(user.sections) && user.sections.includes(s));

  // 1. PO / vendor approvals routed specifically to me (personal — not section-gated)
  const myApprovals = await count(
    `SELECT COUNT(*)::int AS n FROM approval_request WHERE approver_id=$1 AND status='pending'`, [user.id]);
  if (myApprovals) items.push({ key: 'approvals', icon: '✅',
    label: `${plural(myApprovals, 'approval')} awaiting your sign-off`, count: myApprovals, link: 'pos' });

  // 2. BOM change requests awaiting accounting review
  if (has('accounting')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM bom_change_request WHERE status='pending'`);
    if (n) items.push({ key: 'bomcr', icon: '🧩',
      label: `${plural(n, 'BOM change')} to review`, count: n, link: 'accounting' });
  }

  // 3. POs that have arrived and are ready to receive
  if (has('pos')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM purchase_order WHERE status='Open'`);
    if (n) items.push({ key: 'po_receive', icon: '📦',
      label: `${plural(n, 'PO')} ready to receive`, count: n, link: 'pos' });
  }

  // 4. Parts that have dropped below their reorder point
  if (has('predict') || has('pos')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM part WHERE on_hand < reorder`);
    if (n) items.push({ key: 'low_stock', icon: '⚠️',
      label: `${plural(n, 'part')} below reorder level`, count: n, link: 'predict' });
  }

  // 5. Open orders due within a week (not yet shipped, past the quote stage)
  if (has('orders')) {
    const n = await count(
      `SELECT COUNT(*)::int AS n FROM sales_order
        WHERE stage NOT IN ('Quote','Ready / Shipped')
          AND due IS NOT NULL AND due <= (CURRENT_DATE + INTERVAL '7 days')`);
    if (n) items.push({ key: 'orders_due', icon: '📋',
      label: `${plural(n, 'order')} due within 7 days`, count: n, link: 'orders' });
  }

  // 5b. Open warranty claims (trailers section)
  if (has('trailers')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM warranty_claim WHERE status='Open'`);
    if (n) items.push({ key: 'warranty_claims', icon: '🛠️',
      label: `${plural(n, 'open warranty claim')}`, count: n, link: 'trailers' });
  }

  // 6. Time-off requests from MY direct reports waiting on my approval
  const myTimeoff = await count(
    `SELECT COUNT(*)::int AS n FROM time_off t JOIN employee e ON e.id=t.emp_id
      WHERE e.mgr_id=$1 AND t.status='Pending Manager'`, [user.id]);
  if (myTimeoff) items.push({ key: 'timeoff', icon: '📅',
    label: `${plural(myTimeoff, 'time-off request')} to approve`, count: myTimeoff, link: 'timeoff' });

  // 7. Approved time-off waiting to be processed into payroll (office manager / admin)
  if (has('team')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM time_off WHERE status='Approved - To Payroll'`);
    if (n) items.push({ key: 'to_payroll', icon: '💵',
      label: `${plural(n, 'time-off item')} to process for payroll`, count: n, link: 'timeoff' });
  }

  // 8. Support tickets users escalated for human review (admin)
  if (isAdmin) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM support_ticket WHERE status='escalated'`);
    if (n) items.push({ key: 'tickets', icon: '🆘',
      label: `${plural(n, 'support ticket')} to review`, count: n, link: 'support' });
  }

  return items;
}
