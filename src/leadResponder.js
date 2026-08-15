// Orchestrates the AI lead auto-responder: wires whatsapp.js (transport), gemini.js
// (classify/reply), and leadStore.js (state + audit log) into the full rule chain from
// the spec. server.js registers handleInboundMessage via WA.setInboundMessageHandler().
import * as WA from './whatsapp.js';
import * as LS from './leadStore.js';
import * as G from './gemini.js';
import { read as readDb } from './store.js';

const DEFAULT_CONFIG = {
  mode: 'draft', dailyCap: 30, silentHours: { start: 23, end: 8 },
  paymentAutoSend: false // opt-in only — same reasoning as DRAFT-mode-first for everything else
};

// Exported — src/backlogScan.js needs the same config + silent-hours logic rather than
// a second, potentially-drifting copy of it.
export function getConfig() {
  // Shallow merge, matching how the rest of the app writes config (server.js's
  // PUT /api/config replaces nested objects wholesale, never deep-merges them) — and
  // defends against a pre-existing data/db.json from before this feature existed.
  return { ...DEFAULT_CONFIG, ...(readDb().config.leadResponder || {}) };
}

// Code-side gate for Payment Details Auto-Send. Deliberately does NOT check whether
// data/course-knowledge.md's PAYMENT_DETAILS section is actually filled in — gemini.js's
// generateReply re-checks that independently and simply omits the section from the
// prompt if it's empty, so this function staying "on" with nothing filled in is safe by
// construction, not by coincidence.
function paymentDetailsEligible(cfg, lead) {
  return !!cfg.paymentAutoSend && (lead.replyCount || 0) >= 3;
}

// IST has no DST, fixed UTC+5:30 — plain offset arithmetic avoids any dependence on the
// host's ICU/locale data (unlike Intl.DateTimeFormat's hour extraction).
function istHour(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).getUTCHours();
}

export function inSilentHours(cfg) {
  const h = istHour();
  const { start, end } = cfg.silentHours;
  return start > end ? (h >= start || h < end) : (h >= start && h < end); // wraps midnight
}

// Fire-and-forget notice to the operator's own Note-to-Self. Failure here doesn't affect
// lead state — it's a supplementary heads-up, not the thing being tracked as "delivered".
function notifyOperator(text) {
  return WA.sendMessage({ text }).catch(e => console.error('Operator notify failed:', e.message));
}

// ---------- repeat detection ----------
// Tier 0 is deterministic — the same trigger always produces byte-identical text, so if
// the KB routing ever mismatches two different questions onto the same topic, the bot
// would send the exact same canned line twice in one chat (this is what actually
// happened live, on top of the "timing" mismatch bug in gemini.js#routeTier — fixed
// there, but this is an independent safety net regardless of root cause). Whatever reply
// is about to go out, tier 0 or generated, if it's a near-duplicate of something already
// sent in this chat, don't send it — regenerate a real answer via Tier 2 instead.
function normalizeForCompare(t) {
  return (t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function textSimilarity(a, b) {
  const wa = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const wb = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return (2 * overlap) / (wa.size + wb.size); // Dice coefficient over word sets
}

function isNearDuplicateOfRecent(jid, candidateText, { threshold = 0.85, lookback = 10 } = {}) {
  const recentOut = LS.lastMessages(jid, lookback).filter(m => m.dir === 'out');
  return recentOut.some(m => textSimilarity(m.text, candidateText) >= threshold);
}

// Priority-based model routing. The tier decision itself (G.routeTier) is pure
// deterministic pattern-matching — no LLM call to decide which model handles the reply.
// Tier 0 skips generation entirely (verbatim knowledge-base text). Tier 2 gets exactly
// one fallback attempt via Tier 3's model on quota exhaustion (a different model, a
// different quota pool). Every inbound message gets a reply — there is no "hold back
// and escalate instead" path here anymore; safety for price/payment content comes from
// gemini.js's {{FEE}}/{{PAYMENT_DETAILS}} template substitution (the model can never
// type a real number), not from detecting and blocking after the fact. Any tier can use
// those tokens. Used by handleInboundMessage below and by backlogScan.js's opener
// generation (exported for that reuse).
export async function generateTieredReply({ jid, phone, text, leadState, intent, paymentDetailsAllowed, offHours }) {
  const { tier, model, answer } = G.routeTier({ text, intent });

  if (tier === 0) {
    let reply = answer;
    if (offHours) {
      const note = G.loadOffHoursNote();
      if (note) reply = `${reply}\n\n${note}`; // deterministic append — no LLM call, so no language adaptation (documented tradeoff in gemini.js#routeTier)
    }

    if (!isNearDuplicateOfRecent(jid, reply)) {
      LS.logEvent({ jid, action: 'tier_routed', detail: { tier: 0, model: null } });
      return {
        reply, escalate: false, escalateReason: null, escalateType: null,
        hotLead: false, hotLeadSummary: null, paymentDetailsIncluded: false,
        quotaExhausted: false, tier: 0, model: null
      };
    }
    // A deterministic answer can't vary itself — the only fix for a repeat is a real
    // generation, so escalate straight to Tier 2 instead of sending the same line twice.
    LS.logEvent({ jid, action: 'tier0_dedup_escalated', detail: { deterministicAnswer: answer } });
    const dedupModel = G.getTierModel(2);
    const dedupResult = await G.generateReply({ messages: LS.lastMessages(jid, 20), leadState, intent, paymentDetailsAllowed, offHours, model: dedupModel });
    LS.logEvent({ jid, action: 'tier_routed', detail: { tier: 2, model: dedupModel } });
    return { ...dedupResult, tier: 2, model: dedupModel };
  }

  let usedTier = tier, usedModel = model;
  let result = await G.generateReply({ messages: LS.lastMessages(jid, 20), leadState, intent, paymentDetailsAllowed, offHours, model });

  if (result.quotaExhausted && tier === 2) {
    usedTier = 3; usedModel = G.getTierModel(3);
    LS.logEvent({ jid, action: 'tier_fallback', detail: { from: 2, to: 3 } });
    result = await G.generateReply({ messages: LS.lastMessages(jid, 20), leadState, intent, paymentDetailsAllowed, offHours, model: usedModel });
  }

  // Same safety net for a generated reply — rarer than Tier 0's guaranteed-identical
  // case, but a short generic LLM reply can still coincidentally repeat. One escalation
  // attempt via Tier 2's model; if that's STILL a duplicate, send it rather than looping
  // — at that point the conversation itself may just be genuinely repetitive.
  if (result.reply && usedTier !== 2 && isNearDuplicateOfRecent(jid, result.reply)) {
    LS.logEvent({ jid, action: 'reply_dedup_escalated', detail: { from: usedTier } });
    usedTier = 2; usedModel = G.getTierModel(2);
    result = await G.generateReply({ messages: LS.lastMessages(jid, 20), leadState, intent, paymentDetailsAllowed, offHours, model: usedModel });
  }

  LS.logEvent({ jid, action: 'tier_routed', detail: { tier: usedTier, model: usedModel } });

  return { ...result, tier: usedTier, model: usedModel };
}

export async function handleInboundMessage({ jid, phone, pushName, text }) {
  // 1) Fail-closed contact-cache gate — see src/whatsapp.js#isContactCacheReady.
  if (!WA.isContactCacheReady()) {
    LS.logEvent({ jid, action: 'skipped_contact_cache_not_ready', detail: null });
    return;
  }

  // 2) Saved-contact hard skip — before any Gemini call, before any leads.json write.
  if (WA.isSavedContact(jid)) {
    LS.logEvent({ jid, action: 'filtered_saved_contact', detail: null });
    return;
  }

  const existing = LS.getLead(jid);

  // 3) Operator has already taken this number out of the bot's hands.
  if (existing?.manualOverride === 'ignore' || existing?.state === 'converted') {
    LS.logEvent({ jid, action: 'skipped_manual_override', detail: existing.manualOverride || existing.state });
    return;
  }

  // 4) Daily cap gates new leads only — an ongoing conversation always continues.
  const cfg = getConfig();
  if (!existing && LS.getDailyCount() >= cfg.dailyCap) {
    LS.logEvent({ jid, action: 'filtered_daily_cap', detail: { cap: cfg.dailyCap } });
    return;
  }

  if (!existing) {
    LS.createLead(jid, { phone, pushName });
    LS.incrementDailyCount();
  }
  LS.appendMessage(jid, { dir: 'in', text });
  const lead = LS.getLead(jid);

  // 5) Classify.
  const { intent, quotaExhausted: classifyQuotaExhausted } = await G.classifyIntent(LS.lastMessages(jid, 20));
  LS.logEvent({ jid, action: 'classified', detail: { intent, quotaExhausted: !!classifyQuotaExhausted } });

  if (classifyQuotaExhausted) {
    await notifyOperator(`⚠️ Gemini quota exhausted while classifying a message from ${phone}. Message: "${text}"\nPlease handle manually.`);
    return;
  }

  if (intent === 'not_related') return; // stay silent — clearly not about the course at all (wrong number, spam, personal message)

  // 'unclear' no longer stays silent — every inbound message gets a reply. gemini.js's
  // generateReply has its own instruction branch for 'unclear' (acknowledge naturally /
  // ask a short clarifying question, don't invent an assumption about what they meant).

  // 6) Generate reply (class_inquiry, greeting, or unclear) via priority-based model
  // routing — see generateTieredReply above. Silent hours: still answer normally (see
  // step 7) but never with payment details, regardless of the paymentAutoSend toggle —
  // real bank/UPI details wait for daytime.
  const silentNow = inSilentHours(cfg);
  const paymentDetailsAllowed = !silentNow && paymentDetailsEligible(cfg, lead);
  const { reply, escalate, escalateReason, escalateType, hotLead, hotLeadSummary, paymentDetailsIncluded, quotaExhausted: replyQuotaExhausted, tier, model } =
    await generateTieredReply({ jid, phone, text, leadState: lead.state, intent, paymentDetailsAllowed, offHours: silentNow });

  if (replyQuotaExhausted || !reply) {
    LS.logEvent({ jid, action: 'reply_skipped_quota', detail: { tier, model } });
    await notifyOperator(`⚠️ Gemini quota exhausted while replying to ${phone}. Message: "${text}"\nPlease handle manually.`);
    return;
  }

  if (escalate) {
    LS.addFlag(jid, escalateReason || 'unspecified');
    LS.logEvent({ jid, action: 'escalated', detail: escalateReason || null });
    // Unanswered Question Collector — capture the exact triggering question, separate
    // from the generic 'escalated' line, so the weekly digest cron can query for just
    // these (not payment/abuse/etc hard-stops, which are handled via the Leads tab).
    if (escalateType === 'unanswered_question') {
      LS.logEvent({ jid, action: 'unanswered_question', detail: { question: text, reason: escalateReason || null } });
    }
  }

  // 6b) Hot Lead Alert — orthogonal to escalate (a lead can be hot without needing a
  // human to take over the reply, and vice versa). Fires immediately regardless of
  // silent hours: this goes to the operator's own second number, not the lead, so none
  // of the ban-risk reasoning for holding back lead-facing sends applies here.
  if (hotLead) {
    const link = `https://wa.me/${phone}`;
    const alertText = `🔥 HOT LEAD — ${phone}${pushName ? ' (' + pushName + ')' : ''}\n${hotLeadSummary || 'Buying signal detected'}\n\nOpen chat: ${link}`;
    const result = await WA.sendToOperatorAlert(alertText);
    LS.logEvent({ jid, action: result.sent ? 'hot_lead_alert_sent' : 'hot_lead_alert_failed', detail: result.sent ? null : result.reason });
  }

  // 6c) Payment Details Auto-Send — logged + alerted at the moment the bot decides to
  // include payment details, not contingent on delivery succeeding (you want to know
  // this happened even if the DRAFT never actually gets forwarded, or an AUTO send fails).
  if (paymentDetailsIncluded) {
    LS.logEvent({ jid, action: 'payment_details_sent', detail: { mode: cfg.mode } });
    const link = `https://wa.me/${phone}`;
    const alertText = `💰 PAYMENT DETAILS SENT — ${phone}${pushName ? ' (' + pushName + ')' : ''}\nMode: ${cfg.mode}\n\nOpen chat: ${link}`;
    const result = await WA.sendToOperatorAlert(alertText);
    LS.logEvent({ jid, action: result.sent ? 'payment_alert_sent' : 'payment_alert_failed', detail: result.sent ? null : result.reason });
  }

  // 7) Deliver — inbound-triggered replies always go out now, silent hours or not. The
  // lead messaged first; this isn't the bot proactively reaching out, so the ban-risk
  // reasoning that still holds back backlogScan.js's sender and sendFollowUp doesn't
  // apply here. The reply itself already carries the off-hours note and omits payment
  // details when silentNow is true — see step 6 and gemini.js#generateReply's offHours.
  await deliver({ jid, phone, pushName, reply, mode: cfg.mode, escalate, escalateReason, tier, model });

  // 8) State transition.
  advanceState(jid, lead, intent);
}

// Actually sends (or drafts) a reply and records it — shared by the live path above,
// sendFollowUp, and backlogScan.js's sender (exported for that reuse — a backlog "open
// the conversation" send is delivered exactly like any other reply, nothing special
// about it).
export async function deliver({ jid, phone, pushName, reply, mode, escalate, escalateReason, isFollowUp = false, tier = null, model = null }) {
  const who = pushName ? `${phone} (${pushName})` : phone;
  const label = isFollowUp ? 'follow-up' : 'reply';
  try {
    if (mode === 'auto') {
      await WA.sendWithTypingDelay({ jid, text: reply });
      // Only AUTO actually reaches the lead's own chat — DRAFT just messages the
      // operator, so marking the chat "replied" there would be wrong until (if) they
      // manually forward it, which Baileys' own message reflection already captures.
      WA.markChatReplied(jid);
      if (escalate) await notifyOperator(`⚠️ Auto-replied to ${who}, but this needs you: ${escalateReason || 'see Leads tab'}`);
    } else {
      const note = `📋 DRAFT ${label} for ${who}:\n\n${reply}\n\n(forward this manually if it looks good)` +
        (escalate ? `\n\n⚠️ Flagged: ${escalateReason || 'see Leads tab'}` : '');
      const result = await WA.sendMessage({ text: note });
      if (!result.sent) throw new Error(result.reason || 'send failed');
    }
  } catch (e) {
    // Don't record the message as delivered if it wasn't — a silently-failed send must
    // not poison the lead's history with a reply that never actually went anywhere.
    LS.logEvent({ jid, action: isFollowUp ? 'followup_send_failed' : 'reply_send_failed', detail: { mode, error: e.message } });
    console.error(`Failed to deliver ${label} to ${jid}:`, e.message);
    return false;
  }
  LS.appendMessage(jid, { dir: 'out', text: reply, isFollowUp, tier, model });
  const action = isFollowUp ? (mode === 'auto' ? 'followup_sent' : 'followup_drafted') : (mode === 'auto' ? 'reply_sent' : 'reply_drafted');
  LS.logEvent({ jid, action, detail: { tier, model } });
  return true;
}

function advanceState(jid, lead, intent) {
  // A bare greeting never counts as engagement — wait for an actual question.
  if (lead.state === 'new' && intent !== 'greeting') return LS.setState(jid, 'informed');
  // Second class_inquiry after already having replied once — genuine engagement.
  if (lead.state === 'informed' && intent === 'class_inquiry' && lead.replyCount >= 1) return LS.setState(jid, 'interested');
  // Re-engaging after having gone quiet.
  if (lead.state === 'silent' && intent === 'class_inquiry') return LS.setState(jid, 'interested');
}

// Learning loop — fires for a genuine human-typed message sent from the operator's own
// phone into a tracked lead's chat (src/whatsapp.js#setOutboundMessageHandler, wired at
// boot in server.js). Always records the message into the transcript for accuracy; only
// QUEUES it as a learning candidate when it looks like a direct answer to something the
// bot itself flagged as an 'unanswered_question' escalation (a real knowledge-base
// content gap) since the last time one was resolved for this jid — that's a deliberately
// narrower signal than "any manual reply", so routine manual chatter doesn't flood the
// queue. Never writes to course-knowledge.md itself — see gemini.js#appendFaqPair,
// which only ever runs from the operator's explicit approve action in the panel.
export async function handleOutboundMessage({ jid, text, ts }) {
  const lead = LS.getLead(jid);
  if (!lead) return; // not a tracked lead chat — nothing to do

  LS.appendMessage(jid, { dir: 'out', text, tier: 'human', model: null });
  LS.logEvent({ jid, action: 'manual_reply_recorded', detail: null });

  const unresolvedSince = lead.lastResolvedUnansweredAt || 0;
  const unanswered = LS.getLogForJid(jid, 50).find(l => l.action === 'unanswered_question' && l.ts > unresolvedSince);
  if (!unanswered) return;

  LS.markUnansweredResolved(jid);
  const question = unanswered.detail?.question || '';
  if (!question.trim()) return; // nothing usable to queue

  LS.addToLearningQueue({ jid, phone: lead.phone, pushName: lead.pushName, question, answer: text });
  LS.logEvent({ jid, action: 'learning_pair_queued', detail: { question } });
}

// Used by scheduler.js's checkLeadFollowUps cron. followUpNumber: 1, 2, or 3. Unlike
// inbound replies (handleInboundMessage, above), this is bot-initiated/proactive, so it
// still respects silent hours — a no-op on failure/deferral is enough, since the cron
// re-evaluates eligibility (time since lastOutboundAt) on its own next tick.
export async function sendFollowUp(jid, followUpNumber) {
  const lead = LS.getLead(jid);
  if (!lead) return;
  const cfg = getConfig();
  if (inSilentHours(cfg)) return;

  const { message, quotaExhausted } = await G.generateFollowUp({ messages: LS.lastMessages(jid, 20), followUpNumber });
  if (quotaExhausted || !message) {
    LS.logEvent({ jid, action: 'followup_skipped_quota', detail: { followUpNumber } });
    return;
  }

  const delivered = await deliver({
    jid, phone: lead.phone, pushName: lead.pushName,
    reply: message, mode: cfg.mode, escalate: false, escalateReason: null, isFollowUp: true
  });
  if (!delivered) return; // failed send — don't burn one of the 3 lifetime attempts on it

  LS.addFollowUp(jid);
  if (lead.state !== 'silent') LS.setState(jid, 'silent');
}
