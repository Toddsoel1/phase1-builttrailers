// ⏱ Time surveys — the periodic "how long did these actually take?" that runs after the
// 60-second day verification once enough unsurveyed work has piled up. Each completed item
// (per-VIN build-step stamps, made-part builds) is asked about exactly once (stamped with the
// survey id), and the collected minutes become the actuals that audit BOM labor hours and
// made-part costs (see accuracy()).
import { all, one, q } from './db.js';

export const SURVEY_THRESHOLD = () => Number(process.env.TIME_SURVEY_MIN_ITEMS || 5);
const SHOP_RATE = () => Number(process.env.SHOP_RATE || 35); // $/labor-hour fallback

const STEP_TO_STAGE = { Parts: 'Build', Bending: 'Build', Paint: 'Paint/Powder Coat', Finishing: 'Finish', QC: 'Finish' };
const STAGE_VERB = { 'Build': 'Welded/built', 'Paint/Powder Coat': 'Painted', 'Finish': 'Finished' };

// What this person hasn't put time against yet, grouped the way a human remembers the work:
// one line per order-stage ("Welded: 2× G23 — SO-1052", prefilled from the BOM routing) and
// one line per made-parts entry ("3× MK-1001 Bunkboard").
export async function pendingFor(userId) {
  const steps = await all(`
    SELECT s.id, s.step, s.trailer_id, t.order_id, o.model_id, m.name AS model
      FROM trailer_build_step s
      JOIN trailer t ON t.id = s.trailer_id
      LEFT JOIN sales_order o ON o.id = t.order_id
      LEFT JOIN model m ON m.id = o.model_id
     WHERE s.logged_by = $1 AND s.time_survey_id IS NULL
     ORDER BY s.completed_at`, [userId]).catch(() => []);
  const parts = await all(`
    SELECT b.id, b.part_id, b.qty, p.name
      FROM part_build_log b LEFT JOIN part p ON p.id = b.part_id
     WHERE b.user_id = $1 AND b.time_survey_id IS NULL
     ORDER BY b.built_at`, [userId]).catch(() => []);

  const groups = {};
  for (const s of steps) {
    const stage = STEP_TO_STAGE[s.step] || 'Build';
    const key = `${s.order_id || s.trailer_id}|${stage}`;
    const g = (groups[key] = groups[key] || { key, orderId: s.order_id, stage, modelId: s.model_id, model: s.model, stepIds: [], unitIds: new Set() });
    g.stepIds.push(s.id);
    g.unitIds.add(s.trailer_id);
  }
  const stages = [];
  for (const g of Object.values(groups)) {
    const units = g.unitIds.size;
    const routed = g.modelId
      ? Number((await one(`SELECT COALESCE(SUM(hours),0) AS h FROM model_labor WHERE model_id=$1 AND stage=$2`, [g.modelId, g.stage]).catch(() => null))?.h || 0)
      : 0;
    stages.push({ key: g.key, orderId: g.orderId, stage: g.stage, modelId: g.modelId, model: g.model,
      units, stepIds: g.stepIds,
      description: `${STAGE_VERB[g.stage] || g.stage}: ${units}× ${g.model || 'trailer'}${g.orderId ? ` (${g.orderId})` : ''}`,
      prefillMinutes: Math.round(routed * units * 60) });
  }
  const partLines = parts.map(p => ({ logId: p.id, partId: p.part_id, name: p.name, qty: Number(p.qty),
    description: `${Number(p.qty)}× ${p.part_id}${p.name ? ` — ${p.name}` : ''}` }));

  const itemCount = steps.length + parts.length;
  return { due: itemCount >= SURVEY_THRESHOLD(), itemCount, threshold: SURVEY_THRESHOLD(), stages, parts: partLines };
}

// Record the survey: store lines, stamp every covered item so it's never asked about again.
export async function submit(userId, lines) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Nothing to record.');
  const survey = await one('INSERT INTO time_survey(user_id) VALUES ($1) RETURNING id', [userId]);
  let total = 0;
  for (const l of lines) {
    const minutes = Math.max(0, Math.round(Number(l.minutes) || 0));
    if (l.kind === 'stage' && Array.isArray(l.stepIds) && l.stepIds.length) {
      // Only stamp steps that are really this person's and still unsurveyed.
      const owned = await all(`SELECT id FROM trailer_build_step WHERE id = ANY($1) AND logged_by=$2 AND time_survey_id IS NULL`,
        [l.stepIds.map(Number), userId]);
      if (!owned.length) continue;
      await q(`UPDATE trailer_build_step SET time_survey_id=$1 WHERE id = ANY($2)`, [survey.id, owned.map(r => r.id)]);
      await q(`INSERT INTO time_survey_line(survey_id,kind,order_id,stage,model_id,description,qty,minutes)
               VALUES ($1,'stage',$2,$3,$4,$5,$6,$7)`,
        [survey.id, l.orderId || null, l.stage || null, l.modelId || null, String(l.description || '').slice(0, 200), Number(l.qty) || 1, minutes]);
      total += minutes;
    } else if (l.kind === 'part' && l.logId) {
      const owned = await one(`SELECT id, part_id, qty FROM part_build_log WHERE id=$1 AND user_id=$2 AND time_survey_id IS NULL`, [Number(l.logId), userId]);
      if (!owned) continue;
      await q(`UPDATE part_build_log SET time_survey_id=$1 WHERE id=$2`, [survey.id, owned.id]);
      await q(`INSERT INTO time_survey_line(survey_id,kind,part_id,description,qty,minutes)
               VALUES ($1,'part',$2,$3,$4,$5)`,
        [survey.id, owned.part_id, String(l.description || '').slice(0, 200), Number(owned.qty) || 1, minutes]);
      total += minutes;
    } else if (l.kind === 'other' && String(l.description || '').trim() && minutes > 0) {
      await q(`INSERT INTO time_survey_line(survey_id,kind,description,minutes) VALUES ($1,'other',$2,$3)`,
        [survey.id, String(l.description).trim().slice(0, 200), minutes]);
      total += minutes;
    }
  }
  await q('UPDATE time_survey SET total_minutes=$1 WHERE id=$2', [total, survey.id]);
  return { ok: true, surveyId: survey.id, totalMinutes: total };
}

// The payoff: surveyed actuals vs the BOM. By model+stage (actual hours/unit vs routed hours)
// and by made part (minutes/unit -> implied labor $ vs the part's current cost).
export async function accuracy() {
  const stageRows = await all(`
    SELECT l.model_id, l.stage, m.name AS model,
           COUNT(*)::int AS surveys, SUM(l.qty) AS units, SUM(l.minutes) AS minutes
      FROM time_survey_line l LEFT JOIN model m ON m.id = l.model_id
     WHERE l.kind='stage' AND l.model_id IS NOT NULL AND l.stage IS NOT NULL
     GROUP BY l.model_id, l.stage, m.name`, []).catch(() => []);
  const byStage = [];
  for (const r of stageRows) {
    const units = Number(r.units) || 0;
    const actualH = units ? Math.round((Number(r.minutes) / 60 / units) * 100) / 100 : null;
    const bomH = Number((await one(`SELECT COALESCE(SUM(hours),0) AS h FROM model_labor WHERE model_id=$1 AND stage=$2`, [r.model_id, r.stage]).catch(() => null))?.h || 0);
    byStage.push({ modelId: r.model_id, model: r.model, stage: r.stage, surveys: r.surveys, units,
      actualHoursPerUnit: actualH, bomHoursPerUnit: bomH,
      variancePct: actualH != null && bomH > 0 ? Math.round(((actualH - bomH) / bomH) * 100) : null });
  }
  const partRows = await all(`
    SELECT l.part_id, p.name, p.cost, COUNT(*)::int AS surveys, SUM(l.qty) AS qty, SUM(l.minutes) AS minutes
      FROM time_survey_line l LEFT JOIN part p ON p.id = l.part_id
     WHERE l.kind='part' AND l.part_id IS NOT NULL
     GROUP BY l.part_id, p.name, p.cost`, []).catch(() => []);
  const byPart = partRows.map(r => {
    const qty = Number(r.qty) || 0;
    const minPerUnit = qty ? Math.round(Number(r.minutes) / qty) : null;
    const laborPerUnit = minPerUnit != null ? Math.round((minPerUnit / 60) * SHOP_RATE() * 100) / 100 : null;
    return { partId: r.part_id, name: r.name, surveys: r.surveys, qty, minutesPerUnit: minPerUnit,
      impliedLaborPerUnit: laborPerUnit, currentCost: Number(r.cost) || 0, rate: SHOP_RATE() };
  }).sort((a, b) => (b.qty || 0) - (a.qty || 0));
  return { byStage: byStage.sort((a, b) => Math.abs(b.variancePct || 0) - Math.abs(a.variancePct || 0)), byPart };
}
