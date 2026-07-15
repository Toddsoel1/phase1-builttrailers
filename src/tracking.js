// 🚚 Shipment tracking on PO acknowledgements. Each ack can carry a carrier + tracking number;
// a periodic poller asks the configured tracking provider for status, and any change pushes an
// app notification to the Office Managers (and GM/admins) so nobody refreshes carrier sites.
//
// Provider: set TRACKING_PROVIDER_URL (+ optional TRACKING_PROVIDER_KEY) to a service that
// accepts POST {"numbers":[{"carrier":"UPS","trackingNo":"1Z..."}]} and answers
// [{"trackingNo":"1Z...","status":"In Transit"}] — most tracking aggregators (Ship24,
// 17track, AfterShip) are a thin adapter away. Without a provider the poller idles and the
// office can still log statuses manually; pushes fire either way.
import { all, one, q } from './db.js';
import { sendPush } from './push.js';

export const CARRIERS = ['UPS', 'FedEx', 'USPS', 'DHL', 'Other'];
export function carrierUrl(carrier, no) {
  const n = encodeURIComponent(String(no || '').trim());
  switch (String(carrier || '').toUpperCase()) {
    case 'UPS': return `https://www.ups.com/track?tracknum=${n}`;
    case 'FEDEX': return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
    case 'USPS': return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
    case 'DHL': return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`;
    default: return null;
  }
}
// Best-effort carrier detection from the number shape (office can always override).
export function detectCarrier(no) {
  const v = String(no || '').trim().toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(v)) return 'UPS';
  if (/^(94|93|92|95)\d{18,20}$/.test(v) || /^(EA|EC|CP)\d{9}US$/.test(v)) return 'USPS';
  if (/^\d{12}$/.test(v) || /^\d{15}$/.test(v)) return 'FedEx';
  if (/^\d{10}$/.test(v) || /^JD\d{16,18}$/.test(v)) return 'DHL';
  return null;
}

const DONE = ['Delivered', 'Picked Up'];

// Update one ack's tracking status. On CHANGE: audit + push to every Office Manager / General
// Manager / admin with a push subscription. `via` says whether a human or the poller found it.
export async function setTrackingStatus(ackId, status, { via = 'manual' } = {}, userId) {
  const ack = await one(
    `SELECT a.*, po.part_id, po.id AS po_id2 FROM po_ack a JOIN purchase_order po ON po.id=a.po_id WHERE a.id=$1`, [ackId]);
  if (!ack) throw new Error('Acknowledgement not found.');
  const v = String(status || '').trim();
  if (!v) throw new Error('Enter a status.');
  const changed = v !== (ack.tracking_status || '');
  await q('UPDATE po_ack SET tracking_status=$1, tracking_checked_at=now() WHERE id=$2', [v, ackId]);
  if (changed) {
    await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
      [userId || null, 'tracking.update', `${ack.po_id} ack ${ack.ack_no} (${ack.carrier || '?'} ${ack.tracking_no || ''}): ${ack.tracking_status || 'no status'} → ${v} [${via}]`]).catch(() => {});
    const watchers = await all(
      `SELECT DISTINCT u.id FROM app_user u
        LEFT JOIN user_title ut ON ut.user_id=u.id
       WHERE u.active <> false AND (u.role='admin' OR ut.role_name IN ('Office Manager','General Manager'))`, []).catch(() => []);
    for (const w of watchers) {
      await sendPush('staff', w.id, {
        title: `🚚 ${ack.po_id} — ${v}`,
        body: `${ack.carrier || 'Carrier'} ${ack.tracking_no || ''} (${ack.part_id}, ack ${ack.ack_no}): ${ack.tracking_status || 'no status'} → ${v}`,
        tag: `track-${ackId}`,
      }).catch(() => {});
    }
  }
  return { ok: true, changed, status: v };
}

// Ask the provider about every live tracking number (skips delivered + cancelled POs).
export async function pollTracking() {
  const url = process.env.TRACKING_PROVIDER_URL;
  if (!url) return { skipped: 'no provider configured' };
  const rows = await all(
    `SELECT a.id, a.carrier, a.tracking_no, a.tracking_status FROM po_ack a
      JOIN purchase_order po ON po.id=a.po_id
     WHERE a.tracking_no IS NOT NULL AND a.tracking_no <> ''
       AND COALESCE(a.tracking_status,'') NOT IN ('${DONE.join("','")}')
       AND po.status NOT IN ('Cancelled')`, []);
  if (!rows.length) return { checked: 0, changed: 0 };
  let results;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.TRACKING_PROVIDER_KEY ? { Authorization: 'Bearer ' + process.env.TRACKING_PROVIDER_KEY } : {}) },
      body: JSON.stringify({ numbers: rows.map(x => ({ carrier: x.carrier, trackingNo: x.tracking_no })) }),
    });
    if (!r.ok) throw new Error('provider HTTP ' + r.status);
    results = await r.json();
  } catch (e) {
    console.warn('tracking poll:', e.message);
    return { error: e.message };
  }
  let changed = 0;
  for (const res of Array.isArray(results) ? results : []) {
    const row = rows.find(x => x.tracking_no === res.trackingNo);
    if (!row || !res.status) continue;
    const out = await setTrackingStatus(row.id, res.status, { via: 'carrier poll' }, null).catch(() => null);
    if (out?.changed) changed++;
  }
  return { checked: rows.length, changed };
}

// Periodic searches throughout the day. Idles (with one log line) until a provider is set.
export function startTrackingPoller() {
  if (!process.env.TRACKING_PROVIDER_URL) {
    console.log('tracking: no TRACKING_PROVIDER_URL — carrier polling idle (manual status updates still push).');
    return null;
  }
  const minutes = Math.max(15, Number(process.env.TRACKING_POLL_MIN) || 240);
  const t = setInterval(() => pollTracking().catch(e => console.warn('tracking poll:', e.message)), minutes * 60e3);
  t.unref?.();
  setTimeout(() => pollTracking().catch(() => {}), 60e3).unref?.();
  console.log(`tracking: polling carriers every ${minutes} min.`);
  return t;
}
