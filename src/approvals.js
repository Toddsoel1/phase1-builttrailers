import crypto from 'crypto';
import { q, all, one } from './db.js';
import * as sms from './sms.js';
import { sendPush } from './push.js';

function genToken() { return crypto.randomBytes(24).toString('hex'); }

// Rules that match type + amount
async function matchingRules(type, amount) {
  return all(`
    SELECT r.*, u.name AS approver_name, u.title AS approver_title,
           u.phone AS approver_phone, u.sms_consent AS approver_sms_consent
    FROM approval_rule r JOIN app_user u ON u.id = r.approver_id
    WHERE r.type=$1 AND r.active=true
      AND (r.min_amount IS NULL OR $2::numeric >= r.min_amount)
      AND (r.max_amount IS NULL OR $2::numeric <= r.max_amount)
    ORDER BY r.seq, r.id
  `, [type, amount || 0]);
}

async function notifyApprover(rule, refId, amount, desc, token) {
  const base = process.env.APP_URL || 'http://localhost:3000';
  const url  = `${base}/approve/${token}`;
  const body = `Built Trailers: Approval needed: ${desc} (${rule.type.toUpperCase()}${amount ? ', $' + Number(amount).toFixed(2) : ''}). Approve/reject: ${url} Reply STOP to opt out.`;
  await q(`INSERT INTO notification(channel,recipient,body,kind,ref,mode,status)
           VALUES ('app',$1,$2,'approval-request',$3,'app','sent')`,
    [rule.approver_id, body, refId]);
  // Phone/desktop push to the approver, deep-linked to the token approve page (no-ops until VAPID set).
  try {
    await sendPush('staff', rule.approver_id, {
      title: 'Approval needed',
      body: `${desc} (${rule.type.toUpperCase()}${amount ? ', $' + Number(amount).toFixed(2) : ''})`,
      url: `/approve/${token}`, tag: `approval-${refId}`,
    });
  } catch (e) { console.warn('approver push:', e.message); }
  if ((rule.notify === 'sms' || rule.notify === 'both') && rule.approver_phone && rule.approver_sms_consent) {
    await sms.send({ recipient: rule.approver_phone, body, kind: 'approval-request', ref: refId }, null);
  }
}

// Create approval requests for a new PO or vendor; returns [] if no rules match
export async function requestApprovals(type, refId, refAmount, refDesc, requestedById) {
  const rules = await matchingRules(type, refAmount || 0);
  if (!rules.length) return [];
  const created = [];
  for (const rule of rules) {
    const id    = `${type}_${refId}_${rule.id}`;
    const token = genToken();
    await q(`INSERT INTO approval_request
             (id,rule_id,type,ref_id,ref_amount,ref_desc,approver_id,seq,token,notify_method,requested_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
      [id, rule.id, type, refId, refAmount, refDesc, rule.approver_id, rule.seq, token, rule.notify, requestedById || null]);
    created.push({ id, token, approverName: rule.approver_name, seq: rule.seq });
    if (rule.seq === 1) await notifyApprover(rule, refId, refAmount, refDesc, token);
  }
  return created;
}

export async function pendingCount(userId) {
  const r = await one('SELECT COUNT(*) AS n FROM approval_request WHERE approver_id=$1 AND status=$2', [userId, 'pending']);
  return Number(r?.n || 0);
}

export async function pendingForUser(userId) {
  return all(`
    SELECT ar.*, u.name AS requester_name, u.title AS requester_title
    FROM approval_request ar LEFT JOIN app_user u ON u.id=ar.requested_by
    WHERE ar.approver_id=$1 AND ar.status='pending' ORDER BY ar.requested_at DESC
  `, [userId]);
}

export async function approvalStatusFor(refId) {
  return all(`
    SELECT ar.*, u.name AS approver_name, u.title AS approver_title, d.name AS decider_name
    FROM approval_request ar
    JOIN app_user u ON u.id=ar.approver_id LEFT JOIN app_user d ON d.id=ar.decided_by
    WHERE ar.ref_id=$1 ORDER BY ar.seq, ar.id
  `, [refId]);
}

// Process approve/reject — works from web token (no auth) or in-app (with userId)
export async function processDecision(token, decision, note, decidedById) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Invalid decision');
  const req = await one('SELECT * FROM approval_request WHERE token=$1', [token]);
  if (!req) throw new Error('Approval request not found');
  if (req.status !== 'pending') throw new Error(`Already ${req.status}`);

  await q('UPDATE approval_request SET status=$1,note=$2,decided_by=$3,decided_at=now() WHERE token=$4',
    [decision, note || null, decidedById || null, token]);

  if (decision === 'rejected') {
    await q(`UPDATE approval_request SET status='cancelled',decided_at=now()
             WHERE ref_id=$1 AND status='pending' AND token<>$2`, [req.ref_id, token]);
    if (req.type === 'po')     await q("UPDATE purchase_order SET status='Rejected' WHERE id=$1", [req.ref_id]);
    if (req.type === 'vendor') await q("UPDATE vendor SET status='rejected' WHERE id=$1", [req.ref_id]);
    return { outcome: 'rejected', type: req.type, refId: req.ref_id };
  }

  // Check if all same-seq requests are approved
  const remaining = await one(
    'SELECT COUNT(*) AS n FROM approval_request WHERE ref_id=$1 AND seq=$2 AND status=$3',
    [req.ref_id, req.seq, 'pending']);
  if (Number(remaining.n) > 0) return { outcome: 'approved_partial', type: req.type, refId: req.ref_id };

  // All this seq done — find next
  const next = await one(
    'SELECT MIN(seq) AS s FROM approval_request WHERE ref_id=$1 AND seq>$2 AND status=$3',
    [req.ref_id, req.seq, 'pending']);
  if (next?.s) {
    const nextReqs = await all(`
      SELECT ar.*, u.name AS approver_name, u.phone AS approver_phone, u.sms_consent AS approver_sms_consent, r.notify
      FROM approval_request ar JOIN approval_rule r ON r.id=ar.rule_id JOIN app_user u ON u.id=ar.approver_id
      WHERE ar.ref_id=$1 AND ar.seq=$2
    `, [req.ref_id, next.s]);
    for (const nr of nextReqs) {
      await notifyApprover(
        { approver_id: nr.approver_id, approver_name: nr.approver_name, approver_phone: nr.approver_phone, approver_sms_consent: nr.approver_sms_consent, notify: nr.notify, type: req.type },
        req.ref_id, req.ref_amount, req.ref_desc, nr.token);
    }
    return { outcome: 'approved_next_seq', type: req.type, refId: req.ref_id };
  }

  // Fully approved
  if (req.type === 'po')     await q("UPDATE purchase_order SET status='Open' WHERE id=$1 AND status='Pending Approval'", [req.ref_id]);
  if (req.type === 'vendor') await q("UPDATE vendor SET status='active' WHERE id=$1 AND status='pending'", [req.ref_id]);
  return { outcome: 'fully_approved', type: req.type, refId: req.ref_id };
}

// ---- Rule CRUD ----
export async function listRules() {
  return all(`
    SELECT r.*, u.name AS approver_name, u.title AS approver_title
    FROM approval_rule r JOIN app_user u ON u.id=r.approver_id
    ORDER BY r.type, r.seq, COALESCE(r.min_amount,0)
  `, []);
}

export async function createRule({ type, minAmount, maxAmount, approverId, seq, notify, label }) {
  if (!['po','vendor'].includes(type)) throw new Error('type must be po or vendor');
  if (!approverId) throw new Error('approverId required');
  const id = 'rule_' + crypto.randomBytes(6).toString('hex');
  await q(`INSERT INTO approval_rule(id,type,min_amount,max_amount,approver_id,seq,notify,label)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, type, minAmount ?? null, maxAmount ?? null, approverId, seq || 1, notify || 'app', label || null]);
  return id;
}

export async function updateRule(id, body) {
  const { active, notify, minAmount, maxAmount, seq, label, approverId } = body;
  await q(`UPDATE approval_rule SET active=$1,notify=COALESCE($2,notify),min_amount=$3,max_amount=$4,
           seq=COALESCE($5,seq),label=$6,approver_id=COALESCE($7,approver_id) WHERE id=$8`,
    [active ?? true, notify ?? null, minAmount ?? null, maxAmount ?? null, seq ?? null, label ?? null, approverId ?? null, id]);
}

export async function deleteRule(id) {
  await q('DELETE FROM approval_rule WHERE id=$1', [id]);
}

// Vendor CRUD (needed because approvals gate new vendors)
export async function listVendors() {
  return all('SELECT * FROM vendor ORDER BY name', []);
}
export async function createVendor({ name, leadDays, terms }, requestedById) {
  const id = 'v_' + crypto.randomBytes(6).toString('hex');
  const rules = await matchingRules('vendor', 0);
  const status = rules.length ? 'pending' : 'active';
  await q('INSERT INTO vendor(id,name,lead_days,terms,status) VALUES ($1,$2,$3,$4,$5)',
    [id, name, leadDays || 0, terms || null, status]);
  if (rules.length) {
    await requestApprovals('vendor', id, null, `New vendor: ${name}`, requestedById);
  }
  return { id, status };
}
