// Cycle counts. The operations specialist records physical counts; the on-hand quantities AND
// the QuickBooks posting both apply only when the Office or General Manager approves — so the
// app and the books never diverge, and every inventory change is signed off.
import { all, one, q } from './db.js';
import { postInventoryAdjustment } from './accounting.js';

// Create a pending count from { partId, countedQty } lines. Captures the system on-hand and unit
// cost at count time. Nothing changes (on-hand or QuickBooks) until it's approved.
export async function createCycleCount(lines, note, user) {
  const clean = (Array.isArray(lines) ? lines : []).filter(l => l && l.partId);
  if (!clean.length) throw new Error('Add at least one part to count.');
  const cc = await one(`INSERT INTO cycle_count(status,note,created_by) VALUES('pending',$1,$2) RETURNING id`, [note || null, user?.id || null]);
  for (const l of clean) {
    const p = await one('SELECT on_hand, cost FROM part WHERE id=$1', [l.partId]);
    if (!p) continue;
    await q(`INSERT INTO cycle_count_line(count_id,part_id,system_qty,counted_qty,unit_cost) VALUES($1,$2,$3,$4,$5)`,
      [cc.id, l.partId, Number(p.on_hand) || 0, Math.max(0, Number(l.countedQty) || 0), Number(p.cost) || 0]);
  }
  return { id: cc.id, status: 'pending' };
}

export async function listCycleCounts(status) {
  const rows = await all(
    `SELECT cc.*, u.name AS created_by_name, r.name AS reviewed_by_name,
            (SELECT COUNT(*) FROM cycle_count_line l WHERE l.count_id=cc.id) AS lines,
            (SELECT COALESCE(SUM((l.counted_qty - l.system_qty)*l.unit_cost),0) FROM cycle_count_line l WHERE l.count_id=cc.id) AS net_value
       FROM cycle_count cc
       LEFT JOIN app_user u ON u.id=cc.created_by
       LEFT JOIN app_user r ON r.id=cc.reviewed_by
      ${status ? 'WHERE cc.status=$1' : ''}
      ORDER BY cc.created_at DESC`, status ? [status] : []);
  return rows.map(c => ({ id: c.id, status: c.status, note: c.note, createdBy: c.created_by_name, createdAt: c.created_at,
    reviewedBy: c.reviewed_by_name, reviewedAt: c.reviewed_at, lines: Number(c.lines), netValue: Number(c.net_value), qbStatus: c.qb_status }));
}

export async function cycleCountDetail(id) {
  const cc = await one(`SELECT cc.*, u.name AS created_by_name, r.name AS reviewed_by_name FROM cycle_count cc
                          LEFT JOIN app_user u ON u.id=cc.created_by LEFT JOIN app_user r ON r.id=cc.reviewed_by WHERE cc.id=$1`, [id]);
  if (!cc) return null;
  const lines = await all(`SELECT l.*, p.name AS part_name, p.type AS part_type FROM cycle_count_line l
                             LEFT JOIN part p ON p.id=l.part_id WHERE l.count_id=$1 ORDER BY l.part_id`, [id]);
  return {
    id: cc.id, status: cc.status, note: cc.note, createdBy: cc.created_by_name, createdAt: cc.created_at,
    reviewedBy: cc.reviewed_by_name, reviewedAt: cc.reviewed_at, reviewNote: cc.review_note, qbStatus: cc.qb_status,
    lines: lines.map(l => {
      const v = Number(l.counted_qty) - Number(l.system_qty);
      return { partId: l.part_id, name: l.part_name, type: l.part_type, systemQty: Number(l.system_qty),
        countedQty: Number(l.counted_qty), unitCost: Number(l.unit_cost), variance: v, varianceValue: v * Number(l.unit_cost) };
    }),
  };
}

// Approve (OM/GM/Admin): apply each line's counted qty to part.on_hand, post the net value to the
// books / QuickBooks, and mark the count posted. Only a pending count can be approved.
export async function approveCycleCount(id, user) {
  const cc = await one('SELECT * FROM cycle_count WHERE id=$1', [id]);
  if (!cc) throw new Error('Cycle count not found.');
  if (cc.status !== 'pending') throw new Error(`This count is already ${cc.status}.`);
  const lines = await all('SELECT * FROM cycle_count_line WHERE count_id=$1', [id]);
  let netValue = 0;
  for (const l of lines) {
    await q('UPDATE part SET on_hand=$1 WHERE id=$2', [Number(l.counted_qty), l.part_id]);
    netValue += (Number(l.counted_qty) - Number(l.system_qty)) * Number(l.unit_cost);
  }
  netValue = Math.round(netValue * 100) / 100;
  const posted = await postInventoryAdjustment(`CC-${id}`, netValue, user?.id).catch(e => ({ status: 'error', error: e.message }));
  await q(`UPDATE cycle_count SET status='posted', reviewed_by=$1, reviewed_at=now(), qb_status=$2, qb_external_id=$3 WHERE id=$4`,
    [user?.id || null, posted?.status || 'posted', posted?.external || null, id]);
  return { id, status: 'posted', netValue, qb: posted?.status || 'posted' };
}

export async function rejectCycleCount(id, user, note) {
  const cc = await one('SELECT status FROM cycle_count WHERE id=$1', [id]);
  if (!cc) throw new Error('Cycle count not found.');
  if (cc.status !== 'pending') throw new Error(`This count is already ${cc.status}.`);
  await q(`UPDATE cycle_count SET status='rejected', reviewed_by=$1, reviewed_at=now(), review_note=$2 WHERE id=$3`,
    [user?.id || null, note || null, id]);
  return { id, status: 'rejected' };
}
