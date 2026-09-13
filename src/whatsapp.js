// WhatsApp via Baileys (unofficial WhatsApp Web session on YOUR number).
import { createRequire } from 'module';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const silentLogger = pino({ level: 'silent' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'data', 'wa-auth');
const CONTACTS_PATH = path.join(__dirname, '..', 'data', 'wa-contacts.json');
const CHAT_CACHE_PATH = path.join(__dirname, '..', 'data', 'wa-chat-cache.json');

let sock = null;
let ready = false;
let myJid = null;
let starting = false;
let globalQrCode = null; // Browser ke liye QR code save karne ke liye

// jid -> { name, notify }. Populated from Baileys contact-sync events. `name` is only
// set if this jid is actually saved in the phone's address book; `notify` is just the
// sender's own self-set display name, visible for anyone regardless of saved status.
// Persisted to data/wa-contacts.json so a restart doesn't drop back to an empty cache
// and reopen the fail-closed window below on every deploy/crash/reconnect.
const contactCache = new Map();
let contactCacheSavedAt = null;

(function loadContactCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf-8'));
    for (const [jid, v] of Object.entries(raw || {})) contactCache.set(jid, v);
    if (contactCache.size) {
      contactCacheSavedAt = Date.now();
      console.log(`Loaded ${contactCache.size} cached WhatsApp contacts from disk.`);
    }
  } catch { /* no file yet on first run — starts empty, stays fail-closed until synced */ }
})();

function saveContactCacheToDisk() {
  try {
    fs.mkdirSync(path.dirname(CONTACTS_PATH), { recursive: true });
    fs.writeFileSync(CONTACTS_PATH, JSON.stringify(Object.fromEntries(contactCache), null, 2));
    contactCacheSavedAt = Date.now();
  } catch (e) { console.error('Failed to persist WhatsApp contact cache:', e.message); }
}

// Fail-closed gate. Until the cache has actually been populated (from disk or a live
// Baileys sync), we cannot reliably tell a saved contact from an unknown lead — so
// leadResponder.js must treat every inbound message as unclassifiable and stay silent
// rather than guess "not saved" and risk sending a real contact's chat to Gemini.
export function isContactCacheReady() {
  return contactCache.size > 0;
}

export function getContactCacheStats() {
  return { size: contactCache.size, ready: isContactCacheReady(), lastSavedAt: contactCacheSavedAt };
}

// jid -> { fromMe, text, ts } — last known message per 1:1 chat, for src/backlogScan.js.
// Populated from Baileys' one-time 'messaging-history.set' snapshot on connect, then
// kept current from the live 'messages.upsert' listener below (which now tracks BOTH
// directions, not just inbound) — so a human manually replying from their own phone, or
// the bot replying via sendWithTypingDelay, both correctly mark a chat as "answered"
// without backlogScan.js needing to know anything about how the reply happened.
const chatCache = new Map();
let chatCacheSavedAt = null;

(function loadChatCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_CACHE_PATH, 'utf-8'));
    for (const [jid, v] of Object.entries(raw || {})) chatCache.set(jid, v);
    if (chatCache.size) {
      chatCacheSavedAt = Date.now();
      console.log(`Loaded ${chatCache.size} cached chat entries from disk.`);
    }
  } catch { /* no file yet on first run */ }
})();

function saveChatCacheToDisk() {
  try {
    fs.mkdirSync(path.dirname(CHAT_CACHE_PATH), { recursive: true });
    fs.writeFileSync(CHAT_CACHE_PATH, JSON.stringify(Object.fromEntries(chatCache), null, 2));
    chatCacheSavedAt = Date.now();
  } catch (e) { console.error('Failed to persist WhatsApp chat cache:', e.message); }
}

const isTrackable1to1 = (jid) =>
  !!jid && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast') && !jid.endsWith('@newsletter') && jid !== 'status@broadcast';

function updateChatCache(jid, { fromMe, text, ts }) {
  if (!isTrackable1to1(jid)) return;
  const prev = chatCache.get(jid);
  if (prev && prev.ts >= ts) return; // never let an older/out-of-order event regress a newer known state
  chatCache.set(jid, { fromMe: !!fromMe, text, ts });
  saveChatCacheToDisk();
}

export function getChatCacheEntries() {
  return [...chatCache.entries()].map(([jid, v]) => ({ jid, ...v }));
}

// Has this jid sent us an actual message within the last windowMs? Used by
// leadResponder.js#deliver and every other proactive sender to decide whether a send
// carries WhatsApp's initiating-a-chat ban risk or is a safe reply — that risk is about
// INITIATING a chat, not replying to one, so this is the one signal that matters, not
// which code path triggered the send. Conservative on missing/stale data: no cache entry,
// or a cache entry whose LAST message was actually from us (fromMe:true) rather than them,
// both return false ("not recent inbound") — a missed call alone doesn't register here
// (the 'call' handler below doesn't touch the chat cache), so a reply to a missed call
// with no accompanying text counts as initiating, which is the conservative/correct call.
// A follow-up only fires after real silence and a backlog item is by construction an old
// unanswered chat, so both naturally land here as "not recent" without a special case.
// The chat cache is updated (see messages.upsert below) BEFORE the inbound handler runs,
// so a reactive reply/welcome sent from inside handleInboundMessage always sees its own
// just-arrived message and correctly counts as "recent".
export function hasRecentInboundMessage(jid, windowMs = 24 * 3600 * 1000) {
  const entry = chatCache.get(jid);
  if (!entry || entry.fromMe) return false;
  return (Date.now() - entry.ts) < windowMs;
}

// jid -> { ts, unreadCount } — every 1:1 chat WhatsApp's servers have told us about via
// 'chats.upsert' or the 'chats' array of 'messaging-history.set', REGARDLESS of whether
// we have actual message text for it in chatCache above. This is a diagnostic overlay,
// not a source of content: it exists so a gap between "WhatsApp says you have N chats,
// M unread" and "our chatCache only has usable text for K of them" is visible in the
// panel instead of silently invisible. backlogScan.js still only classifies jids that
// have real text in chatCache — a jid+unreadCount pair alone isn't enough to run through
// Gemini. Persisted to disk for the same restart-durability reason as the other caches.
const knownChats = new Map();
const KNOWN_CHATS_PATH = path.join(__dirname, '..', 'data', 'wa-known-chats.json');

(function loadKnownChatsFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(KNOWN_CHATS_PATH, 'utf-8'));
    for (const [jid, v] of Object.entries(raw || {})) knownChats.set(jid, v);
  } catch { /* no file yet on first run */ }
})();

function saveKnownChatsToDisk() {
  try {
    fs.mkdirSync(path.dirname(KNOWN_CHATS_PATH), { recursive: true });
    fs.writeFileSync(KNOWN_CHATS_PATH, JSON.stringify(Object.fromEntries(knownChats), null, 2));
  } catch (e) { console.error('Failed to persist known-chats diagnostic cache:', e.message); }
}

function noteKnownChats(chats) {
  let changed = false;
  for (const c of chats || []) {
    if (!isTrackable1to1(c?.id)) continue;
    const ts = Number(c.conversationTimestamp || c.lastMsgTimestamp || 0) * 1000 || Date.now();
    const prev = knownChats.get(c.id);
    if (prev && prev.ts >= ts && prev.unreadCount === (c.unreadCount || 0)) continue;
    knownChats.set(c.id, { ts, unreadCount: c.unreadCount || 0 });
    changed = true;
  }
  if (changed) saveKnownChatsToDisk();
}

// Surfaced in the Leads tab so the operator can see the actual gap this diagnoses:
// WhatsApp-reported chats/unread vs. how many of those we hold real text for and can
// therefore run through the backlog scanner at all.
export function getKnownChatsStats() {
  const unreadWithoutContent = [...knownChats.entries()]
    .filter(([jid, v]) => v.unreadCount > 0 && !chatCache.has(jid))
    .map(([jid, v]) => ({ jid, unreadCount: v.unreadCount, ts: v.ts }));
  return {
    knownChatsTotal: knownChats.size,
    chatsWithContent: chatCache.size,
    unreadWithoutContent
  };
}

// Explicit, redundant to the messages.upsert self-echo tracking below — called by
// leadResponder.js's deliver() right after a confirmed AUTO-mode send, so chat-cache
// correctness for backlog purposes doesn't depend on assuming Baileys always reflects
// our own outgoing messages back through messages.upsert.
export function markChatReplied(jid) {
  updateChatCache(jid, { fromMe: true, text: '(sent)', ts: Date.now() });
}

// Registered by server.js at boot (src/leadResponder.js#handleInboundMessage). Defaults
// to a no-op so this module never crashes if nothing has wired a handler yet.
let inboundHandler = async () => {};
export function setInboundMessageHandler(fn) { inboundHandler = fn; }

// Registered by server.js at boot (src/leadResponder.js#handleOutboundMessage) — fires
// for a genuine human-typed message sent from the operator's own phone into a lead's
// chat, e.g. via the learning-loop feature. Defaults to a no-op.
let outboundHandler = async () => {};
export function setOutboundMessageHandler(fn) { outboundHandler = fn; }

// Registered by server.js at boot (src/leadResponder.js#handleMissedCall) — fires when
// Baileys reports a call that rang and went unanswered. Defaults to a no-op.
let missedCallHandler = async () => {};
export function setMissedCallHandler(fn) { missedCallHandler = fn; }

// jid -> {text, ts} — the last text this server itself sent to that jid via
// sendWithTypingDelay (AUTO-mode lead-facing sends). Baileys reflects our own outgoing
// messages back through messages.upsert with fromMe:true, exactly like a message typed
// on the phone — this lets the listener below tell "the bot just sent this" apart from
// "the operator just typed this on their phone", which is the whole signal the learning
// loop needs. Entries expire after a couple minutes; the echo normally arrives within
// seconds of the real send.
const recentBotSends = new Map();
const BOT_ECHO_WINDOW_MS = 2 * 60 * 1000;
function markBotSent(jid, text) {
  recentBotSends.set(jid, { text, ts: Date.now() });
}

export async function startWhatsApp() {
  if (starting) return;              // prevent overlapping reconnect storms
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }

    sock = makeWASocket({
      version,
      auth: state,
      logger: silentLogger,
      browser: ['Arya Agent', 'Chrome', '120.0.0'],
      // Tried syncFullHistory:true here briefly — on the very next reconnect it
      // provoked a sustained Bad MAC / MessageCounterError decrypt storm against one
      // corrupted peer session, severe enough that WhatsApp terminated the connection
      // (428 Precondition Required) before Baileys auto-reconnected. Reverted: it only
      // ever mattered for a FRESH pairing (new QR scan) anyway — WhatsApp grants a
      // device its one-time full history sync at link time and won't repeat it on
      // ordinary reconnects regardless of this flag — so there was no upside to leaving
      // it on while not re-pairing, only the demonstrated downside. Revisit only
      // together with an actual QR re-pair, not as a standalone toggle.
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts || []) {
        if (!c?.id) continue;
        contactCache.set(c.id, { name: c.name || null, notify: c.notify || null });
      }
      saveContactCacheToDisk();
    });
    sock.ev.on('contacts.update', (updates) => {
      for (const c of updates || []) {
        if (!c?.id) continue;
        const prev = contactCache.get(c.id) || {};
        contactCache.set(c.id, { name: c.name ?? prev.name ?? null, notify: c.notify ?? prev.notify ?? null });
      }
      saveContactCacheToDisk();
    });

    // Chat metadata (jid + recency + unread count) WITHOUT message text — WhatsApp
    // sends this independently of whether it also sends full message bodies. Feeds the
    // knownChats diagnostic overlay only (see getKnownChatsStats), never chatCache
    // directly — there's no text here to classify.
    sock.ev.on('chats.upsert', (chats) => noteKnownChats(chats));

    // One-time snapshot of existing chats after connecting — the seed data for
    // backlogScan.js. Not gated on syncType/isLatest: we only need whatever last-message
    // data Baileys hands us, not a full history sync, and this event can fire more than
    // once as more arrives, which updateChatCache's out-of-order guard handles fine.
    // Logs its own shape every time it fires — the previous version of this listener
    // silently discarded the `chats` array (metadata for chats WhatsApp didn't also give
    // us message text for), which made a real sync look like "8 entries" instead of
    // showing the actual gap; this log line plus noteKnownChats(chats) below exist so
    // that gap is visible instead of silent next time.
    sock.ev.on('messaging-history.set', ({ chats, messages: msgs, isLatest, syncType, progress }) => {
      console.log(`messaging-history.set: ${chats?.length || 0} chat(s), ${msgs?.length || 0} message(s), syncType=${syncType}, isLatest=${isLatest}, progress=${progress}`);
      noteKnownChats(chats);
      for (const m of msgs || []) {
        const jid = m.key?.remoteJid;
        const text = extractText(m.message);
        if (!jid || !text) continue;
        const ts = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : 0;
        updateChatCache(jid, { fromMe: m.key?.fromMe, text, ts });
      }
    });

    // Live 1:1 messages. Chat-cache tracking happens for BOTH directions (so replies —
    // bot or human, from the phone — correctly clear a chat's backlog eligibility); the
    // lead-responder dispatch below stays inbound-only, same as before. Ignores groups,
    // status/broadcast/newsletter chats, and history-sync replay batches (type !==
    // 'notify') so a fresh login doesn't replay old messages through the responder.
    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      if (type !== 'notify') return;
      for (const m of msgs || []) {
        const jid = m.key?.remoteJid;
        const text = extractText(m.message);
        // A bare payment screenshot is usually sent with NO caption — extractText()
        // alone would see empty text and this loop used to drop the message entirely
        // before it ever reached leadResponder.js. hasImage lets an inbound image
        // through even with no text, so handleInboundMessage can still alert the
        // operator (see the "payment screenshot" branch there) without needing Gemini
        // to classify anything.
        const hasImage = !!m.message?.imageMessage;
        // Same reasoning as hasImage: a voice note or sticker carries no extractText()
        // output, so without these flags the message would look empty and get dropped
        // before ever reaching leadResponder.js's ot_voice_note_received/ot_sticker_only
        // local-reply handling.
        const hasAudio = !!m.message?.audioMessage;
        const hasSticker = !!m.message?.stickerMessage;
        const ts = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();
        if (text || hasImage || hasAudio || hasSticker) {
          updateChatCache(jid, { fromMe: m.key?.fromMe, text: text || (hasImage ? '[image]' : hasAudio ? '[voice note]' : '[sticker]'), ts });
        }

        if (m.key?.fromMe) {
          // Could be Baileys echoing our own sendWithTypingDelay() send back to us, or
          // a message the operator genuinely typed on their own phone. Only the latter
          // is "manual" for the learning loop's purposes.
          if (!text || !isTrackable1to1(jid)) continue;
          const pending = recentBotSends.get(jid);
          if (pending && pending.text === text && (ts - pending.ts) < BOT_ECHO_WINDOW_MS) {
            recentBotSends.delete(jid); // consumed — this echo is accounted for
            continue;
          }
          Promise.resolve(outboundHandler({ jid, text, ts })).catch(e => console.error('Outbound message handler failed:', e.message));
          continue;
        }
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
        if (!text && !hasImage && !hasAudio && !hasSticker) continue; // no usable content at all

        const payload = {
          jid,
          phone: jid.split('@')[0],
          pushName: m.pushName || '',
          text,
          hasImage,
          hasAudio,
          hasSticker,
          ts
        };
        Promise.resolve(inboundHandler(payload)).catch(e => console.error('Inbound message handler failed:', e.message));
      }
    });

    // A call that rang and went unanswered ('timeout') — reported once per call, not on
    // every status change ('offer'/'ringing' fire first but aren't "missed" yet). Feeds
    // leadResponder.js's ot_missed_call local reply through the same gate chain as a
    // real message (contact cache ready, saved-contact skip, manual override).
    const seenMissedCalls = new Set();
    sock.ev.on('call', (calls) => {
      for (const c of calls || []) {
        if (c.status !== 'timeout' || !c.from || !isTrackable1to1(c.from)) continue;
        if (seenMissedCalls.has(c.id)) continue;
        seenMissedCalls.add(c.id);
        Promise.resolve(missedCallHandler({ jid: c.from, phone: c.from.split('@')[0] }))
          .catch(e => console.error('Missed call handler failed:', e.message));
      }
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Naya QR aata hai toh variable me save + terminal me dikhayein
      if (qr) {
        globalQrCode = qr;
        try { qrcodeTerminal.generate(qr, { small: true }); } catch {}
        console.log('👉 Naya QR Code mil gaya hai! Browser me /qr kholkar scan karein.');
      }

      if (connection === 'close') {
        ready = false;
        globalQrCode = null;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
        starting = false;
        if (shouldReconnect) startWhatsApp();
      } else if (connection === 'open') {
        console.log('✅ WhatsApp Client ek dam taiyar (Ready) hai!');
        ready = true;
        globalQrCode = null;
        starting = false;
        myJid = sock.user.id;
      }
    });

  } catch (err) {
    console.error("Failed to start WhatsApp:", err);
    starting = false;
  }
}

function extractText(message) {
  if (!message) return '';
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || '';
}

// Heuristic, not certain — Baileys only knows a jid is "saved" if it received a contacts
// sync with a `name` (the name YOU gave them), as opposed to `notify` (their own self-set
// display name, present for anyone). Defaults to NOT saved for any jid missing from the
// cache — safe ONLY because callers must check isContactCacheReady() first and refuse to
// classify anyone at all while the cache is empty/unpopulated. Once ready, an unlisted
// jid really does mean "not in the cache", not "unknown, guess false".
export function isSavedContact(jid) {
  return !!contactCache.get(jid)?.name;
}

// For actual 1:1 sends to a lead's own jid (AUTO mode) — shows a typing indicator, waits
// a random human-like delay, then sends. Distinct from sendMessage() below, which targets
// the operator's own Note-to-Self/group chats for batch notifications and DRAFT-mode notes.
// Read live from process.env (not cached at import time), same convention as
// leadResponder.js's outboundEnabled/dailyInitiatedCap — a .env change + restart applies
// without a code edit. The composing/waiting/paused sequence below is the ENTIRE delay:
// the presence update is a single fire-and-forget call, not something that adds its own
// extra wait on top of waitMs — the typing indicator is shown for the duration of the
// delay, not in addition to it.
const replyDelayMinMs = () => Number(process.env.REPLY_DELAY_MIN_MS) || 20000;
const replyDelayMaxMs = () => Number(process.env.REPLY_DELAY_MAX_MS) || 40000;
export async function sendWithTypingDelay({ jid, text, minMs = replyDelayMinMs(), maxMs = replyDelayMaxMs() }) {
  if (!ready || !sock) throw new Error('WhatsApp client taiyar nahi hai. Pehle /qr par jaakar scan karein.');
  try { await sock.sendPresenceUpdate('composing', jid); } catch {}
  const waitMs = minMs + Math.random() * (maxMs - minMs);
  await new Promise(res => setTimeout(res, waitMs));
  try { await sock.sendPresenceUpdate('paused', jid); } catch {}
  await sock.sendMessage(jid, { text });
  markBotSent(jid, text);
}

// Sends a PDF (or other document) to a lead's own jid — used by src/invoicing.js to
// deliver the generated invoice. No typing delay: this is a deliberate, operator-
// triggered business document, not an auto-generated chat reply, so the ban-risk
// reasoning behind sendWithTypingDelay's human-like pacing doesn't apply here.
export async function sendDocument({ jid, buffer, fileName, caption, mimetype = 'application/pdf' }) {
  if (!ready || !sock) throw new Error('WhatsApp client taiyar nahi hai. Pehle /qr par jaakar scan karein.');
  await sock.sendMessage(jid, { document: buffer, mimetype, fileName, caption });
}

// Sends an image (e.g. a UPI QR code) with an optional caption — used by
// src/paymentSender.js so the payment-details block and its QR arrive as one message.
export async function sendImage({ jid, buffer, caption }) {
  if (!ready || !sock) throw new Error('WhatsApp client taiyar nahi hai. Pehle /qr par jaakar scan karein.');
  await sock.sendMessage(jid, { image: buffer, caption });
}

// Plain text to an arbitrary jid, no typing delay — like sendDocument/sendImage, this is
// for an operator-triggered explicit send (payment details with no UPI QR to attach,
// payment reminders), not an auto-generated chat reply, so the ban-risk pacing behind
// sendWithTypingDelay doesn't apply. Distinct from sendMessage() above, which always
// targets the operator's OWN self/group chat, never an arbitrary lead/student jid.
export async function sendText({ jid, text }) {
  if (!ready || !sock) throw new Error('WhatsApp client taiyar nahi hai. Pehle /qr par jaakar scan karein.');
  await sock.sendMessage(jid, { text });
}

// Plain 10-digit-or-longer phone -> WhatsApp jid, same construction used inline in
// sendToOperatorAlert above — centralized here so new callers (paymentSender.js,
// studentPayments.js) don't each re-derive the @s.whatsapp.net suffix.
export function phoneToJid(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

// Immediate send to the operator's SECOND number (OPERATOR_ALERT_NUMBER in .env) — for
// urgent internal alerts (hot leads, etc). Deliberately no typing delay: this isn't a
// lead-facing message, there's no ban-risk reason to hold it back, and the whole point
// is the operator sees it right away. Falls back to self (myJid) on any failure so the
// alert isn't lost, same fallback pattern as sendMessage() below.
// targetNumber: optional override of OPERATOR_ALERT_NUMBER — e.g. src/scheduler.js's
// social-posting stock-empty alert uses SOCIAL_OWNER_NUMBER when set, so a different
// person can own "content stock is low" alerts than "hot lead" alerts, while still
// reusing this same primitive (and its self-fallback behavior) rather than duplicating it.
export async function sendToOperatorAlert(text, targetNumber) {
  const number = (targetNumber || process.env.OPERATOR_ALERT_NUMBER || '').replace(/\D/g, '');
  if (!number) {
    console.error('OPERATOR_ALERT_NUMBER not set — cannot send alert.');
    return { sent: false, reason: 'OPERATOR_ALERT_NUMBER not set' };
  }
  if (!ready || !sock) {
    console.error('WhatsApp not ready — cannot send alert.');
    return { sent: false, reason: 'WhatsApp not ready' };
  }
  const jid = `${number}@s.whatsapp.net`;
  try {
    await sock.sendMessage(jid, { text });
    console.log('✅ Alert sent to operator second number');
    return { sent: true };
  } catch (e) {
    console.error('❌ Alert to second number failed:', e.message);
    try {
      await sock.sendMessage(myJid, { text: '⚠️ (Alert to second number failed, sent to you instead)\n\n' + text });
      console.log('↩️ Alert fell back to SELF');
      return { sent: true, fellBackToSelf: true };
    } catch (e2) {
      console.error('❌ Alert fallback to self also failed:', e2.message);
      return { sent: false, reason: e.message };
    }
  }
}

// sendMessage ab OBJECT leta hai: { text, groupJid, directToGroup }
// directToGroup true + groupJid ho -> group me jaata hai, warna aapke apne number (Note-to-Self) par.
export async function sendMessage({ text, groupJid, directToGroup = false }) {
  if (!ready || !sock) {
    throw new Error('WhatsApp client taiyar nahi hai. Pehle /qr par jaakar scan karein.');
  }
  const target = (directToGroup && groupJid) ? groupJid : myJid;
  const prefix = (target !== myJid) ? '📢 Announcement to group:\n\n' : '';
  try {
    await sock.sendMessage(target, { text: prefix + text });
    console.log(`✅ Message DELIVERED to ${target === myJid ? 'SELF' : 'GROUP'}: ${target}`);
    return { sent: true, target };
  } catch (e) {
    console.error(`❌ sendMessage FAILED to ${target}: ${e.message}`);
    if (target !== myJid) {
      try {
        await sock.sendMessage(myJid, { text: '⚠️ (Group send failed, sent to you instead)\n\n' + text });
        console.log('↩️ Fell back to SELF after group failure');
      } catch (e2) { console.error('❌ Fallback to self also failed:', e2.message); }
    }
    return { sent: false, reason: e.message, target };
  }
}

export async function listGroups() {
  if (!ready || !sock) return [];
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map(g => ({ jid: g.id, name: g.subject }));
}

export async function resolveGroupJid(input) {
  const s = (input || '').trim();
  if (!s) return '';
  if (s.includes('@g.us')) return s;
  const m = s.match(/chat\.whatsapp\.com\/([A-Za-z0-9]{20,24})/);
  if (m) {
    try {
      const code = m[1];
      return await sock.groupAcceptInvite(code);
    } catch (e) {
      console.error('❌ Failed to resolve group invite link:', e.message);
    }
  }
  return '';
}

// Helpers used by server.js
export const getQrCode = () => globalQrCode;
export const isReady = () => ready;
export const isWhatsAppReady = () => ready; // server.js isi naam se import karta hai
