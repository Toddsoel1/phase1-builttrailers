// In-portal notifications for dealerships (order shipped, claim updated,
// registration verified). Kept in its own module (db-only imports) so portal.js,
// warranty.js, dealer.js, and server.js can all post notifications without import
// cycles. Keyed by the dealer's customer_id.
import { all, q } from './db.js';
import { sendPush } from './push.js';

export async function notifyDealer(customerId, kind, body, ref) {
  if (!customerId || !body) return;
  await q(`INSERT INTO dealer_notification(customer_id,kind,body,ref) VALUES($1,$2,$3,$4)`,
    [customerId, kind || null, body, ref || null]).catch(() => {});
  // Also push to the dealership's subscribed devices (no-ops until VAPID is configured).
  try { await sendPush('dealer', customerId, { title: 'Built Trailers', body, tag: `${kind || 'note'}-${ref || ''}`, url: '/' }); }
  catch (e) { console.warn('dealer push:', e.message); }
}
export async function myNotifications(d) {
  if (!d.customer_id) return { items: [], unread: 0 };
  const rows = await all(`SELECT id,kind,body,ref,read,created_at FROM dealer_notification
                           WHERE customer_id=$1 ORDER BY id DESC LIMIT 50`, [d.customer_id]).catch(() => []);
  return {
    items: rows.map(r => ({ id: r.id, kind: r.kind, body: r.body, ref: r.ref, read: r.read, at: r.created_at })),
    unread: rows.filter(r => !r.read).length,
  };
}
export async function markRead(d) {
  if (d.customer_id) await q(`UPDATE dealer_notification SET read=true WHERE customer_id=$1 AND read=false`, [d.customer_id]).catch(() => {});
  return { ok: true };
}
