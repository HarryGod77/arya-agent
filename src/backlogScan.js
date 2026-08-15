// Backlog Scan — finds old, unanswered 1:1 chats and reopens them, rate-limited and
// reviewable in the panel. runBacklogScan() finds candidates and queues them (once at
// startup, then daily via scheduler.js). trySendNextBacklogItem() is a separate, frequent
// low-cost tick (also wired from scheduler.js) that checks whether it's this queue's turn.
import * as WA from './whatsapp.js';
import * as LS from './leadStore.js';
import * as G from './gemini.js';
import * as leadResponder from './leadResponder.js';

const MAX_AGE_DAYS = Number(process.env.BACKLOG_MAX_AGE_DAYS) || 60;
const DAILY_CAP = 5;
const MIN_GAP_MS = 3 * 3600e3; // spread sends out across the day instead of bursting

// If every item from the initial review batch has been resolved (sent or removed),
// future scans no longer need per-chat approval. Also correct for the "nothing found"
// case — an empty first scan has nothing to review, so there's nothing to gate on.
function maybeClearFirstRun() {
  if (!LS.isBacklogFirstRunCleared() && !LS.getBacklogQueue().some(e => !e.approved)) {
    LS.clearBacklogFirstRun();
  }
}

// ---------- scan: find candidates, queue them ----------
export async function runBacklogScan() {
  if (!WA.isContactCacheReady()) {
    LS.logEvent({ jid: null, action: 'backlog_scan_skipped_cache_not_ready', detail: null });
    return { skipped: true, reason: 'contact_cache_not_ready', scanned: 0, queued: 0 };
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400e3;
  const firstRun = !LS.isBacklogFirstRunCleared();
  const alreadyQueued = new Set(LS.getBacklogQueue().map(e => e.jid));
  let scanned = 0, queued = 0;

  for (const entry of WA.getChatCacheEntries()) {
    if (entry.fromMe) continue;              // we (bot or human) already replied last
    if (entry.ts < cutoff) continue;          // too stale to reopen
    if (alreadyQueued.has(entry.jid)) continue;
    if (LS.getLead(entry.jid)) continue;      // already a tracked lead — handled elsewhere

    scanned++;
    if (WA.isSavedContact(entry.jid)) {
      LS.logEvent({ jid: entry.jid, action: 'backlog_filtered_saved_contact', detail: null });
      continue;
    }

    let intent;
    try {
      ({ intent } = await G.classifyIntent([{ dir: 'in', text: entry.text }]));
    } catch (e) {
      console.error('Backlog classify failed for', entry.jid, ':', e.message);
      continue;
    }
    LS.logEvent({ jid: entry.jid, action: 'backlog_classified', detail: { intent } });
    if (!['class_inquiry', 'greeting'].includes(intent)) continue;

    LS.addToBacklogQueue({
      jid: entry.jid, phone: entry.jid.split('@')[0], pushName: '',
      lastMessageSnippet: entry.text.slice(0, 200), lastMessageAt: entry.ts,
      discoveredAt: Date.now(), approved: !firstRun
    });
    LS.logEvent({ jid: entry.jid, action: 'backlog_queued', detail: { approved: !firstRun } });
    queued++;
  }

  console.log(`Backlog scan: ${scanned} candidate(s) checked, ${queued} queued${firstRun ? ' (first run — needs your approval in the Leads tab)' : ''}.`);
  maybeClearFirstRun();
  return { skipped: false, scanned, queued, firstRun };
}

// ---------- sender: rate-limited, spread out, silent-hours-aware ----------
export async function trySendNextBacklogItem() {
  const cfg = leadResponder.getConfig();
  if (leadResponder.inSilentHours(cfg)) return;
  if (LS.getBacklogSentToday() >= DAILY_CAP) return;
  const lastSend = LS.getBacklogLastSendAt();
  if (lastSend && Date.now() - lastSend < MIN_GAP_MS) return;
  if (!WA.isContactCacheReady()) return; // re-check — cache state can change between scan and send time

  const item = LS.getNextApprovedBacklogItem();
  if (!item) return;

  // Re-check saved-contact at send time too — the queue could be stale if the operator
  // saved this number as a contact sometime after it was originally queued.
  if (WA.isSavedContact(item.jid)) {
    LS.removeFromBacklogQueue(item.jid);
    LS.logEvent({ jid: item.jid, action: 'backlog_filtered_saved_contact', detail: 'caught at send time' });
    maybeClearFirstRun();
    return;
  }

  LS.createLead(item.jid, { phone: item.phone, pushName: item.pushName });
  LS.appendMessage(item.jid, { dir: 'in', text: item.lastMessageSnippet });

  // Same priority-based model routing as reactive replies — a backlog opener is
  // "class_inquiry" in intent (the scan already filtered to class_inquiry/greeting
  // candidates before queueing, same simplification the pre-tier code already made).
  let result;
  try {
    result = await leadResponder.generateTieredReply({
      jid: item.jid, phone: item.phone, text: item.lastMessageSnippet,
      leadState: 'new', intent: 'class_inquiry', paymentDetailsAllowed: false, offHours: false
    });
  } catch (e) {
    console.error('Backlog reply generation failed for', item.jid, ':', e.message);
    return; // leave queued, retry next tick
  }
  const { reply, escalate, escalateReason, quotaExhausted, tier, model } = result;
  if (quotaExhausted || !reply) {
    LS.logEvent({ jid: item.jid, action: 'backlog_send_skipped_quota', detail: { tier, model } });
    return; // leave queued, retry next tick
  }

  const delivered = await leadResponder.deliver({
    jid: item.jid, phone: item.phone, pushName: item.pushName,
    reply, mode: cfg.mode, escalate, escalateReason, tier, model
  });
  if (!delivered) return; // leave queued, retry next tick — don't burn today's slot on a failed send

  LS.removeFromBacklogQueue(item.jid);
  LS.setBacklogLastSendAt(Date.now());
  LS.incrementBacklogSentToday();
  LS.logEvent({ jid: item.jid, action: 'backlog_opened', detail: null });
  maybeClearFirstRun();
}

// Exported for server.js's "remove from queue" route — removing an item can also be
// what finally clears the first-run gate, not just sending one.
export { maybeClearFirstRun };
