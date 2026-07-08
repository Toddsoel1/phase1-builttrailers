// 💡 Daily ideas (kaizen) — the continuous-improvement loop:
//   checkout prompt → everyone submits one idea a day (quality, trailers, process, people)
//   → the Shop Manager ranks the day's ideas ANONYMOUSLY and picks a daily winner
//   → Monday, everyone votes on last week's daily winners (one vote each, no self-votes)
//   → Tuesday, the top idea is announced and the AUTHOR is finally revealed and celebrated
//   → the SM drives it to implemented and reports back at stand-up.
// Anonymity is structural: no API exposes author_id until weekly_winner is true.
import { all, one, q } from './db.js';

const TZ = process.env.BRIEFING_TZ || 'America/Denver';
const CATEGORIES = ['Quality', 'Trailers', 'Process', 'Shop life', 'Other'];

const todayStr = () => new Date().toISOString().slice(0, 10);
const dstr = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const weekdayIn = () => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date());
// The Monday of the week containing `day` (UTC math on date strings).
function mondayOf(dayStr) {
  const d = new Date(dayStr + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  return new Date(d.getTime() - dow * 864e5).toISOString().slice(0, 10);
}
const votingOpen = () => weekdayIn() === 'Mon' || process.env.IDEAS_VOTE_OPEN === '1';

export async function submitIdea({ text, category }, user) {
  const t = String(text || '').trim();
  if (t.length < 8) throw new Error('Give the idea a real sentence — what should change, and why?');
  const cat = CATEGORIES.includes(category) ? category : 'Other';
  const row = await one(`INSERT INTO idea(text, category, author_id) VALUES($1,$2,$3) RETURNING id`,
    [t.slice(0, 600), cat, user.id]);
  return { id: row.id };
}

export async function mineToday(userId) {
  return !!(await one(`SELECT id FROM idea WHERE author_id=$1 AND idea_date=CURRENT_DATE LIMIT 1`, [userId]));
}

// Anonymous idea list for a date — the SM's ranking view. NEVER includes the author.
async function ideasFor(date) {
  return (await all(`SELECT id, text, category, daily_winner FROM idea WHERE idea_date=$1 ORDER BY id`, [date]))
    .map(i => ({ id: i.id, text: i.text, category: i.category, dailyWinner: !!i.daily_winner }));
}

// SM picks (or re-picks) THE daily winner for that idea's date.
export async function pickDailyWinner(ideaId, user) {
  const idea = await one('SELECT id, idea_date, week_of FROM idea WHERE id=$1', [ideaId]);
  if (!idea) throw new Error('Idea not found.');
  if (idea.week_of) throw new Error('That idea is already in a weekly vote — pick from days that haven\'t gone to vote.');
  await q(`UPDATE idea SET daily_winner=false, daily_ranked_by=NULL, daily_ranked_at=NULL
            WHERE idea_date=$1 AND weekly_winner=false AND week_of IS NULL`, [idea.idea_date]);
  await q(`UPDATE idea SET daily_winner=true, status='daily_winner', daily_ranked_by=$1, daily_ranked_at=now() WHERE id=$2`,
    [user?.id || null, ideaId]);
  return { ok: true, date: dstr(idea.idea_date) };
}

// The current contest's candidates: last week's daily winners (strict Mon–Sun window).
// Under the hermetic test flag the window relaxes to "any daily winner not yet contested".
async function slate() {
  const weekOf = mondayOf(todayStr()); // the voting week's Monday = the contest key
  const rows = process.env.IDEAS_VOTE_OPEN === '1'
    ? await all(`SELECT id, text, category, author_id FROM idea
                  WHERE daily_winner=true AND weekly_winner=false AND (week_of IS NULL OR week_of=$1) ORDER BY idea_date, id`, [weekOf])
    : await all(`SELECT id, text, category, author_id FROM idea
                  WHERE daily_winner=true AND weekly_winner=false
                    AND idea_date >= ($1::date - INTERVAL '7 days') AND idea_date < $1::date
                    AND (week_of IS NULL OR week_of=$1) ORDER BY idea_date, id`, [weekOf]);
  return { weekOf, rows };
}

export async function castVote(ideaId, user) {
  if (!votingOpen()) throw new Error('Voting opens Monday — the slate is last week\'s daily winners.');
  const { weekOf, rows } = await slate();
  const cand = rows.find(r => r.id === Number(ideaId));
  if (!cand) throw new Error('That idea isn\'t on this week\'s ballot.');
  if (cand.author_id === user.id) throw new Error('You can\'t vote for your own idea — let the merit speak.');
  await q(`UPDATE idea SET week_of=$1 WHERE id = ANY($2)`, [weekOf, rows.map(r => r.id)]); // stamp the contest
  await q(`INSERT INTO idea_vote(idea_id, user_id, week_of) VALUES($1,$2,$3)
           ON CONFLICT (user_id, week_of) DO UPDATE SET idea_id=$1, created_at=now()`, [ideaId, user.id, weekOf]);
  return { ok: true };
}

// Close the current contest and crown the weekly winner (top votes; earliest idea breaks ties).
// The SM triggers this Tuesday morning — or it runs lazily once voting day has passed.
export async function announceWeekly(user) {
  const { weekOf, rows } = await slate();
  if (!rows.length) throw new Error('No candidates this week — pick daily winners first.');
  const votes = await all(`SELECT idea_id, COUNT(*)::int AS n FROM idea_vote WHERE week_of=$1 GROUP BY idea_id`, [weekOf]);
  if (!votes.length) throw new Error('No votes are in yet.');
  const counts = Object.fromEntries(votes.map(v => [v.idea_id, Number(v.n)]));
  const winner = rows.slice().sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.id - b.id)[0];
  await q(`UPDATE idea SET week_of=$1 WHERE id = ANY($2)`, [weekOf, rows.map(r => r.id)]);
  await q(`UPDATE idea SET weekly_winner=true, status='weekly_winner', weekly_announced_at=now() WHERE id=$1`, [winner.id]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [user?.id || null, 'idea.weekly', `#${winner.id} wins week of ${weekOf} (${counts[winner.id] || 0} vote(s))`]).catch(() => {});
  return { id: winner.id, votes: counts[winner.id] || 0 };
}

// ---- The monthly layer: weekly winners accumulate; the month-end vote crowns a champion ----
const firstOfMonth = dayStr => dayStr.slice(0, 7) + '-01';
// Monthly voting opens on the first Monday of a new month (or under the hermetic test flag).
const monthlyVotingOpen = () => {
  if (process.env.IDEAS_VOTE_OPEN === '1') return true;
  const today = todayStr();
  return weekdayIn() === 'Mon' && Number(today.slice(8, 10)) <= 7;
};
// Candidates: the PRIOR month's weekly winners (they're already announced — names are public).
// Under the test flag: any weekly winner not yet in a monthly contest.
async function monthlySlate() {
  const monthOf = firstOfMonth(todayStr()); // the contest key = the month the vote happens in
  const crowned = await one(`SELECT id FROM idea WHERE monthly_winner=true AND month_of=$1`, [monthOf]);
  if (crowned) return { monthOf, rows: [] }; // one champion per month — the ballot closes with the announcement
  const rows = process.env.IDEAS_VOTE_OPEN === '1'
    ? await all(`SELECT i.id, i.text, i.category, i.author_id, u.name AS author FROM idea i
                   LEFT JOIN app_user u ON u.id=i.author_id
                  WHERE i.weekly_winner=true AND i.monthly_winner=false
                    AND (i.month_of IS NULL OR i.month_of=$1) ORDER BY i.week_of NULLS LAST, i.id`, [monthOf])
    : await all(`SELECT i.id, i.text, i.category, i.author_id, u.name AS author FROM idea i
                   LEFT JOIN app_user u ON u.id=i.author_id
                  WHERE i.weekly_winner=true AND i.monthly_winner=false
                    AND i.week_of >= ($1::date - INTERVAL '1 month') AND i.week_of < $1::date
                    AND (i.month_of IS NULL OR i.month_of=$1) ORDER BY i.week_of, i.id`, [monthOf]);
  return { monthOf, rows };
}
export async function castMonthlyVote(ideaId, user) {
  if (!monthlyVotingOpen()) throw new Error('The monthly vote opens on the first Monday of the month — the slate is last month\'s weekly winners.');
  const { monthOf, rows } = await monthlySlate();
  const cand = rows.find(r => r.id === Number(ideaId));
  if (!cand) throw new Error('That idea isn\'t on this month\'s ballot.');
  if (cand.author_id === user.id) throw new Error('You can\'t vote for your own idea — let the merit speak.');
  await q(`UPDATE idea SET month_of=$1 WHERE id = ANY($2)`, [monthOf, rows.map(r => r.id)]);
  await q(`INSERT INTO idea_vote_month(idea_id, user_id, month_of) VALUES($1,$2,$3)
           ON CONFLICT (user_id, month_of) DO UPDATE SET idea_id=$1, created_at=now()`, [ideaId, user.id, monthOf]);
  return { ok: true };
}
export async function announceMonthly(user) {
  const { monthOf, rows } = await monthlySlate();
  if (!rows.length) throw new Error('No candidates — the month\'s weekly winners make the ballot.');
  const votes = await all(`SELECT idea_id, COUNT(*)::int AS n FROM idea_vote_month WHERE month_of=$1 GROUP BY idea_id`, [monthOf]);
  if (!votes.length) throw new Error('No monthly votes are in yet.');
  const counts = Object.fromEntries(votes.map(v => [v.idea_id, Number(v.n)]));
  const winner = rows.slice().sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.id - b.id)[0];
  await q(`UPDATE idea SET month_of=$1 WHERE id = ANY($2)`, [monthOf, rows.map(r => r.id)]);
  await q(`UPDATE idea SET monthly_winner=true, monthly_announced_at=now(),
                  status=CASE WHEN status='weekly_winner' THEN 'monthly_winner' ELSE status END WHERE id=$1`, [winner.id]);
  await q('INSERT INTO audit_log(user_id,action,detail) VALUES ($1,$2,$3)',
    [user?.id || null, 'idea.monthly', `#${winner.id} is the ${monthOf.slice(0, 7)} champion (${counts[winner.id] || 0} vote(s)) — ${winner.author}`]).catch(() => {});
  return { id: winner.id, votes: counts[winner.id] || 0, author: winner.author };
}

// Winner implementation tracking: selected → in_progress → implemented (+ the report-back note).
export async function setStatus(ideaId, status, note, user) {
  if (!['in_progress', 'implemented'].includes(status)) throw new Error("Status must be 'in_progress' or 'implemented'.");
  const idea = await one('SELECT id, weekly_winner FROM idea WHERE id=$1', [ideaId]);
  if (!idea) throw new Error('Idea not found.');
  if (!idea.weekly_winner) throw new Error('Only weekly winners get implementation tracking.');
  await q(`UPDATE idea SET status=$1, implemented_note=COALESCE($2, implemented_note),
                  implemented_at=CASE WHEN $1='implemented' THEN now() ELSE implemented_at END WHERE id=$3`,
    [status, String(note || '').trim() || null, ideaId]);
  return { ok: true };
}

// Everything the Stand-Up card needs, role-aware. Authors appear ONLY on announced winners.
export async function ideasBoard(user, isMgr) {
  const today = todayStr();
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const { weekOf, rows } = await slate();
  const myVote = await one(`SELECT idea_id FROM idea_vote WHERE user_id=$1 AND week_of=$2`, [user.id, weekOf]).catch(() => null);
  const voteCounts = isMgr
    ? Object.fromEntries((await all(`SELECT idea_id, COUNT(*)::int AS n FROM idea_vote WHERE week_of=$1 GROUP BY idea_id`, [weekOf])).map(v => [v.idea_id, Number(v.n)]))
    : {};
  const yWin = await one(`SELECT id, text, category FROM idea WHERE idea_date=$1 AND daily_winner=true LIMIT 1`, [yesterday]).catch(() => null);
  const winners = (await all(`SELECT i.id, i.text, i.category, i.status, i.implemented_note, i.implemented_at, i.week_of,
                                     i.monthly_winner, i.month_of, i.weekly_announced_at, i.monthly_announced_at, u.name AS author
                                FROM idea i LEFT JOIN app_user u ON u.id=i.author_id
                               WHERE i.weekly_winner=true ORDER BY i.week_of DESC NULLS LAST, i.id DESC LIMIT 8`, []))
    .map(w => ({ id: w.id, text: w.text, category: w.category, status: w.status,
      author: w.author, weekOf: w.week_of ? dstr(w.week_of) : null,
      monthlyWinner: !!w.monthly_winner, monthOf: w.month_of ? dstr(w.month_of) : null,
      weeklyAnnouncedAt: w.weekly_announced_at, monthlyAnnouncedAt: w.monthly_announced_at,
      implementedNote: w.implemented_note, implementedAt: w.implemented_at }));
  // The announcement slot: the MONTHLY champion takes over from the weekly winner when it's
  // the fresher crowning (per the spec — the monthly reveal replaces what the weekly showed).
  const latestWeekly = winners.slice().sort((a, b) => new Date(b.weeklyAnnouncedAt || 0) - new Date(a.weeklyAnnouncedAt || 0))[0] || null;
  const latestMonthly = winners.filter(w => w.monthlyWinner)
    .sort((a, b) => new Date(b.monthlyAnnouncedAt || 0) - new Date(a.monthlyAnnouncedAt || 0))[0] || null;
  const announced = latestMonthly && (!latestWeekly || new Date(latestMonthly.monthlyAnnouncedAt || 0) >= new Date(latestWeekly.weeklyAnnouncedAt || 0))
    ? { kind: 'monthly', ...latestMonthly } : latestWeekly ? { kind: 'weekly', ...latestWeekly } : null;
  const { monthOf, rows: mRows } = await monthlySlate();
  const myMonthlyVote = await one(`SELECT idea_id FROM idea_vote_month WHERE user_id=$1 AND month_of=$2`, [user.id, monthOf]).catch(() => null);
  const monthlyCounts = isMgr
    ? Object.fromEntries((await all(`SELECT idea_id, COUNT(*)::int AS n FROM idea_vote_month WHERE month_of=$1 GROUP BY idea_id`, [monthOf])).map(v => [v.idea_id, Number(v.n)]))
    : {};
  return {
    mineToday: await mineToday(user.id),
    todayCount: Number((await one(`SELECT COUNT(*)::int AS n FROM idea WHERE idea_date=CURRENT_DATE`, []))?.n || 0),
    yesterdayWinner: yWin ? { text: yWin.text, category: yWin.category } : null, // anonymous by design
    voting: { open: votingOpen(), weekOf,
      slate: rows.map(r => ({ id: r.id, text: r.text, category: r.category,
        mine: r.author_id === user.id, myVote: myVote?.idea_id === r.id,
        ...(isMgr ? { votes: voteCounts[r.id] || 0 } : {}) })) },
    monthlyVoting: { open: monthlyVotingOpen(), monthOf,
      slate: mRows.map(r => ({ id: r.id, text: r.text, category: r.category, author: r.author, // weekly winners are already public
        mine: r.author_id === user.id, myVote: myMonthlyVote?.idea_id === r.id,
        ...(isMgr ? { votes: monthlyCounts[r.id] || 0 } : {}) })) },
    announced,
    winners,
    categories: CATEGORIES,
    ...(isMgr ? { ranking: { today: await ideasFor(today), yesterday: await ideasFor(yesterday) } } : {}),
  };
}
