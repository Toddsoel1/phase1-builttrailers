// Web Push notifications (the "phone notifications" half of the post-SMS plan).
//
// Staff and dealers subscribe their browser/phone from the app; subscriptions live in
// push_subscription keyed by (owner_type, owner_id). sendPush() fans a notification out
// to every subscription for an owner and prunes dead ones. No-ops cleanly until the
// VAPID_* env vars are set, so nothing breaks before push is configured.
//
// Generate keys once with:  npx web-push generate-vapid-keys
// then set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (+ optional VAPID_SUBJECT) in the env.
import { all, q } from './db.js';
import webpush from 'web-push';

let _vapidSet = false;

export function pushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
export function vapidPublicKey() { return process.env.VAPID_PUBLIC_KEY || null; }

function ensureVapid() {
  if (_vapidSet) return true;
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@builttrailers.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  _vapidSet = true;
  return true;
}

// Store (or refresh) a browser push subscription. owner_type is 'staff' or 'dealer';
// owner_id is the app_user id for staff or the dealership customer_id for dealers.
export async function saveSubscription(ownerType, ownerId, sub) {
  if (!sub || !sub.endpoint || ownerId == null) return { ok: false };
  await q(`INSERT INTO push_subscription(owner_type, owner_id, endpoint, sub_json)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT(endpoint) DO UPDATE SET owner_type=$1, owner_id=$2, sub_json=$4`,
    [ownerType, String(ownerId), sub.endpoint, JSON.stringify(sub)]);
  return { ok: true };
}

export async function removeSubscription(endpoint) {
  if (endpoint) await q(`DELETE FROM push_subscription WHERE endpoint=$1`, [endpoint]).catch(() => {});
}

// Fan a notification out to every subscription for an owner. Returns how many were sent.
// No-ops without VAPID; prunes subscriptions the push service reports as gone (404/410).
export async function sendPush(ownerType, ownerId, payload = {}) {
  if (!ensureVapid() || ownerId == null) return { sent: 0 };
  const rows = await all(`SELECT endpoint, sub_json FROM push_subscription WHERE owner_type=$1 AND owner_id=$2`,
    [ownerType, String(ownerId)]).catch(() => []);
  const body = JSON.stringify({
    title: payload.title || 'Built Trailers',
    body: payload.body || '',
    url: payload.url || '/',
    tag: payload.tag || undefined,
  });
  let sent = 0;
  for (const r of rows) {
    let sub; try { sub = JSON.parse(r.sub_json); } catch { continue; }
    try { await webpush.sendNotification(sub, body); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await removeSubscription(r.endpoint);
      else console.warn('push send:', e.statusCode || e.message);
    }
  }
  return { sent };
}
