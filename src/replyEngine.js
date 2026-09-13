// Local (no-LLM) reply engine for the WhatsApp lead responder. Intent-matching against
// data/replies.json runs BEFORE any Gemini call — see src/leadResponder.js, which only
// falls back to Gemini when detectIntent() returns null (no confident local match).
// Keeps replies fast, cheap (zero Gemini quota burned on routine messages), and on-tone
// by construction, since the wording is fixed by a human, not generated per message.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPLIES_PATH = path.join(__dirname, '..', 'data', 'replies.json');
const ROTATION_PATH = path.join(__dirname, '..', 'data', 'reply-rotation.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'reply-engine-log.jsonl');

// Below this, detectIntent returns null so the caller falls back to Gemini rather than
// risk sending a canned reply to a message it doesn't actually recognize.
const CONFIDENCE_THRESHOLD = 0.55;

// ---------- data/replies.json (read fresh every call, no caching — same convention as
// course-knowledge.md: an operator edit takes effect on the very next message) ----------
function loadReplies() {
  try { return JSON.parse(fs.readFileSync(REPLIES_PATH, 'utf-8')).intents || {}; }
  catch (e) { console.error('replyEngine: failed to load data/replies.json:', e.message); return {}; }
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(REPLIES_PATH, 'utf-8')).config || {}; }
  catch (e) { console.error('replyEngine: failed to load data/replies.json config:', e.message); return {}; }
}

// First-contact welcome variants live in their own top-level block (data/replies.json's
// "welcome" key), not inside "intents" — the welcome isn't triggered by keyword/pattern
// matching at all, so it has no place in the detectIntent scoring loop below. See
// pickWelcomeVariant / leadResponder.js's first-contact hook in handleInboundMessage.
function loadWelcome() {
  try { return JSON.parse(fs.readFileSync(REPLIES_PATH, 'utf-8')).welcome || {}; }
  catch (e) { console.error('replyEngine: failed to load data/replies.json welcome block:', e.message); return {}; }
}

// ---------- template substitution ----------
// Same idea as gemini.js's {{FEE}}/{{PAYMENT_DETAILS}} tokens — variant text carries a
// token, never the real value, so a fee change or a manager handover is a one-line edit
// to config, not a find-and-replace across 80+ intents. IST calendar-day comparison,
// same offset-arithmetic convention as leadResponder.js's silentHours / leadStore.js's
// istDateKey — not Intl or the host TZ.
function istDateKey(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// {{course_fee_current}} resolves to config.course_fee_current while today is on or
// before promo_deadline, then automatically flips to course_fee_standard the day after —
// the whole point of tracking a deadline instead of just overwriting the price by hand,
// since a promo that "expires" only when someone remembers to edit the JSON isn't really
// an expiry. Falls back to whichever fee value actually exists if promo_deadline is
// missing/malformed, rather than leaving the raw token in a lead-facing message.
function effectiveCourseFee(cfg) {
  if (cfg.promo_deadline && istDateKey() > cfg.promo_deadline) {
    return cfg.course_fee_standard || cfg.course_fee_current || '{{course_fee_current}}';
  }
  return cfg.course_fee_current || cfg.course_fee_standard || '{{course_fee_current}}';
}

export function fillTemplates(text) {
  if (!text || !text.includes('{{')) return text;
  const cfg = loadConfig();
  const tokens = {
    '{{course_fee_current}}': effectiveCourseFee(cfg),
    '{{course_fee_standard}}': cfg.course_fee_standard || '{{course_fee_standard}}',
    '{{manager_name}}': cfg.manager_name || '{{manager_name}}',
    '{{manager_full_name}}': cfg.manager_full_name || '{{manager_full_name}}',
    '{{agency_name}}': cfg.agency_name || '{{agency_name}}',
    '{{whatsapp_number}}': cfg.whatsapp_number || '{{whatsapp_number}}'
  };
  let out = text;
  for (const [token, value] of Object.entries(tokens)) {
    if (out.includes(token)) out = out.split(token).join(value);
  }
  return out;
}

// ---------- rotation state (data/reply-rotation.json) ----------
// Same read-modify-write pattern as store.js/leadStore.js. Separate small file rather
// than adding fields onto leads.json — rotation history is per (contact, intent,
// language), not part of the lead record itself, and this way it survives even for
// senders who never become a tracked lead (e.g. a quick off-topic exchange).
function ensureRotationFile() {
  if (!fs.existsSync(ROTATION_PATH)) fs.writeFileSync(ROTATION_PATH, JSON.stringify({}, null, 2));
}
function readRotation() {
  ensureRotationFile();
  try { return JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf-8')); } catch { return {}; }
}
function writeRotation(db) {
  ensureRotationFile();
  fs.writeFileSync(ROTATION_PATH, JSON.stringify(db, null, 2));
}

// ---------- text normalization ----------
// Common misspellings/transliteration variants -> one canonical token, applied to the
// whole string before keyword matching so e.g. "coarse ki fes kitni hai" still matches
// the "course"+"fee" keywords used in data/replies.json.
const MISSPELLING_FIXES = [
  [/\b(coarse|coures|cource|corse|cours)\b/g, 'course'],
  [/\b(hipnosis|hipnotism|hypnotism|hypnotis[ms]|hipno|hypno)\b/g, 'hypnosis'],
  [/\b(fes|fee['s]?s|feee+|fies|fess)\b/g, 'fee'],
  [/\b(telikinesis|telekenesis|telekensis|telikinesys)\b/g, 'telekinesis'],
  [/\bmind[- ]?reading\b/g, 'mindreading'],
  [/\b(vashikaran|vashikran|vashikarn|vashikarann)\b/g, 'vashikaran'],
  [/\b(shedule|schdule|scedule|shedual)\b/g, 'schedule'],
  [/\b(syllabous|silabus|sylabus|sylabas)\b/g, 'syllabus'],
  [/\b(certifcate|certifikate|certificat|certifikat)\b/g, 'certificate'],
  [/\b(pemant|payement|paymnt|payemnt)\b/g, 'payment'],
  [/\b(durtion|duraton|duartion)\b/g, 'duration'],
  [/\b(insta+lment|instalement)\b/g, 'installment'],
];

export function normalizeText(raw) {
  let t = (raw || '').toLowerCase().trim();
  t = t.replace(/[.,!?;:()"'`~*_[\]{}<>\\|/]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  for (const [re, replacement] of MISSPELLING_FIXES) t = t.replace(re, replacement);
  return t;
}

// ---------- language detection ----------
// Binary on purpose — see data/replies.json's variants_hi, which is Roman-script
// Hinglish, not Devanagari. Devanagari input still routes to variants_hi (the closest
// natural match this library has); "mixed" defaults to Hinglish per spec.
const DEVANAGARI_RE = /[ऀ-ॿ]/;
const HINGLISH_MARKERS = /\b(hai|hain|kya|kitna|kitne|kitni|kaise|kab|kahan|mujhe|mujhko|aap|aapka|nahi|nhi|kar|karo|karna|karni|hoon|hu|mein|mai|ke|ki|ka|se|batao|bata|bataiye|chahiye|acha|accha|thik|theek|haan|nahin|bhai|didi|paisa|paise|sikha|sikhao|humko|hamko|kaun|kyu|kyun)\b/i;

export function detectLanguage(raw) {
  if (DEVANAGARI_RE.test(raw || '')) return 'hi';
  if (HINGLISH_MARKERS.test(raw || '')) return 'hi';
  return 'en';
}

// Three-way variant, used only by the first-contact welcome (see pickWelcomeVariant) —
// every other intent in this library is a binary hi/en choice (detectLanguage above), but
// the welcome ships a dedicated Roman-script Hinglish set as well, so it needs its own
// classifier rather than collapsing Hinglish into "hi". A short/ambiguous message (a bare
// "hi", emoji, empty text) can't be confidently called pure English, so it falls to the
// hinglish default per spec rather than guessing.
function looksPureEnglish(t) {
  if (!/^[\x00-\x7F]+$/.test(t)) return false; // non-ASCII (Devanagari already handled above)
  if (HINGLISH_MARKERS.test(t)) return false;
  const words = t.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2; // a single bare word ("hi", "ok") is too ambiguous to call English
}

export function detectWelcomeLanguage(raw) {
  const t = (raw || '').trim();
  if (DEVANAGARI_RE.test(t)) return 'hi';
  if (HINGLISH_MARKERS.test(t)) return 'hinglish';
  if (looksPureEnglish(t)) return 'en';
  return 'hinglish'; // cannot tell -> default, per spec
}

// ---------- emoji-only detection ----------
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}‍️\s]+$/u;
export function isEmojiOnly(raw) {
  const t = (raw || '').trim();
  return t.length > 0 && EMOJI_ONLY_RE.test(t);
}

// ---------- matching ----------
function countKeywordHits(normText, keywords = []) {
  let hits = 0;
  for (const kw of keywords) {
    const k = (kw || '').toLowerCase().trim();
    if (!k) continue;
    if (k.includes(' ')) {
      if (normText.includes(k)) hits++;
    } else {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`).test(normText)) hits++;
    }
  }
  return hits;
}

function countPatternHits(normText, patterns = []) {
  let hits = 0;
  for (const p of patterns) {
    try { if (new RegExp(p, 'i').test(normText)) hits++; }
    catch (e) { console.error('replyEngine: bad pattern in data/replies.json:', p, e.message); }
  }
  return hits;
}

// "COURSE" / "BOOKING" are the exact call-to-action words the first-contact welcome tells
// every lead to reply with (see the "welcome" block's CTA lines). Routing them here, ahead
// of the generic priority race below, means they always land on course_inquiry /
// show_booking_general regardless of that intent's own (often deliberately low, since it's
// a broad catch-all) priority — bumping course_inquiry's priority instead would risk it
// outranking more specific intents like course_fee for any message that merely mentions
// "course". A bare "COURSE"/"BOOKING" reply is the one case that needs to win outright.
const HIGH_PRIORITY_TRIGGERS = [
  { re: /^course$/, intent: 'course_inquiry' },
  { re: /^booking$/, intent: 'show_booking_general' }
];

// messageText: the raw inbound WhatsApp text. conversationState: { hasGreetedBefore } —
// leadResponder.js passes this from lead history; only used to promote a bare greeting
// into greeting_repeat when this isn't the lead's first hello. Returns
// { intent, confidence, language } or null (caller must fall back to Gemini on null).
export function detectIntent(messageText, conversationState = {}) {
  const raw = messageText || '';
  const language = detectLanguage(raw);
  const intents = loadReplies();
  if (!Object.keys(intents).length) return null;

  if (isEmojiOnly(raw) && intents.greeting_only_emoji) {
    return { intent: 'greeting_only_emoji', confidence: 0.95, language };
  }

  const norm = normalizeText(raw);
  if (!norm) return null;

  for (const { re, intent } of HIGH_PRIORITY_TRIGGERS) {
    if (re.test(norm) && intents[intent]) return { intent, confidence: 0.95, language };
  }

  let best = null;
  for (const [key, def] of Object.entries(intents)) {
    if (key === 'greeting_only_emoji') continue; // handled above, never via keyword match
    const kwHits = countKeywordHits(norm, def.match?.keywords);
    const patHits = countPatternHits(norm, def.match?.patterns);
    const totalHits = kwHits + patHits;
    if (totalHits === 0) continue;

    const confidence = Math.min(0.95, 0.55 + 0.12 * totalHits);
    const priority = def.priority || 5;

    if (!best || priority > best.priority || (priority === best.priority && confidence > best.confidence)) {
      best = { intent: key, confidence, priority };
    }
  }

  if (!best) return null;

  // A bare greeting-family match, but the lead has already been greeted earlier in this
  // conversation — swap to greeting_repeat instead of greeting them like a stranger.
  if (conversationState.hasGreetedBefore && best.intent.startsWith('greeting_') &&
      best.intent !== 'greeting_repeat' && intents.greeting_repeat) {
    best = { ...best, intent: 'greeting_repeat' };
  }

  if (best.confidence < CONFIDENCE_THRESHOLD) return null;
  return { intent: best.intent, confidence: best.confidence, language };
}

// ---------- variant rotation ----------
// Rotates so the same contact never gets the same variant twice in a row, and avoids
// repeating anything from its last 5 sends of this exact (list, language) whenever
// there are enough variants to make that possible. Shared by pickVariant (per-intent
// replies) and pickWelcomeVariant (the first-contact welcome) — same algorithm, just a
// different source list and rotation-key namespace.
function pickFromRotation(list, rotationKey) {
  if (!list.length) return null;
  if (list.length === 1) return { text: fillTemplates(list[0]), index: 0 };

  const db = readRotation();
  const history = db[rotationKey] || [];

  const avoidRecent = new Set(history.slice(-5));
  let candidates = list.map((_, i) => i).filter(i => !avoidRecent.has(i));
  if (!candidates.length) candidates = list.map((_, i) => i).filter(i => i !== history[history.length - 1]);
  if (!candidates.length) candidates = list.map((_, i) => i);

  const index = candidates[Math.floor(Math.random() * candidates.length)];

  db[rotationKey] = [...history, index].slice(-10);
  writeRotation(db);

  return { text: fillTemplates(list[index]), index };
}

export function pickVariant(intent, language, contactJid) {
  const intents = loadReplies();
  const def = intents[intent];
  if (!def) return null;
  const list = def[`variants_${language}`] || def.variants_en || [];
  const rotationKey = `${contactJid || 'unknown'}::${intent}::${language}`;
  return pickFromRotation(list, rotationKey);
}

// First-contact welcome — same rotation guarantee (no repeat variant across a contact's
// last 5 sends of this language), scoped to its own "welcome" rotation-key namespace so it
// never collides with a per-intent history for the same jid.
export function pickWelcomeVariant(language, contactJid) {
  const welcome = loadWelcome();
  const list = welcome[`variants_${language}`] || welcome.variants_hinglish || welcome.variants_en || [];
  const rotationKey = `${contactJid || 'unknown'}::welcome::${language}`;
  return pickFromRotation(list, rotationKey);
}

// ---------- audit log (append-only JSONL, same convention as leadStore.js's lead-log) ----------
export function logMatch({ jid, message, intent, confidence, language, variantIndex }) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: Date.now(), jid, message, intent, confidence, language, variantIndex }) + '\n');
  } catch (e) { console.error('replyEngine: failed to write reply-engine log:', e.message); }
}

export function listIntentKeys() {
  return Object.keys(loadReplies());
}

// { escalate } for a given intent key — used by leadResponder.js to decide whether a
// locally-matched reply should also flag the lead / notify the operator (course_payment_done,
// show_* booking enquiries, student_* issues, etc.) via the same deliver() escalate path
// Gemini-generated replies already use, rather than a separate parallel mechanism.
export function getIntentMeta(intent) {
  const def = loadReplies()[intent];
  return { escalate: !!def?.escalate };
}
