// Lead data store — separate from data/db.json so high-churn WhatsApp chat data
// can never risk corrupting batch/class data on a bad write. Same read-modify-write
// pattern as store.js for data/leads.json; data/lead-log.jsonl is append-only instead,
// since a growing audit log shouldn't mean rewriting the whole file on every message.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEADS_PATH = path.join(__dirname, '..', 'data', 'leads.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'lead-log.jsonl');
const MAX_STORED_MESSAGES = 40;

const DEFAULT_DB = {
  leads: {},                                    // jid -> lead record
  meta: {
    dailyCount: { date: '', count: 0 },          // new-lead cap, reset daily (IST)
    backlogQueue: [],                            // [{jid, phone, pushName, lastMessageSnippet, lastMessageAt, discoveredAt, approved}]
    backlogSentToday: { date: '', count: 0 },     // separate from dailyCount — backlog opens don't count against the reactive new-lead cap
    backlogLastSendAt: null,
    backlogFirstRunCleared: false,                // false until every first-scan item has been approved/removed at least once
    learningQueue: [],                            // [{id, jid, phone, pushName, question, answer, createdAt}] — see appendMessage/handleOutboundMessage
    replySplit: { date: '', local: 0, gemini: 0 }, // local-reply-engine vs Gemini split for today's panel counter
    // Split in two because only one of them carries WhatsApp ban risk: WhatsApp restricts
    // accounts for INITIATING chats, not for replying to one. initiatedSentToday is
    // capped by DAILY_INITIATED_CAP (backlog opens, follow-ups, payment reminders,
    // payment-details sends — anything the bot sends to a contact who hasn't messaged us
    // in the last 24h); replySentToday is a reactive reply/welcome to someone who just
    // messaged (or called) us and is NEVER capped — tracked here only for the panel stat.
    initiatedSentToday: { date: '', count: 0 },
    replySentToday: { date: '', count: 0 }
  }
};

function ensure() {
  if (!fs.existsSync(path.dirname(LEADS_PATH))) fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
  if (!fs.existsSync(LEADS_PATH)) fs.writeFileSync(LEADS_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
}

export function read() {
  ensure();
  return JSON.parse(fs.readFileSync(LEADS_PATH, 'utf-8'));
}

export function write(db) {
  ensure();
  fs.writeFileSync(LEADS_PATH, JSON.stringify(db, null, 2));
}

export function update(fn) {
  const db = read();
  fn(db);
  write(db);
  return db;
}

const istDateKey = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// ---------- lead CRUD ----------
export function getLead(jid) {
  return read().leads[jid] || null;
}

export function getAllLeads() {
  return Object.values(read().leads).sort((a, b) => (b.lastInboundAt || 0) - (a.lastInboundAt || 0));
}

// Idempotent — returns the existing record if this jid is already tracked.
export function createLead(jid, { phone, pushName } = {}) {
  let lead;
  update(d => {
    if (d.leads[jid]) { lead = d.leads[jid]; return; }
    lead = d.leads[jid] = {
      jid, phone: phone || jid.split('@')[0], pushName: pushName || '',
      state: 'new', createdAt: Date.now(),
      lastInboundAt: null, lastOutboundAt: null, replyCount: 0,
      messages: [],                          // {dir:'in'|'out', text, ts}
      followUps: { sentAt: [], count: 0 },
      flags: [],                             // {reason, ts} — knowledge-base section 11 hard-stops
      flagsAcknowledgedAt: null,
      manualOverride: null,                  // 'ignore' | 'converted' | null
      pendingSend: null,                     // {text, intent, escalate, escalateReason, createdAt} — held back by silent hours
      lastResolvedUnansweredAt: null,        // last time an 'unanswered_question' escalation for this jid was captured/resolved
      welcomedAt: null                       // set once the first-contact welcome message is confirmed delivered — see leadResponder.js
    };
  });
  return lead;
}

// Set only after deliver() confirms the welcome actually went out — same never-mark-sent-
// unless-confirmed rule as everything else in this store. If it stays null (delivery
// failed), the next inbound message from this jid retries the welcome once more.
export function markWelcomed(jid) {
  update(d => { if (d.leads[jid]) d.leads[jid].welcomedAt = Date.now(); });
}

// isFollowUp: a reminder still belongs in the transcript (so Gemini sees it, so the
// panel shows it) but must NOT update lastOutboundAt/replyCount — the follow-up cron
// measures each 24h/3d/7d window from the last REAL reply, not from the previous
// follow-up, so a follow-up send must never reset that anchor or it'd never catch up.
// tier/model: which priority tier (0-3) and which model actually produced an 'out'
// message — null for 'in' messages. Surfaced in the Leads tab and the audit log.
export function appendMessage(jid, { dir, text, isFollowUp = false, tier = null, model = null }) {
  update(d => {
    const lead = d.leads[jid];
    if (!lead) return;
    const ts = Date.now();
    lead.messages.push({ dir, text, ts, ...(dir === 'out' ? { tier, model } : {}) });
    if (lead.messages.length > MAX_STORED_MESSAGES) lead.messages = lead.messages.slice(-MAX_STORED_MESSAGES);
    if (dir === 'in') lead.lastInboundAt = ts;
    else if (!isFollowUp) { lead.lastOutboundAt = ts; lead.replyCount++; }
  });
}

export function lastMessages(jid, n = 20) {
  const lead = getLead(jid);
  return lead ? lead.messages.slice(-n) : [];
}

const STATES = ['new', 'informed', 'interested', 'silent', 'converted'];
export function setState(jid, state) {
  if (!STATES.includes(state)) throw new Error(`Unknown lead state: ${state}`);
  update(d => { if (d.leads[jid]) d.leads[jid].state = state; });
}

export function setManualOverride(jid, value) {
  update(d => { if (d.leads[jid]) d.leads[jid].manualOverride = value; });
}

export function addFollowUp(jid) {
  update(d => {
    const lead = d.leads[jid];
    if (!lead) return;
    lead.followUps.sentAt.push(Date.now());
    lead.followUps.count++;
  });
}

export function addFlag(jid, reason) {
  update(d => { if (d.leads[jid]) d.leads[jid].flags.push({ reason, ts: Date.now() }); });
}

export function acknowledgeFlags(jid) {
  update(d => { if (d.leads[jid]) d.leads[jid].flagsAcknowledgedAt = Date.now(); });
}

export function setPendingSend(jid, payload) {
  update(d => { if (d.leads[jid]) d.leads[jid].pendingSend = payload; });
}

export function clearPendingSend(jid) {
  update(d => { if (d.leads[jid]) d.leads[jid].pendingSend = null; });
}

// ---------- daily new-lead cap (IST calendar day) ----------
export function getDailyCount() {
  const db = read();
  return db.meta.dailyCount.date === istDateKey() ? db.meta.dailyCount.count : 0;
}

export function incrementDailyCount() {
  update(d => {
    const today = istDateKey();
    if (d.meta.dailyCount.date !== today) d.meta.dailyCount = { date: today, count: 0 };
    d.meta.dailyCount.count++;
  });
}

// ---------- local-reply-engine vs Gemini split (today, IST) — panel counter ----------
export function getReplySplitToday() {
  const db = read();
  const c = db.meta.replySplit || { date: '', local: 0, gemini: 0 };
  return c.date === istDateKey() ? c : { date: istDateKey(), local: 0, gemini: 0 };
}

export function incrementReplySplit(kind) {
  update(d => {
    const today = istDateKey();
    if (!d.meta.replySplit || d.meta.replySplit.date !== today) d.meta.replySplit = { date: today, local: 0, gemini: 0 };
    d.meta.replySplit[kind] = (d.meta.replySplit[kind] || 0) + 1;
  });
}

// ---------- outbound safety: hard daily cap on lead-facing AUTO sends (IST calendar day) ----------
// Scoped to src/leadResponder.js#deliver's AUTO-mode branch (and the other proactive
// senders that reuse the same kill-switch/cap: src/paymentSender.js, src/studentPayments.js's
// reminder sender) — DRAFT-mode notes to the operator's own Note-to-Self never reach a
// lead's real number, so they carry none of the ban-risk this cap exists for and are
// deliberately not counted here. This is the CAPPED counter (DAILY_INITIATED_CAP) — for
// the never-capped reply counter, see getReplySentToday below.
export function getInitiatedSentToday() {
  const db = read();
  const c = db.meta.initiatedSentToday || { date: '', count: 0 };
  return c.date === istDateKey() ? c.count : 0;
}

export function incrementInitiatedSentToday() {
  update(d => {
    const today = istDateKey();
    if (!d.meta.initiatedSentToday || d.meta.initiatedSentToday.date !== today) d.meta.initiatedSentToday = { date: today, count: 0 };
    d.meta.initiatedSentToday.count++;
  });
}

// Reactive replies (and the first-contact welcome) to a contact who messaged — or
// called — us within the last 24 hours. Never checked against a cap; tracked purely for
// the panel's stat display, kept separate from initiatedSentToday so the two can never be
// confused with each other.
export function getReplySentToday() {
  const db = read();
  const c = db.meta.replySentToday || { date: '', count: 0 };
  return c.date === istDateKey() ? c.count : 0;
}

export function incrementReplySentToday() {
  update(d => {
    const today = istDateKey();
    if (!d.meta.replySentToday || d.meta.replySentToday.date !== today) d.meta.replySentToday = { date: today, count: 0 };
    d.meta.replySentToday.count++;
  });
}

// ---------- backlog scan queue ----------
// Defensively fall back to [] / defaults everywhere here — an existing data/leads.json
// from before this feature existed won't have these meta fields, and DEFAULT_DB above
// only applies to a brand-new file, not a migration of an old one.
export function getBacklogQueue() {
  return read().meta.backlogQueue || [];
}

// Idempotent — a jid already in the queue is left as-is, not duplicated or overwritten.
export function addToBacklogQueue(entry) {
  update(d => {
    d.meta.backlogQueue = d.meta.backlogQueue || [];
    if (d.meta.backlogQueue.some(e => e.jid === entry.jid)) return;
    d.meta.backlogQueue.push(entry);
  });
}

export function removeFromBacklogQueue(jid) {
  update(d => { d.meta.backlogQueue = (d.meta.backlogQueue || []).filter(e => e.jid !== jid); });
}

// Vestigial now that sending is manual-only (Part 4 outbound safety) — approval no
// longer gates anything, but kept for the existing POST /api/backlog/:jid/approve route
// rather than breaking that endpoint outright.
export function approveBacklogItem(jid) {
  update(d => {
    const item = (d.meta.backlogQueue || []).find(e => e.jid === jid);
    if (item) item.approved = true;
  });
}

export function isBacklogFirstRunCleared() {
  return !!read().meta.backlogFirstRunCleared;
}

export function clearBacklogFirstRun() {
  update(d => { d.meta.backlogFirstRunCleared = true; });
}

export function getBacklogSentToday() {
  const db = read();
  const c = db.meta.backlogSentToday || { date: '', count: 0 };
  return c.date === istDateKey() ? c.count : 0;
}

export function incrementBacklogSentToday() {
  update(d => {
    const today = istDateKey();
    if (!d.meta.backlogSentToday || d.meta.backlogSentToday.date !== today) d.meta.backlogSentToday = { date: today, count: 0 };
    d.meta.backlogSentToday.count++;
  });
}

export function getBacklogLastSendAt() {
  return read().meta.backlogLastSendAt || null;
}

export function setBacklogLastSendAt(ts) {
  update(d => { d.meta.backlogLastSendAt = ts; });
}

// ---------- learning loop ----------
// Whenever the operator manually replies in a lead chat to a question the bot flagged
// as an 'unanswered_question' escalation (a real knowledge-base content gap, not a
// generic "team will confirm"), leadResponder.js#handleOutboundMessage queues the pair
// here for review. Nothing ever reaches course-knowledge.md without an explicit
// approve — see gemini.js#appendFaqPair, only ever called from the approve route.
export function markUnansweredResolved(jid) {
  update(d => { if (d.leads[jid]) d.leads[jid].lastResolvedUnansweredAt = Date.now(); });
}

export function getLearningQueue() {
  return read().meta.learningQueue || [];
}

export function addToLearningQueue({ jid, phone, pushName, question, answer }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  update(d => {
    d.meta.learningQueue = d.meta.learningQueue || [];
    d.meta.learningQueue.push({ id, jid, phone, pushName: pushName || '', question, answer, createdAt: Date.now() });
  });
  return id;
}

export function removeFromLearningQueue(id) {
  update(d => { d.meta.learningQueue = (d.meta.learningQueue || []).filter(e => e.id !== id); });
}

export function getLearningQueueItem(id) {
  return (read().meta.learningQueue || []).find(e => e.id === id) || null;
}

// ---------- audit log (append-only JSONL) ----------
export function logEvent({ jid, action, detail }) {
  ensure();
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: Date.now(), jid, action, detail: detail || null }) + '\n');
}

function readLogLines() {
  ensure();
  const raw = fs.readFileSync(LOG_PATH, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

export function getLogForJid(jid, limit = 50) {
  return readLogLines().filter(l => l.jid === jid).slice(-limit).reverse();
}

// Generic time-windowed query, e.g. the weekly unanswered-questions digest reading the
// past 7 days of action:'unanswered_question' lines across every lead.
export function getLogSince(sinceTs, action = null) {
  return readLogLines().filter(l => l.ts >= sinceTs && (!action || l.action === action));
}

// Most recent "filtered_saved_contact" entry per jid — recovery list for the Leads tab
// ("treat as lead" button), so a wrongly-dropped number only shows up once.
export function getFilteredContacts(limit = 100) {
  const byJid = new Map();
  for (const l of readLogLines()) {
    if (l.action === 'filtered_saved_contact') byJid.set(l.jid, l); // later write overwrites, file is append-ordered
  }
  return [...byJid.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}
