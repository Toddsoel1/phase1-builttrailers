import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { q, all, one } from './db.js';

const SYSTEM_PROMPT = `You are the AI support assistant for Built Trailers — a shop management system for a trailer manufacturing company. Your job is to help users troubleshoot problems, learn how to use the system, and decide whether an issue needs to be escalated to a developer.

== KEY FEATURES ==
- Dashboard: production KPIs, cash flow, output metrics
- Orders: sales orders from Quote → Confirmed → In Production → Ready/Shipped; customer & dealer management
- Parts Master: parts list, BOMs (bills of materials), inventory levels, reorder/cushion points
- MRP (Predictive Ordering): recommends purchase orders based on demand, lead time, and safety stock
- Purchase Orders: create POs, approval workflow (configurable dollar thresholds), receive POs into inventory
- Accounting: QuickBooks Online integration — invoices post on ship, bills post on PO receive; pull sync for customers/items/invoices
- Approvals: POs over configurable amounts and new vendors require sequential approval from designated approvers
- People: employee roster, schedules, time-off requests, payroll summary
- Wins: team recognition — post wins, react with emoji
- Notifications: SMS alerts for order status changes
- Users & Roles: Admin (full access), Editor (create/edit), Viewer (read-only)

== COMMON TROUBLESHOOTING ==
- Can't log in: username/password are set by an admin; contact your admin to reset
- QuickBooks 403 error: go to Accounting page → click Re-authorize → complete Intuit OAuth flow
- QB sync shows no data: ensure QB app has Production keys (not Development) at developer.intuit.com
- PO stuck in Pending Approval: the assigned approver must approve via their notification link or in the POs page
- Parts not showing reorder alert: check that on_hand is below (reorder + cushion); MRP page auto-calculates
- New vendor can't be used on a PO: vendor approval is pending — wait for approvers to approve it
- Invoice/bill shows "pending" in ledger: click "Push pending" in Accounting to retry the QB sync

== YOUR ROLE ==
1. Try to resolve the issue with guidance and troubleshooting steps.
2. If the issue is clearly a software bug (something behaves incorrectly despite correct usage), say so and recommend the user submit a bug report.
3. If the user wants a new capability the system doesn't have, acknowledge it and recommend they submit a feature request.
4. Be concise. Bullet points over paragraphs. Never make up features that don't exist.`;

function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

export async function createTicket(userId, { type = 'question', title, firstMessage }) {
  const id = 'sup_' + crypto.randomBytes(8).toString('hex');
  await q(`INSERT INTO support_ticket(id,user_id,type,title) VALUES ($1,$2,$3,$4)`,
    [id, userId || null, type, title]);
  if (firstMessage) {
    await q(`INSERT INTO support_message(ticket_id,role,body) VALUES ($1,'user',$2)`, [id, firstMessage]);
  }
  return id;
}

export async function getTicket(id) {
  const ticket = await one('SELECT t.*, u.name AS user_name, u.username FROM support_ticket t LEFT JOIN app_user u ON u.id=t.user_id WHERE t.id=$1', [id]);
  if (!ticket) return null;
  const messages = await all('SELECT * FROM support_message WHERE ticket_id=$1 ORDER BY ts ASC', [id]);
  return { ...ticket, messages };
}

export async function listTickets({ status, type, userId } = {}) {
  const conditions = [];
  const params = [];
  if (status)  { params.push(status);  conditions.push(`t.status=$${params.length}`); }
  if (type)    { params.push(type);    conditions.push(`t.type=$${params.length}`); }
  if (userId)  { params.push(userId);  conditions.push(`t.user_id=$${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return all(`SELECT t.*, u.name AS user_name FROM support_ticket t
              LEFT JOIN app_user u ON u.id=t.user_id
              ${where} ORDER BY t.created_at DESC`, params);
}

export async function updateTicket(id, { status, adminNote, aiSummary } = {}) {
  await q(`UPDATE support_ticket SET
    status=COALESCE($1,status),
    admin_note=COALESCE($2,admin_note),
    ai_summary=COALESCE($3,ai_summary),
    updated_at=now()
    WHERE id=$4`, [status || null, adminNote ?? null, aiSummary ?? null, id]);
}

export async function chat(ticketId, userMessage, { userName, userRole } = {}) {
  const ai = client();
  if (!ai) {
    const fallback = 'AI support is not configured. Please ask your system administrator to add the ANTHROPIC_API_KEY to the server settings.';
    await q(`INSERT INTO support_message(ticket_id,role,body) VALUES ($1,'user',$2)`, [ticketId, userMessage]);
    await q(`INSERT INTO support_message(ticket_id,role,body) VALUES ($1,'ai',$2)`, [ticketId, fallback]);
    return { reply: fallback, suggestEscalate: false };
  }

  // Save user message
  await q(`INSERT INTO support_message(ticket_id,role,body) VALUES ($1,'user',$2)`, [ticketId, userMessage]);

  // Build conversation history for Claude
  const history = await all(
    `SELECT role, body FROM support_message WHERE ticket_id=$1 ORDER BY ts ASC`, [ticketId]);

  const messages = history.map(m => ({
    role: m.role === 'ai' ? 'assistant' : 'user',
    content: m.role === 'admin'
      ? `[Admin note]: ${m.body}`
      : m.body,
  }));

  // Merge consecutive same-role messages (Claude API requires alternating)
  const merged = [];
  for (const m of messages) {
    if (merged.length && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content += '\n\n' + m.content;
    } else {
      merged.push({ ...m });
    }
  }

  const contextNote = `[Context: user "${userName || 'unknown'}", role "${userRole || 'viewer'}"]`;
  if (merged[0]?.role === 'user') merged[0].content = contextNote + '\n\n' + merged[0].content;

  const response = await ai.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: merged,
  });

  const reply = response.content[0]?.text || 'I was unable to generate a response. Please try again.';

  // Save AI response
  await q(`INSERT INTO support_message(ticket_id,role,body) VALUES ($1,'ai',$2)`, [ticketId, reply]);

  // Heuristic: does the reply suggest escalating?
  const suggestEscalate = /bug report|feature request|submit.*ticket|escalat|developer|can't.*fix|unable to resolve|contact.*admin/i.test(reply);

  // Store AI summary on the ticket for admin review
  const summary = reply.slice(0, 500);
  await q(`UPDATE support_ticket SET ai_summary=$1, updated_at=now() WHERE id=$2`, [summary, ticketId]);

  return { reply, suggestEscalate };
}

export async function escalate(ticketId, type) {
  await q(`UPDATE support_ticket SET type=$1, status='escalated', updated_at=now() WHERE id=$2`, [type, ticketId]);
}

export async function deleteTicket(id) {
  await q('DELETE FROM support_ticket WHERE id=$1', [id]);
}
