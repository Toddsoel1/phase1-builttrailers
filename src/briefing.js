// Morning SMS briefing — texts each employee their personal action items so they
// know what needs doing before they even open the app. Built on the same engine
// as the dashboard inbox (inbox.js), so the text and the screen always agree.
import { all } from './db.js';
import { actionItemsFor, resolveUserForInbox } from './inbox.js';
import { send } from './sms.js';

const FOOTER = 'Open the app to take action. Reply STOP to opt out.';

// Compose one person's briefing from their already-computed action items.
export function briefingText(firstName, items) {
  const hi = `Built Trailers — Good morning, ${firstName || 'team'}!`;
  if (!items.length) {
    return `${hi} You're all caught up — nothing needs your attention today. ${FOOTER}`;
  }
  const lines = items.map(i => `• ${i.label}`).join('\n');
  return `${hi} Today you have:\n${lines}\n${FOOTER}`;
}

// Send the briefing to every active employee who has a phone + SMS consent.
// By default, people with zero action items are skipped (no news = good news);
// set BRIEFING_INCLUDE_EMPTY=true to text everyone a daily "all caught up".
export async function sendMorningBriefings(triggeredBy) {
  const includeEmpty = process.env.BRIEFING_INCLUDE_EMPTY === 'true';
  const users = await all(
    `SELECT id, name, role, phone FROM app_user
      WHERE active <> false AND sms_consent = true
        AND phone IS NOT NULL AND phone <> ''`, []).catch(() => []);

  let sent = 0, skipped = 0, errors = 0;
  for (const u of users) {
    try {
      const norm = await resolveUserForInbox(u);
      const items = await actionItemsFor(norm);
      if (!items.length && !includeEmpty) { skipped++; continue; }
      const first = (u.name || '').split(' ')[0];
      await send({ recipient: u.phone, body: briefingText(first, items), kind: 'briefing', ref: u.id }, triggeredBy || null);
      sent++;
    } catch { errors++; }
  }
  return { sent, skipped, errors, total: users.length };
}

// Preview one user's briefing without sending (used by the test endpoint).
export async function previewBriefingFor(user, name) {
  const items = await actionItemsFor(user);
  return { items, text: briefingText((name || '').split(' ')[0], items) };
}
