// Gemini: caption generation (social posts) + lead-response classification/replies.
// Uses REST so no extra SDK needed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.join(__dirname, '..', 'data', 'course-knowledge.md');

const MODEL = 'gemini-2.0-flash'; // captions

// Pinned explicitly (not a floating "-latest" alias) so a Google-side model swap can't
// silently move us onto a brand-new release with a starved free-tier quota — that's
// exactly what happened when "gemini-flash-latest" resolved to gemini-3.6-flash (20
// requests/day). Override via .env without touching code if either gets retired.
const DEFAULT_CLASSIFY_MODEL = 'gemini-3.5-flash-lite'; // cheap — classify is a 4-way label
const DEFAULT_REPLY_MODEL = 'gemini-3.5-flash';         // fallback default for callers that don't tier-route (e.g. scripts/test-reply.js, generateFollowUp)
const CLASSIFY_MODEL = process.env.GEMINI_CLASSIFY_MODEL || DEFAULT_CLASSIFY_MODEL;
const REPLY_MODEL = process.env.GEMINI_REPLY_MODEL || DEFAULT_REPLY_MODEL;

// ---------- priority-based model routing ----------
// Three tiers, three Gemini models (not three providers — see the "different models,
// same vendor" call: separate models on the same key still have separate quota pools,
// which is what actually matters for fallback-on-exhaustion, without the cost of a
// second API client/auth/response-shape to maintain).
const DEFAULT_TIER1_MODEL = 'gemini-3.5-flash';      // best — safety-critical replies
const DEFAULT_TIER2_MODEL = 'gemini-3.5-flash-lite'; // mid — normal Q&A
const DEFAULT_TIER3_MODEL = 'gemini-3.1-flash-lite'; // cheapest — greetings/small talk, and tier 2's fallback on quota exhaustion
const TIER_MODELS = {
  1: process.env.GEMINI_TIER1_MODEL || DEFAULT_TIER1_MODEL,
  2: process.env.GEMINI_TIER2_MODEL || DEFAULT_TIER2_MODEL,
  3: process.env.GEMINI_TIER3_MODEL || DEFAULT_TIER3_MODEL
};
export const getTierModel = (tier) => TIER_MODELS[tier];

// Thrown when backoff exhausts its retries on a 429 — callers turn this into a graceful
// "skip and flag" result instead of crashing the message-handling path.
export class GeminiQuotaExhaustedError extends Error {
  constructor(model) {
    super(`Gemini quota exhausted for model: ${model}`);
    this.name = 'GeminiQuotaExhaustedError';
    this.model = model;
  }
}

export async function generateCaption({ platform, filename, hint }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallback(filename, platform);

  const prompt = `You write social captions for a mentalist/magician performer (brand: Arya / "The Oracle").
Platform: ${platform}. Video file: "${filename}". ${hint ? 'Context: ' + hint : ''}
Return ONLY JSON, no markdown: {"caption": "...", "hashtags": ["#..","#.."], "description": "..."}
Caption: punchy, mysterious, 1-2 lines. Hashtags: 8-12 relevant. Description: 2-3 lines for YouTube/FB.`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      caption: parsed.caption || fallback(filename, platform).caption,
      hashtags: parsed.hashtags || [],
      description: parsed.description || ''
    };
  } catch (e) {
    console.error('Gemini caption failed, using fallback:', e.message);
    return fallback(filename, platform);
  }
}

function fallback(filename, platform) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
  return {
    caption: `${base} ✨ Kya aap dekh paaoge sach?`,
    hashtags: ['#mentalism', '#magic', '#mindreading', '#illusion', '#theoracle'],
    description: `${base}\n\nExperience the impossible. #mentalism`
  };
}

// ---------- shared: call Gemini, expect JSON back, retry on 429/503 ----------
async function callGeminiJSON(prompt, { model, maxRetries = 4 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  for (let attempt = 0; ; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );

    if (r.status === 429 || r.status === 503) {
      if (attempt < maxRetries) {
        const waitMs = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
        console.warn(`Gemini ${r.status} (${model}), retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(res => setTimeout(res, waitMs));
        continue;
      }
      if (r.status === 429) throw new GeminiQuotaExhaustedError(model);
      // 503 exhausted its retries too — falls through to the generic error below.
    }

    const data = await r.json();
    if (!r.ok) throw new Error(`Gemini API error ${r.status}: ${data?.error?.message || r.statusText}`);

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    try { return JSON.parse(clean); }
    catch { throw new Error(`Gemini returned non-JSON: ${clean.slice(0, 200)}`); }
  }
}

// ---------- lead responder: knowledge base ----------
// Read fresh every call, no caching — edits to course-knowledge.md must take effect
// on the very next message, without a server restart.
function readKnowledgeFile() {
  try { return fs.readFileSync(KB_PATH, 'utf-8'); }
  catch { return ''; }
}

// The PAYMENT_DETAILS section is carved out of the general knowledge base and handled
// entirely separately — it must NEVER be part of what classifyIntent/the default reply
// path sees (those run on every message, including message #1 from a total stranger).
function splitPaymentSection(fullText) {
  const heading = '## PAYMENT_DETAILS';
  const start = fullText.indexOf(heading);
  if (start === -1) return { general: fullText, payment: '' };
  const afterHeading = start + heading.length;
  const nextHeadingMatch = fullText.slice(afterHeading).match(/^## /m);
  const end = nextHeadingMatch ? afterHeading + nextHeadingMatch.index : fullText.length;
  return { general: fullText.slice(0, start) + fullText.slice(end), payment: fullText.slice(afterHeading, end) };
}

export function loadKnowledgeBase() {
  return splitPaymentSection(readKnowledgeFile()).general;
}

// Returns null if the section is missing, empty, or contains only the placeholder
// comment — leadResponder.js's paymentAutoSend gate checks this too, but this function
// re-checks independently so a bug in that gate can't be the only thing standing
// between an empty section and a half-filled payment message going out.
export function loadPaymentDetailsSection() {
  const raw = splitPaymentSection(readKnowledgeFile()).payment;
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  return stripped.length > 0 ? stripped : null;
}

// Generic version of the heading-to-next-heading extraction splitPaymentSection does —
// used by Tier 0 routing to pull whole sections (e.g. "## 3. The 10 classes") verbatim.
function extractSection(fullText, heading) {
  const start = fullText.indexOf(heading);
  if (start === -1) return '';
  const afterHeading = start + heading.length;
  const nextHeadingMatch = fullText.slice(afterHeading).match(/^## /m);
  const end = nextHeadingMatch ? afterHeading + nextHeadingMatch.index : fullText.length;
  return fullText.slice(afterHeading, end).trim();
}

export function loadOffHoursNote() {
  const raw = extractSection(readKnowledgeFile(), '## OFF_HOURS_NOTE').replace(/<!--[\s\S]*?-->/g, '').trim();
  return raw.length > 0 ? raw : null;
}

// Parses section 9's "**Question?**\nAnswer text..." pairs into a lookup Tier 0 can
// match against. The MAPPING of topic keywords -> which FAQ question they mean is code
// (routing logic); the ANSWER TEXT itself always comes from this parse, never hardcoded.
function parseFaqPairs(fullText) {
  const faqSection = extractSection(fullText, '## 9. FAQ');
  const pairs = [];
  const re = /\*\*(.+?)\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n---|\n##|$)/g;
  let m;
  while ((m = re.exec(faqSection))) pairs.push({ question: m[1].trim(), answer: m[2].trim() });
  return pairs;
}

const transcript = (messages) => messages.map(m => `${m.dir === 'in' ? 'LEAD' : 'TEAM'}: ${m.text}`).join('\n');

// ---------- priority-based model routing: deterministic rules only, zero LLM calls ----------
// Tier 1 first, always — a safety-critical signal must win even over a coincidental
// Tier 0 keyword match ("course kitna hai, abhi pay karna hai" must not fall to Tier 0
// just because "kitna" is also the fee-FAQ trigger).
const TIER1_KEYWORDS = /\b(upi|payment|pay karn|paisa de|paise de|bank detail|account number|mehnga|expensive|costly|discount|sasta|negotiat|kaise join|kab join|admission|enroll|ready to join|i want to join|already paid|maine pay|main karna chahta)\b/i;

// Bare low-content acknowledgements — "ok", "thanks", a thumbs-up. Deliberately does
// NOT try to catch greetings ("hi"/"namaste") — classifyIntent's 'greeting' category is
// already the authoritative, well-tested signal for that, reused directly below.
const ACK_KEYWORDS = /^(ok+|okay|thik\s*hai|theek\s*hai|haan|hmm+|acha|accha|thanks?|thank\s*you|dhanyavaad|👍+|🙏+)[\s.!?]*$/i;

// Topic -> how to find its verbatim knowledge-base answer. faqMatch looks up a parsed
// FAQ pair by question text; section pulls a whole named section instead (used where
// there's no single FAQ pair — duration/curriculum are a table and a class list, not a
// one-line answer).
//
// "online/offline" (format) and "weekend/timing" (schedule) used to share one combined
// faqMatch regex — since parseFaqPairs().find() just returns the first FAQ pair matching
// either alternative, and "Is it online or offline?" happens to come before "When are
// classes held?" in the file, EVERY trigger in that group always resolved to the
// online/offline answer, including "timing"/"weekend"/"kab hoti" — which don't actually
// answer a timing question at all. Split into two precise trigger/faqMatch pairs so each
// resolves to the FAQ entry that actually answers it.
const TIER0_TOPICS = [
  { trigger: /\b(prior experience|beginner|zero se|pehle se kuch|no experience)\b/i, faqMatch: /prior experience/i },
  { trigger: /\b(fee|price|cost|charge|kitna hai|kharcha)\b/i, faqMatch: /what is the fee/i },
  { trigger: /\b(online|offline)\b/i, faqMatch: /online or offline/i },
  { trigger: /\b(weekend|kab hoti|timing|schedule|kis din)\b/i, faqMatch: /when are classes/i },
  { trigger: /\b(duration|kitne mahine|how long|kitna time)\b/i, section: '## 2. What the course is' },
  { trigger: /\b(curriculum|syllabus|kya sikhaya|topics|classes kya)\b/i, section: '## 3. The 10 classes' }
];

// Tier 0 must only fire for ONE simple question mapping cleanly onto a single KB
// section — a compound message ("timing kya hai aur baki jankari bhi chahiye / kitna
// class hai") asking multiple things must not get a single canned answer to just one of
// them (the rest goes unanswered). Deliberately cheap/deterministic, no LLM call — that
// would defeat the point of Tier 0. Biased toward over-flagging: a false positive here
// just costs one extra Tier 2 call for a question Tier 0 could've handled; a false
// negative is the bug this exists to prevent.
function looksMultiPart(text) {
  const t = (text || '').trim();
  if ((t.match(/\?/g) || []).length > 1) return true;                          // 2+ question marks
  if (/\/|;|\n| aur | and | plus | bhi | also /i.test(` ${t} `)) return true;  // compound joiners
  if (t.split(/\s+/).filter(Boolean).length > 12) return true;                 // long messages tend to bundle multiple asks
  return false;
}

// Deterministic, cheap, zero LLM calls — this is the whole point of Tier 0/3. Returns
// {tier, model} for tiers 1-3, or {tier: 0, answer} for a verbatim knowledge-base reply
// with nothing to generate at all.
//
// Known tradeoff: a Tier 0 answer is whatever language course-knowledge.md happens to
// be written in (Hinglish), NOT translated to match the lead's language the way every
// other tier does — there's no LLM call available to do that translation without
// defeating the point of the tier. Flagged, not silently different behavior.
export function routeTier({ text, intent }) {
  if (intent === 'greeting') return { tier: 3, model: TIER_MODELS[3] };
  if (TIER1_KEYWORDS.test(text)) return { tier: 1, model: TIER_MODELS[1] };

  if (!looksMultiPart(text)) {
    const kbFull = readKnowledgeFile();
    for (const topic of TIER0_TOPICS) {
      if (!topic.trigger.test(text)) continue;
      if (topic.faqMatch) {
        const pair = parseFaqPairs(kbFull).find(p => topic.faqMatch.test(p.question));
        if (pair && !/NOT CONFIRMED/i.test(pair.answer)) return { tier: 0, answer: pair.answer };
      } else if (topic.section) {
        const excerpt = extractSection(kbFull, topic.section);
        if (excerpt) return { tier: 0, answer: excerpt };
      }
      break; // trigger matched but no usable KB answer found — fall through to tier 2, don't keep scanning
    }
  }

  if (ACK_KEYWORDS.test(text.trim())) return { tier: 3, model: TIER_MODELS[3] };
  return { tier: 2, model: TIER_MODELS[2] };
}

// Superseded: safety used to come from detecting price/payment content after the fact
// and blocking delivery. It now comes from the model never being able to type real
// numbers at all — see the {{FEE}}/{{PAYMENT_DETAILS}} placeholder mechanism in
// generateReply below, which any tier can use. No detection needed once the model has
// nothing sensitive to leak in the first place.

// {{FEE}} substitutes into the middle of a model-written sentence ("Fee hai {{FEE}}."),
// so it needs to be the short value, not the FAQ's full sentence — extracted from the
// same parsed "What is the fee?" pair Tier 0 routing already relies on. Falls back to
// the whole answer if the ₹-amount pattern ever stops matching, so a KB reformat still
// degrades to something readable instead of returning null.
export function loadFeeText() {
  const pair = parseFaqPairs(readKnowledgeFile()).find(p => /what is the fee/i.test(p.question));
  if (!pair) return null;
  const amount = pair.answer.match(/₹[\d,]+/);
  return amount ? amount[0] : pair.answer;
}

// Replaces {{FEE}} and {{PAYMENT_DETAILS}} tokens with the real, verbatim knowledge-base
// text — this is the actual enforcement mechanism, not the prompt instruction alone.
// paymentDetails: the real text to substitute, or null/undefined if this reply wasn't
// eligible (safe fallback phrase used instead, so an out-of-turn token from the model
// still can't leak anything, it just reads a little generic).
export function fillTemplates(text, { paymentDetails } = {}) {
  if (!text) return text;
  let out = text;
  if (out.includes('{{FEE}}')) {
    out = out.split('{{FEE}}').join(loadFeeText() || 'humari team confirm karke exact fee bata degi');
  }
  if (out.includes('{{PAYMENT_DETAILS}}')) {
    out = out.split('{{PAYMENT_DETAILS}}').join(paymentDetails || 'humari team aapko ye personally share karegi');
  }
  return out;
}

// ---------- learning loop: append an approved Q&A pair to the FAQ section ----------
// Only ever called from the server.js approve route, which only ever fires on an
// explicit operator click — never automatically. dryRun returns the computed result
// without touching the file, for testing the string manipulation in isolation first.
export function appendFaqPair(question, answer, { dryRun = false } = {}) {
  const full = readKnowledgeFile();
  const heading = '## 9. FAQ';
  const start = full.indexOf(heading);
  if (start === -1) throw new Error('appendFaqPair: "## 9. FAQ" heading not found in course-knowledge.md');

  const afterHeading = start + heading.length;
  const rest = full.slice(afterHeading);
  const nextHeadingMatch = rest.match(/^## /m);
  const sectionEnd = nextHeadingMatch ? afterHeading + nextHeadingMatch.index : full.length;
  const sectionText = full.slice(afterHeading, sectionEnd);

  // The FAQ section conventionally ends with a blank line + "---" right before the next
  // "## " heading — insert the new pair right before that separator so it lands inside
  // section 9, not after it. If that separator isn't found (unexpected file shape),
  // fall back to inserting at the very end of the section instead of guessing further.
  const trailingSepMatch = sectionText.match(/\n---\s*\n?$/);
  const insertAt = trailingSepMatch ? afterHeading + trailingSepMatch.index + 1 : sectionEnd;

  const q = question.trim().replace(/\*\*/g, '');
  const a = answer.trim();
  const block = `**${q}**\n${a}\n\n`;
  const updatedText = full.slice(0, insertAt) + block + full.slice(insertAt);

  if (!dryRun) fs.writeFileSync(KB_PATH, updatedText, 'utf-8');
  return { updatedText, insertedBlock: block };
}

// ---------- lead responder: classify ----------
// messages: [{dir:'in'|'out', text}], oldest first (src/leadStore.js#lastMessages).
const INTENTS = ['class_inquiry', 'greeting', 'not_related', 'unclear'];

export async function classifyIntent(messages) {
  const kb = loadKnowledgeBase();
  const isFirstMessage = messages.length === 1;
  const prompt = `KNOWLEDGE BASE (context on the business this WhatsApp number represents):
"""
${kb}
"""

Below is a WhatsApp conversation with an unknown number. This is the lead's first-ever
message in this chat: ${isFirstMessage}.

Classify the LEAD's intent as exactly one of:
- "class_inquiry" — asking about, or showing clear interest in, the course described in
  the knowledge base
- "greeting" — ONLY when this is the lead's first-ever message AND it is a short opener
  with no other content (e.g. "hi", "hello", "namaste", "hey", "gm") — nothing to answer
  yet, just an opener. A bare "hi" later in an existing conversation is NOT this category.
- "not_related" — clearly about something else (wrong number, spam, personal message,
  unrelated business)
- "unclear" — ambiguous, not enough to tell either way, and not a bare opening greeting

CONVERSATION (oldest first):
${transcript(messages)}

Return ONLY JSON, no markdown: {"intent": "class_inquiry" | "greeting" | "not_related" | "unclear"}`;

  try {
    const parsed = await callGeminiJSON(prompt, { model: CLASSIFY_MODEL });
    const intent = INTENTS.includes(parsed.intent) ? parsed.intent : 'unclear';
    return { intent };
  } catch (e) {
    if (e instanceof GeminiQuotaExhaustedError) {
      console.error(e.message);
      return { intent: 'unclear', quotaExhausted: true };
    }
    throw e;
  }
}

// ---------- lead responder: generate reply ----------
// leadState: the tracked stage from leadStore (new/informed/interested/silent/converted),
// given as context so the model knows how much has already been revealed.
// intent: the classifyIntent() result for the latest message — 'greeting' switches to the
// knowledge base's dedicated "Greetings" section instead of its general reply rules. The
// branch itself (which mode to generate in) lives in code; the actual wording/behavior for
// each mode is entirely sourced from the file.
// paymentDetailsAllowed: computed by leadResponder.js from code-side conditions
// (feature toggle on, lead has enough real exchanges already, not silent hours) — NOT
// decided here, and the REAL payment text is never fetched or embedded in the prompt at
// all anymore. The model is only ever told it MAY use the {{PAYMENT_DETAILS}} token;
// the actual substitution happens after generation, in fillTemplates(). This means the
// real bank/UPI details never need to leave this server and reach the Gemini API in the
// first place — a stronger position than the old "embed it and trust the model to only
// use it when told to" approach.
// offHours: true during silent hours — the reply is still full and normal, but adds the
// off-hours closing line. The payment gate itself already accounts for offHours (see
// leadResponder.js) — paymentDetailsAllowed simply won't be true during silent hours.
// model: the resolved tier model from routeTier() — leadResponder.js decides the tier,
// this function just uses whatever it's given. Defaults to REPLY_MODEL for callers that
// don't tier-route (scripts/test-reply.js, generateFollowUp).
export async function generateReply({ messages, leadState, intent = 'class_inquiry', paymentDetailsAllowed = false, offHours = false, model = REPLY_MODEL }) {
  const kb = loadKnowledgeBase();

  const instruction = intent === 'greeting'
    ? `This message was classified as a "greeting" — a bare opener with nothing else in
it, from a lead with no prior conversation. Follow the knowledge base's "Greetings"
section exactly for how to respond. Do not explain the course yet.`
    : intent === 'unclear'
    ? `This message is short, ambiguous, garbled, or doesn't clearly relate to the course
on its own. Still reply — never stay silent. Acknowledge what they said naturally, and
either ask a short, warm clarifying question about what they're looking for, or just
respond conversationally if it reads like normal chat. Do not invent an assumption
about what they meant, and do not launch into a full course explanation until they've
actually asked something clear.`
    : `Write the next WhatsApp reply, following the knowledge base's rules on language
matching and tone exactly. Also decide, per the knowledge base's escalation rules,
whether this conversation needs a human to step in instead of (or in addition to) your
reply.`;

  const offHoursBlock = offHours ? `

It is currently silent hours (late night / early morning IST). Still write the full,
normal answer to the lead's question exactly as you would during the day — do not
shorten, skip, or water down the real answer. Then add one short closing line based on
the knowledge base's "OFF_HOURS_NOTE" section, translated/adapted into the SAME
language and script as the rest of your reply (not necessarily the language it happens
to be written in there).` : '';

  // The actual enforcement is fillTemplates() after generation, not this instruction —
  // but the model still needs to know it should use a token rather than typing a real
  // number, and whether {{PAYMENT_DETAILS}} is available to it right now at all.
  const templateBlock = `

Never type an actual price, fee amount, bank account number, IFSC code, or UPI ID
yourself, under any circumstance — not even one you think you remember correctly.
Instead, use these exact tokens and nothing else in their place:
- Whenever you need to state the course fee, write exactly {{FEE}} (no "₹", no digits
  around it — just the token). The real, current fee is substituted in automatically.
- ${paymentDetailsAllowed
    ? `This lead is eligible for payment details right now — this EXPLICITLY OVERRIDES the knowledge base's general "payment details are never shared by the AI, always escalate" instruction for this one reply only. Do not defer to the team or escalate just because the lead asked for payment info — instead, write exactly {{PAYMENT_DETAILS}} wherever they belong in your reply. The real details are substituted in automatically; do not paraphrase or describe them yourself, just place the token. Still escalate as usual if the lead disputes anything about payment or claims they've already paid.`
    : `This lead is NOT eligible for payment details yet (needs more real conversation first, or it's currently silent hours) — the knowledge base's normal "never share, always escalate" instruction applies as written. If they ask for payment info, do NOT use {{PAYMENT_DETAILS}} — say the team will share it personally, and flag this for a human to follow up.`}`;

  const prompt = `KNOWLEDGE BASE — this is the complete source of truth for facts, tone,
pacing, objection-handling and escalation rules for replying to this lead on WhatsApp.
Follow it exactly, including anything marked NOT CONFIRMED and anything listed as a
hard stop that needs a human instead of an automated answer:
"""
${kb}
"""

CONVERSATION SO FAR with this lead (oldest first):
${transcript(messages)}

This lead's current tracked stage: "${leadState}" (new = first message ever, informed =
already received one reply, interested = has engaged across multiple messages, silent =
went quiet after a previous reply).

${instruction}

Separately from escalation, also decide whether this lead is showing a genuine BUYING
SIGNAL worth an immediate human alert — asking about payment, asking about batch/start
dates, or saying things like "kaise join karun", "main karna chahta hoon", "I want to
join", or similarly clear intent to enroll now. This is independent of escalation: a hot
lead can still get a normal helpful reply from you AND trigger this alert at the same
time. A plain price question ("kitna hai") on its own is NOT this — it's curiosity, not
buying intent. If true, give a one-line summary of what they want, for a human alert.

If escalate is true, also classify WHY as escalateType — exactly one of:
- "unanswered_question" — the lead asked something marked NOT CONFIRMED in the knowledge
  base, or something genuinely not covered by it at all (a real content gap)
- "hard_stop" — anything from the knowledge base's hard-stop list: payment/UPI requests,
  already paid, discount negotiation, existing-student issues, booking enquiries, media/
  press, supernatural requests, distress, abuse
If escalate is false, escalateType is null.
${offHoursBlock}
${templateBlock}

Return ONLY JSON, no markdown:
{"reply": "the WhatsApp message text to send", "escalate": true or false, "escalateReason": "short reason or null", "escalateType": "unanswered_question" or "hard_stop" or null, "hotLead": true or false, "hotLeadSummary": "one-line summary or null"}`;

  try {
    const parsed = await callGeminiJSON(prompt, { model });
    const rawReply = parsed.reply || '';
    // Code-verified, not model-self-reported: did the model actually place the token,
    // was it actually eligible to, AND is there real content to substitute? Only true
    // when all three hold — an out-of-turn attempt (not eligible) or an empty section
    // still gets a safe fallback phrase from fillTemplates, but must never be reported
    // as a real send when it wasn't one.
    const paymentDetails = (paymentDetailsAllowed && rawReply.includes('{{PAYMENT_DETAILS}}')) ? loadPaymentDetailsSection() : null;
    const paymentDetailsIncluded = !!paymentDetails;
    return {
      reply: fillTemplates(rawReply, { paymentDetails }),
      escalate: !!parsed.escalate,
      escalateReason: parsed.escalateReason || null,
      escalateType: ['unanswered_question', 'hard_stop'].includes(parsed.escalateType) ? parsed.escalateType : null,
      hotLead: !!parsed.hotLead,
      hotLeadSummary: parsed.hotLeadSummary || null,
      paymentDetailsIncluded
    };
  } catch (e) {
    if (e instanceof GeminiQuotaExhaustedError) {
      console.error(e.message);
      return {
        reply: null, escalate: true, escalateReason: 'gemini_quota_exhausted', escalateType: null, quotaExhausted: true,
        paymentDetailsIncluded: false,
        hotLead: false, hotLeadSummary: null
      };
    }
    throw e;
  }
}

// ---------- lead responder: follow-ups ----------
// followUpNumber: 1, 2, or 3 — maps to the 24h/3d/7d windows in the knowledge base's
// "Follow-ups" section. Needs the actual conversation to reference what the lead
// specifically asked about — a follow-up that ignores that reads as spam (per the KB).
export async function generateFollowUp({ messages, followUpNumber }) {
  const kb = loadKnowledgeBase();
  const prompt = `KNOWLEDGE BASE — this is the complete source of truth for facts, tone
and follow-up rules, including the specific "Follow-ups" section governing this message:
"""
${kb}
"""

CONVERSATION SO FAR with this lead, who has gone quiet since their last reply (oldest first):
${transcript(messages)}

This is follow-up number ${followUpNumber} of the maximum 3. Follow the knowledge base's
"Follow-ups" section exactly for this specific follow-up number — read the earlier
conversation and reference the specific thing this lead was interested in.

Return ONLY JSON, no markdown:
{"message": "the WhatsApp follow-up text to send"}`;

  try {
    const parsed = await callGeminiJSON(prompt, { model: REPLY_MODEL });
    return { message: parsed.message || null };
  } catch (e) {
    if (e instanceof GeminiQuotaExhaustedError) {
      console.error(e.message);
      return { message: null, quotaExhausted: true };
    }
    throw e;
  }
}
