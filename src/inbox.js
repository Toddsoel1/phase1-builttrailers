// Action Inbox engine — the single source of truth for "what does THIS person
// need to do right now." Used by both the dashboard inbox card (/api/inbox) and
// the 7am SMS briefing (briefing.js) so the two can never disagree.
//
// Each item: { key, icon, label, count, link }
//   link = the in-app page to open (matches a NAV key in index.html)
import { all, one } from './db.js';
import { TEST_FILTERS as T } from './testdata.js'; // exclude flagged test data from the inbox
import { replenishment, scorecard } from './analytics.js';
import { pendingFor as timeSurveyPending } from './timesurvey.js';

// Resolve a raw app_user row into the shape actionItemsFor() expects.
// Admins implicitly have every section (sections = null). Titles ride along so
// title-targeted pushes (Shop Specialist replenishment, SM/GM performance) can route.
export async function resolveUserForInbox(u) {
  const titleRows = await all('SELECT role_name FROM user_title WHERE user_id=$1', [u.id]).catch(() => []);
  const titles = titleRows.length ? titleRows.map(r => r.role_name) : (u.title ? [u.title] : []);
  if (u.role === 'admin') return { id: u.id, role: 'admin', sections: null, titles };
  const rows = await all(
    `SELECT DISTINCT rs.section
       FROM user_title ut JOIN role_section rs ON rs.role_name = ut.role_name
      WHERE ut.user_id = $1`, [u.id]).catch(() => []);
  return { id: u.id, role: u.role, sections: rows.map(r => r.section), titles };
}

// Small helper so a missing table (pre-migration) never breaks the inbox.
async function count(sql, params = []) {
  const r = await one(sql, params).catch(() => null);
  return r ? Number(r.n) : 0;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// user = { id, role, sections, titles }  (sections null = admin = sees everything)
export async function actionItemsFor(user) {
  const items = [];
  const isAdmin = user.role === 'admin';
  const has = s => isAdmin || (Array.isArray(user.sections) && user.sections.includes(s));
  const titles = Array.isArray(user.titles) ? user.titles : [];
  const holds = (...names) => names.some(t => titles.includes(t));

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

  // 3. POs that have arrived and are ready to receive. The carrier saying "Delivered" is a
  //    claim — a staff member confirming receipt is what actually updates inventory, so
  //    carrier-delivered-but-unconfirmed POs get their own louder line.
  if (has('pos')) {
    const arrived = await count(
      `SELECT COUNT(DISTINCT po.id)::int AS n FROM purchase_order po
        JOIN po_ack a ON a.po_id = po.id
       WHERE po.status='Open' AND a.tracking_status ILIKE '%deliver%'`);
    if (arrived) items.push({ key: 'po_arrived', icon: '🚚',
      label: `${plural(arrived, 'PO')} delivered per the carrier — confirm receipt to update inventory`, count: arrived, link: 'pos' });
    const n = await count(`SELECT COUNT(*)::int AS n FROM purchase_order WHERE status='Open'`);
    if (n) items.push({ key: 'po_receive', icon: '📦',
      label: `${plural(n, 'PO')} ready to receive`, count: n, link: 'pos' });
  }

  // 3b. Dealer stock requests — a dealership wants an unsold stock build; first yes wins it.
  if (has('orders')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM stock_request WHERE status='pending'`);
    if (n) items.push({ key: 'stock_requests', icon: '🏷️',
      label: `${plural(n, 'dealer stock request')} awaiting a yes/no`, count: n, link: 'orders' });
  }

  // 3c. VINs that failed NHTSA vPIC verification — a compliance problem for the office.
  if (isAdmin || holds('Office Manager', 'General Manager')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM trailer WHERE nhtsa_ok = false`);
    if (n) items.push({ key: 'nhtsa_fail', icon: '🛑',
      label: `${plural(n, 'VIN')} failed the NHTSA check — fix before labels/MSOs print`, count: n, link: 'printcenter' });
  }

  // 3d. Pricing gaps — nothing sits at $0: unpriced parts (dealers see "Call for price", BOM
  //     cost and COGS run light) + $0 option choices not marked included-in-standard.
  if (isAdmin || has('parts_edit')) {
    const nParts = await count(`SELECT COUNT(*)::int AS n FROM part WHERE active <> false AND COALESCE(cost,0) <= 0`);
    const nOpts = await count(`SELECT COUNT(*)::int AS n FROM option_choice c JOIN option_group g ON g.id=c.group_id
                                WHERE c.active AND g.active AND COALESCE(c.dealer_price,0) <= 0 AND c.included = false`);
    const nReq = await count(`SELECT COUNT(*)::int AS n FROM price_request WHERE status='open'`);
    if (nParts + nOpts) items.push({ key: 'pricing_gaps', icon: '💲',
      label: `${plural(nParts + nOpts, 'pricing gap')} — nothing should sit at $0${nReq ? ` (${plural(nReq, 'dealer request')} waiting)` : ''}`,
      count: nParts + nOpts, link: 'parts' });
  }

  // 4. Replenishment — never run out of what the scheduled orders need.
  //    Shop Specialist / Shop Manager (and admins) get the targeted MRP push with specifics:
  //    ORDER NOW / BUILD NOW when a part will run out before replenishment can land.
  if (isAdmin || holds('Shop Specialist', 'Shop Manager', 'Shop Assistant Specialist')) {
    try {
      const rep = await replenishment();
      const name = list => list[0] ? `${list[0].id}${list.length > 1 ? ` +${list.length - 1} more` : ''}` : '';
      if (rep.critBuy.length) items.push({ key: 'order_now', icon: '🚨',
        label: `ORDER NOW: ${name(rep.critBuy)} — will run out before a PO can land`, count: rep.critBuy.length, link: 'predict' });
      if (rep.critMake.length) items.push({ key: 'build_now', icon: '🔨',
        label: `BUILD NOW: ${name(rep.critMake)} — make-part(s) short for scheduled orders`, count: rep.critMake.length, link: 'predict' });
      const soon = rep.warnBuy.length + rep.warnMake.length;
      if (soon) items.push({ key: 'replenish_soon', icon: '🛒',
        label: `${plural(soon, 'part')} below reorder — order or schedule builds this week`, count: soon, link: 'predict' });
    } catch { /* MRP unavailable pre-migration — fall through to the generic count below */ }
  } else if (has('predict') || has('pos')) {
    // Everyone else with inventory visibility keeps the simple low-stock nudge.
    const n = await count(`SELECT COUNT(*)::int AS n FROM part WHERE on_hand < reorder`);
    if (n) items.push({ key: 'low_stock', icon: '⚠️',
      label: `${plural(n, 'part')} below reorder level`, count: n, link: 'predict' });
  }

  // 4a. Andon: open shop-floor problems mean someone is waiting RIGHT NOW.
  if (isAdmin || holds('Shop Manager', 'General Manager')) {
    const oa = await count(`SELECT COUNT(*)::int AS n FROM andon_event WHERE resolved_at IS NULL`);
    if (oa) items.push({ key: 'andon', icon: '🚨',
      label: `${plural(oa, 'shop-floor problem')} open — the floor is waiting`, count: oa, link: 'orders' });
  }

  // 4a2. Daily plan: workers see today's goal; the SM is nudged while the plan sits unapproved.
  const todayStr = new Date().toISOString().slice(0, 10);
  const myTasks = await count(`SELECT COUNT(*)::int AS n FROM daily_task
                                WHERE plan_date=$1 AND user_id=$2 AND status='approved' AND completed_at IS NULL`, [todayStr, user.id]);
  if (myTasks) items.push({ key: 'my_day', icon: '🎯',
    label: `${plural(myTasks, 'task')} on your plan today`, count: myTasks, link: 'standup' });
  // Late-day: nudge the 60-second verification once the shift is winding down (4pm local).
  const localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: process.env.BRIEFING_TZ || 'America/Denver', hour: '2-digit', hour12: false }).format(new Date()));
  if (localHour >= 16) {
    const hadPlan = await count(`SELECT COUNT(*)::int AS n FROM daily_task WHERE plan_date=$1 AND user_id=$2 AND status<>'proposed'`, [todayStr, user.id]);
    const verified = await count(`SELECT COUNT(*)::int AS n FROM day_verification WHERE plan_date=$1 AND user_id=$2`, [todayStr, user.id]);
    if (hadPlan && !verified) items.push({ key: 'verify_day', icon: '⏱',
      label: '60-second check: verify what you completed today', count: 1, link: 'standup' });
  }
  // Time survey due: enough completed work has piled up to put real minutes against it.
  try {
    const ts = await timeSurveyPending(user.id);
    if (ts.due) items.push({ key: 'time_survey', icon: '⏲',
      label: `Quick time check — put minutes on ${plural(ts.itemCount, 'completed item')} (keeps the BOMs honest)`,
      count: ts.itemCount, link: 'standup' });
  } catch { /* pre-migration — skip */ }
  if (isAdmin || holds('Shop Manager', 'General Manager')) {
    const prop = await count(`SELECT COUNT(*)::int AS n FROM daily_task WHERE plan_date=$1 AND status='proposed'`, [todayStr]);
    if (prop) items.push({ key: 'standup_approve', icon: '📣',
      label: `Today's plan awaits your approval (${plural(prop, 'proposed task')})`, count: prop, link: 'standup' });
  }

  // 4b. Performance expectations — Shop Manager / General Manager get told when the shop
  //     is missing the bar (on-time, build time, stuck WIP, claim rate), with the detail
  //     one click away on the Performance screen.
  if (isAdmin || holds('Shop Manager', 'General Manager')) {
    try {
      const sc = await scorecard();
      const misses = sc.recommendations.filter(r => r.sev === 'miss');
      if (misses.length) items.push({ key: 'perf_miss', icon: '📉',
        label: `${plural(misses.length, 'performance expectation')} missed — ${misses[0].text.split('—')[0].trim()}`,
        count: misses.length, link: 'performance' });
    } catch { /* analytics unavailable — skip quietly */ }
  }

  // 5. Open orders due within a week (not yet shipped, past the quote stage)
  if (has('orders')) {
    const n = await count(
      `SELECT COUNT(*)::int AS n FROM sales_order
        WHERE stage NOT IN ('Quote','Ready') AND billed = false
          AND due IS NOT NULL AND due <= (CURRENT_DATE + INTERVAL '7 days')`);
    if (n) items.push({ key: 'orders_due', icon: '📋',
      label: `${plural(n, 'order')} due within 7 days`, count: n, link: 'orders' });
    // Dealer-portal orders awaiting Built Trailers sales approval
    const da = await count(`SELECT COUNT(*)::int AS n FROM sales_order WHERE stage='Quote' AND channel='Dealer Portal' AND customer_id NOT IN ${T.TEST_CUST}`);
    if (da) items.push({ key: 'dealer_orders', icon: '🛒',
      label: `${plural(da, 'dealer order')} awaiting approval`, count: da, link: 'orders' });
  }

  // 5b. Open warranty claims + portal registrations awaiting verification (trailers section)
  if (has('trailers')) {
    const n = await count(`SELECT COUNT(*)::int AS n FROM warranty_claim WHERE status='Open' AND trailer_id NOT IN ${T.TEST_TRL} AND (submitted_by IS NULL OR submitted_by NOT IN ${T.TEST_OWNER})`);
    if (n) items.push({ key: 'warranty_claims', icon: '🛠️',
      label: `${plural(n, 'open warranty claim')}`, count: n, link: 'trailers' });
    const pr = await count(`SELECT COUNT(*)::int AS n FROM warranty_registration WHERE verification_status='pending' AND trailer_id NOT IN ${T.TEST_TRL}`);
    if (pr) items.push({ key: 'warranty_regs', icon: '📝',
      label: `${plural(pr, 'warranty registration')} to verify`, count: pr, link: 'trailers' });
    const dl = await count(`SELECT COUNT(*)::int AS n FROM dealer_user WHERE status='pending' AND is_test=false`);
    if (dl) items.push({ key: 'dealer_signups', icon: '🤝',
      label: `${plural(dl, 'dealership account')} to approve`, count: dl, link: 'trailers' });
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
