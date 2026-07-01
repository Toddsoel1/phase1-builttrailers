// Automated owner reminder emails — the follow-through on the warranty welcome email.
// Two kinds, both limited to VERIFIED registrations whose owner opted into email:
//   · warranty-expiry: a one-shot "your warranty ends on <date>" ~30 days before expiry
//     (expiry = sale_date + term_months), so owners can log maintenance / file claims in time.
//   · maintenance: a periodic service nudge every ~6 months while the trailer is in warranty,
//     skipped automatically when the owner has logged maintenance recently (no nagging).
// Sent-state lives on warranty_registration (expiry_reminder_sent / maintenance_reminder_sent)
// and is only stamped when a send actually succeeds, so a mis-configured email key can never
// burn a one-shot reminder. runReminders({dryRun:true}) reports eligibility without sending.
import { all, q } from './db.js';
import { emailConfigured, sendWarrantyExpiryReminder, sendMaintenanceReminder } from './email.js';

const EXPIRY_WINDOW_DAYS = 30;   // how far ahead of expiry the heads-up goes out
const MAINT_EVERY_MONTHS = 6;    // service cadence
const MAINT_QUIET_MONTHS = 5;    // no repeat (and no nudge after logged maintenance) within this

export async function runReminders({ dryRun = false } = {}) {
  if (!dryRun && !emailConfigured()) {
    return { skipped: 'email not configured', expiryEligible: 0, expirySent: 0, maintenanceEligible: 0, maintenanceSent: 0 };
  }

  const expiry = await all(`
    SELECT r.trailer_id, r.owner_name, r.email, t.vin, m.name AS model,
           (r.sale_date + (r.term_months * INTERVAL '1 month'))::date AS expires_on
      FROM warranty_registration r
      JOIN trailer t ON t.id = r.trailer_id
      LEFT JOIN model m ON m.id = t.model_id
     WHERE r.verification_status = 'verified' AND r.email_opt_in = true AND r.email IS NOT NULL
       AND r.sale_date IS NOT NULL AND r.expiry_reminder_sent IS NULL
       AND (r.sale_date + (r.term_months * INTERVAL '1 month')) >= now()
       AND (r.sale_date + (r.term_months * INTERVAL '1 month')) <= now() + INTERVAL '${EXPIRY_WINDOW_DAYS} days'
     ORDER BY expires_on`, []);

  const maintenance = await all(`
    SELECT r.trailer_id, r.owner_name, r.email, t.vin, m.name AS model
      FROM warranty_registration r
      JOIN trailer t ON t.id = r.trailer_id
      LEFT JOIN model m ON m.id = t.model_id
     WHERE r.verification_status = 'verified' AND r.email_opt_in = true AND r.email IS NOT NULL
       AND r.sale_date IS NOT NULL
       AND r.sale_date <= now() - INTERVAL '${MAINT_EVERY_MONTHS} months'
       AND (r.sale_date + (r.term_months * INTERVAL '1 month')) > now()
       AND (r.maintenance_reminder_sent IS NULL OR r.maintenance_reminder_sent < now() - INTERVAL '${MAINT_QUIET_MONTHS} months')
       AND NOT EXISTS (SELECT 1 FROM maintenance_record mr
                        WHERE mr.trailer_id = r.trailer_id AND mr.created_at > now() - INTERVAL '${MAINT_QUIET_MONTHS} months')
     ORDER BY r.sale_date`, []);

  if (dryRun) {
    return {
      dryRun: true, emailConfigured: emailConfigured(),
      expiryEligible: expiry.length, expirySent: 0,
      maintenanceEligible: maintenance.length, maintenanceSent: 0,
      expiry: expiry.map(e => ({ vin: e.vin, email: e.email,
        expiresOn: e.expires_on instanceof Date ? e.expires_on.toISOString().slice(0, 10) : String(e.expires_on).slice(0, 10) })),
      maintenance: maintenance.map(m => ({ vin: m.vin, email: m.email })),
    };
  }

  let expirySent = 0, maintenanceSent = 0;
  for (const e of expiry) {
    try {
      const r = await sendWarrantyExpiryReminder({ email: e.email, ownerName: e.owner_name, vin: e.vin, model: e.model, expiresOn: e.expires_on });
      if (r?.ok) { await q('UPDATE warranty_registration SET expiry_reminder_sent=now() WHERE trailer_id=$1', [e.trailer_id]); expirySent++; }
    } catch (err) { console.warn('expiry reminder:', err.message); }
  }
  for (const m of maintenance) {
    try {
      const r = await sendMaintenanceReminder({ email: m.email, ownerName: m.owner_name, vin: m.vin, model: m.model });
      if (r?.ok) { await q('UPDATE warranty_registration SET maintenance_reminder_sent=now() WHERE trailer_id=$1', [m.trailer_id]); maintenanceSent++; }
    } catch (err) { console.warn('maintenance reminder:', err.message); }
  }
  if (expirySent || maintenanceSent) {
    await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
      [null, 'reminders.run', `expiry ${expirySent}/${expiry.length}, maintenance ${maintenanceSent}/${maintenance.length}`]).catch(() => {});
  }
  return { expiryEligible: expiry.length, expirySent, maintenanceEligible: maintenance.length, maintenanceSent };
}
