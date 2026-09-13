// The brain: reminders + recordings + social posting + lead follow-ups.
import cron from 'node-cron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { read, update, alreadySent, markSent } from './store.js';
import * as G from './google.js';
import * as social from './social.js';
import { generateCaption } from './gemini.js';
import { sendMessage, sendToOperatorAlert } from './whatsapp.js';
import * as LS from './leadStore.js';
import * as leadResponder from './leadResponder.js';
import * as backlogScan from './backlogScan.js';
import * as SS from './social/socialStore.js';
import * as FB from './social/facebookApi.js';
import { generateSocialCaption } from './social/captionGen.js';
import * as studentPayments from './studentPayments.js';

const googleReady = () => !!process.env.GOOGLE_REFRESH_TOKEN;
const minsUntil = (iso) => (new Date(iso) - Date.now()) / 60000;
const IST = 'Asia/Kolkata';

const className = (t) => String(t).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: IST });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: IST });

// Reminder windows: minutes-before-class -> human label
const WINDOWS = [
  { m: 1440, label: '24 hours' },
  { m: 180,  label: '3 hours' },
  { m: 60,   label: '1 hour' },
  { m: 10,   label: '10 minutes' },
  { m: 2,    label: '2 minutes' },
];

function reminderMessage(cls, label, minutes) {
  const name = className(cls.topic);
  if (minutes <= 10) {
    return `🚨 Only ${label} left — ${name}!

*English:* The class is about to begin. Please join now with your registered name and email. Tap the link and wait — the host will admit you.

*हिंदी:* क्लास बस शुरू होने वाली है। कृपया अभी अपने रजिस्टर्ड नाम और ईमेल के साथ जुड़ें। लिंक पर टैप करके प्रतीक्षा करें — होस्ट आपको admit करेगा।

🔗 Join: ${cls.meetLink}

किसी भी तरह की परेशानी हो तो मुझे व्यक्तिगत रूप से मैसेज या कॉल करें।
If you face any trouble, please DM or call me directly.

Regards,
Harry Rajput`;
  }
  return `⏰ Reminder — ${name}

Your class starts in about ${label}.
📅 ${fmtDate(cls.startISO)} · 🕐 ${fmtTime(cls.startISO)} IST
🔗 Join: ${cls.meetLink}

*English:* Please join on time with your registered name.
*हिंदी:* कृपया समय पर अपने रजिस्टर्ड नाम के साथ जुड़ें।`;
}

function recordingMessage(name, link) {
  return `🎥 Recording Available — ${name}

*English:* Here is the recording of the class. Open it while signed in with your registered email.
*हिंदी:* क्लास की रिकॉर्डिंग यहाँ है। अपने रजिस्टर्ड ईमेल से साइन-इन करके खोलें।

🔗 ${link}

Regards,
Harry Rajput`;
}

// ===== 1) CLASS REMINDERS (multi-window) =====
async function checkClassReminders() {
  const db = read();
  for (const batch of db.batches) {
    for (const cls of batch.classes || []) {
      const left = minsUntil(cls.startISO);
      if (left <= 0) continue;
      const leadAtCreate = (new Date(cls.startISO) - (cls.createdAt || 0)) / 60000;
      for (const w of WINDOWS) {
        if (w.m > leadAtCreate) continue;          // skip windows already passed when class was added
        const key = `rem:${cls.id}:${w.m}`;
        if (left <= w.m && !alreadySent(key)) {
          const msg = reminderMessage(cls, w.label, w.m);
          try {
            await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
            if (googleReady() && batch.emails?.length) {
              await G.sendEmail({ to: batch.emails, subject: `Reminder: ${className(cls.topic)} class`, text: msg }).catch(() => {});
            }
            markSent(key);
            console.log(`✅ Reminder (${w.label}) sent: ${batch.name} / ${cls.topic}`);
          } catch (e) { console.error('Reminder failed:', e.message); }
        }
      }
    }
  }
}

// ===== 2) RECORDING DELIVERY (matches real Google Meet file names to finished classes) =====
// Meet drops recordings into its own account-level "Meet Recordings" folder, which we don't
// control and can't filter by parent — so this scans Drive-wide by time window instead, then
// fuzzy-matches the class topic against Meet's auto-generated file name
// ("<Meeting title> - YYYY/MM/DD HH:MM IST - Recording").
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'class', 'session', 'part', 'day', 'batch', 'recording']);

function normalizeWords(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

const RECORDING_WINDOW_BEFORE_MS = 1 * 3600e3;  // class may start recording up to 1h "early" (clock drift, host started late slot)
const RECORDING_WINDOW_AFTER_MS = 8 * 3600e3;   // Drive/Meet can take a while to finish processing

// Shared by checkRecordings below and server.js's manual "send recording" endpoint, so
// both paths pick the same file the same way instead of drifting out of sync.
export function matchRecordingForClass(cls, files) {
  const start = new Date(cls.startISO).getTime();
  const windowStart = start - RECORDING_WINDOW_BEFORE_MS;
  const windowEnd = start + RECORDING_WINDOW_AFTER_MS;
  const inWindow = files.filter(f => {
    const created = new Date(f.createdTime).getTime();
    return created >= windowStart && created <= windowEnd;
  });
  if (!inWindow.length) return { chosen: null, scored: [], reason: 'no candidates in time window' };

  const topicWords = normalizeWords(cls.topic);
  const scored = inWindow.map(f => {
    const fileWords = new Set(normalizeWords(f.name));
    const overlapWords = topicWords.filter(w => fileWords.has(w));
    return {
      file: f,
      overlapCount: overlapWords.length,
      overlapWords,
      score: topicWords.length ? overlapWords.length / topicWords.length : 0,
    };
  }).sort((a, b) => b.score - a.score || b.overlapCount - a.overlapCount);

  if (scored[0]?.overlapCount >= 1) return { chosen: scored[0].file, scored, reason: 'topic word overlap' };
  if (scored.length === 1) return { chosen: scored[0].file, scored, reason: 'only candidate in window' };
  return { chosen: null, scored, reason: 'no topic word overlap and multiple candidates' };
}

async function checkRecordings() {
  if (!googleReady()) return;
  const db = read();
  const pending = [];
  for (const batch of db.batches) {
    for (const cls of batch.classes || []) {
      if (cls.recordingLink || cls.status === 'cancelled') continue;
      const start = new Date(cls.startISO).getTime();
      const end = start + (cls.durationMin || 60) * 60000;
      if (Date.now() < end) continue; // class not finished yet
      pending.push({ batch, cls, start });
    }
  }
  if (!pending.length) return;

  // One Drive query covers every pending class: fetch from the earliest possible window
  // start, then narrow per-class below. Cheaper than one API call per class.
  const earliestStart = Math.min(...pending.map(p => p.start));
  const sinceISO = new Date(earliestStart - RECORDING_WINDOW_BEFORE_MS).toISOString();

  let files;
  try { files = await G.listVideosSince(sinceISO); } catch (e) { return console.error('Recording scan failed:', e.message); }
  files = files.filter(f => f.mimeType?.startsWith('video/') && !/notes by gemini/i.test(f.name));
  if (!files.length) return console.log('Recording scan: no candidate videos found since', sinceISO);

  for (const { batch, cls } of pending) {
    const { chosen, scored, reason } = matchRecordingForClass(cls, files);

    if (scored.length) {
      console.log(
        `Recording scan candidates for ${batch.name} / ${cls.topic}:`,
        scored.map(s => `"${s.file.name}" (score=${s.score.toFixed(2)}, overlap=[${s.overlapWords.join(',')}])`).join(' | ')
      );
    }

    if (!chosen) {
      console.log(`Recording scan: no confident match for ${batch.name} / ${cls.topic} (${reason})${scored.length ? ' — rejected: ' + scored.map(s => `"${s.file.name}"`).join(', ') : ''}`);
      continue;
    }
    console.log(`Recording scan: matched "${chosen.name}" to ${batch.name} / ${cls.topic} (${reason})`);

    try {
      // Ensure the batch folder exists + students have viewer access, then move the recording in.
      let folderId = batch.driveFolderId;
      if (!folderId) {
        folderId = await G.ensureBatchFolder(batch.name, null);
        update(d => { const b = d.batches.find(x => x.id === batch.id); if (b) b.driveFolderId = folderId; });
      }
      await G.ensureFolderAccess(folderId, batch.emails);
      const view = await G.moveIntoFolder(chosen.id, folderId);
      const msg = recordingMessage(className(cls.topic), view);
      await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
      if (batch.emails?.length) await G.sendEmail({ to: batch.emails, subject: `Recording: ${className(cls.topic)}`, text: msg }).catch(() => {});
      update(d => {
        const c = d.batches.find(b => b.id === batch.id)?.classes.find(x => x.id === cls.id);
        if (c) c.recordingLink = view;
      });
      console.log(`✅ Recording delivered (private) : ${batch.name} / ${cls.topic}`);
      // Take it out of the shared pool so a later class this tick can't also claim it.
      files = files.filter(f => f.id !== chosen.id);
    } catch (e) { console.error('Recording delivery failed:', e.message); }
  }
}

// ===== 3) SOCIAL POSTING (needs Google + Meta) =====
async function runSocialPost() {
  if (!googleReady()) return;
  const db = read();
  const cfg = db.config;
  let queue;
  try { queue = await G.listPostQueue(); } catch (e) { return console.error('Queue read failed:', e.message); }
  if (!queue.length) return console.log('Social: post queue empty.');
  const n = Math.min(cfg.postsPerDay || 1, queue.length);
  for (let i = 0; i < n; i++) {
    const file = queue[i];
    try {
      const publicUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
      if (cfg.social.facebook.enabled) {
        const cap = await generateCaption({ platform: 'facebook', filename: file.name });
        const text = `${cap.caption}\n\n${cap.hashtags.join(' ')}`;
        if (cfg.social.facebook.format === 'reel') await social.postFacebookReel({ fileUrl: publicUrl, caption: text });
        else await social.postFacebookVideo({ fileUrl: publicUrl, caption: text });
        console.log('✅ FB posted:', file.name);
      }
      if (cfg.social.instagram.enabled) {
        const cap = await generateCaption({ platform: 'instagram', filename: file.name });
        await social.postInstagramReel({ fileUrl: publicUrl, caption: `${cap.caption}\n\n${cap.hashtags.join(' ')}` });
        console.log('✅ IG posted:', file.name);
      }
      if (cfg.social.youtube.enabled) {
        const cap = await generateCaption({ platform: 'youtube', filename: file.name });
        const stream = await G.downloadStream(file.id);
        await G.uploadYouTube({ title: cap.caption.slice(0, 90), description: `${cap.description}\n\n${cap.hashtags.join(' ')}`, tags: cap.hashtags.map(h => h.replace('#', '')), stream, asShort: cfg.social.youtube.format === 'short' });
        console.log('✅ YT posted:', file.name);
      }
      if (process.env.DRIVE_POSTED_FOLDER_ID) await G.moveFile(file.id, process.env.DRIVE_POSTED_FOLDER_ID);
    } catch (e) { console.error('Social post failed for', file.name, ':', e.message); }
  }
}

// ===== 3b) FACEBOOK REELS AUTO-POSTING (Meta Reels Publishing API, 3-phase upload) =====
// A separate, newer pipeline from runSocialPost() above (which is Instagram/YouTube-
// oriented and has the "Known gap" documented in CLAUDE.md — G.listPostQueue/downloadStream/
// uploadYouTube don't exist). This one is Facebook-only, queue/schedule-driven via
// src/social/socialStore.js, and uploads raw video bytes to Meta instead of relying on a
// public Drive URL. Entirely gated behind SOCIAL_ENABLED so local dev never posts to the
// live page even if real FB/Google credentials happen to be present in .env.
const socialEnabled = () => process.env.SOCIAL_ENABLED === 'true';
const SOCIAL_RATE_LIMIT_PER_24H = 10; // hard ceiling regardless of schedule.postsPerDay config

// IST has no DST, fixed UTC+5:30 — same offset-arithmetic convention as leadResponder.js's
// silentHours / paymentStore.js's istYear, not Intl or the host TZ.
function istSlotToISOToday(hour, minute) {
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 3600e3);
  const istMidnightUTC = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), hour, minute);
  return new Date(istMidnightUTC - 5.5 * 3600e3).toISOString();
}

function publishedInLast24h() {
  const since = Date.now() - 24 * 3600e3;
  return SS.getQueue().filter(q => q.status === 'published' && q.publishedAt && q.publishedAt >= since).length;
}

// Shared by the 5-min cron tick and server.js's "publish now" route so both paths run the
// exact same download -> upload -> publish -> cleanup sequence. Always one video at a
// time (never called concurrently by the tick loop below) — the server is RAM-constrained
// and downloads the whole file to a temp path first.
export async function publishQueueItem(item) {
  if (!process.env.FB_PAGE_ID || !process.env.FB_PAGE_ACCESS_TOKEN) {
    SS.updateQueueItem(item.id, { status: 'failed', error: 'FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN not configured' });
    return SS.getQueueItem(item.id);
  }
  if (publishedInLast24h() >= SOCIAL_RATE_LIMIT_PER_24H) {
    console.log(`Social: rate limit hit (${SOCIAL_RATE_LIMIT_PER_24H}/24h) — leaving "${item.fileName}" queued.`);
    return SS.getQueueItem(item.id);
  }

  SS.updateQueueItem(item.id, { status: 'uploading', error: null });
  const tmpPath = path.join(os.tmpdir(), `social-${item.id}${path.extname(item.fileName || '') || '.mp4'}`);
  try {
    await G.downloadDriveFile(item.driveFileId, tmpPath);
    const { video_id, upload_url } = await FB.startUploadSession(process.env.FB_PAGE_ID, process.env.FB_PAGE_ACCESS_TOKEN);
    await FB.uploadVideoFile(upload_url, tmpPath, process.env.FB_PAGE_ACCESS_TOKEN);
    const description = [item.caption, (item.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
    // Always PUBLISHED, never SCHEDULED — see facebookApi.js's comment on publishReel.
    // Meta only ever sees an instant publish; the schedule that got us here is entirely
    // ours (item.scheduledFor), tracked below as how close we landed to it.
    await FB.publishReel(process.env.FB_PAGE_ID, video_id, description, process.env.FB_PAGE_ACCESS_TOKEN);
    SS.markUploaded(item.driveFileId);
    const publishedAt = Date.now();
    const publishDelaySeconds = item.scheduledFor ? Math.round((publishedAt - new Date(item.scheduledFor).getTime()) / 1000) : null;
    SS.updateQueueItem(item.id, { status: 'published', fbVideoId: video_id, publishedAt, publishDelaySeconds, error: null });
    console.log(`✅ Social: published "${item.fileName}" as reel ${video_id} (${publishDelaySeconds != null ? publishDelaySeconds + 's after scheduled time' : 'no schedule set'})`);
  } catch (e) {
    SS.updateQueueItem(item.id, { status: 'failed', error: e.message });
    console.error(`Social: publish failed for "${item.fileName}":`, e.message);
  } finally {
    // Always clean up the temp download, success or failure — disk is as constrained as RAM here.
    fs.unlink(tmpPath, () => {});
  }
  return SS.getQueueItem(item.id);
}

// Every minute: anything queued whose scheduled time has passed gets published right
// now (download -> upload -> publish, all happening at this moment — see
// publishQueueItem's video_state=PUBLISHED comment). A 1-minute tick keeps the actual
// publish close to the intended scheduledFor instead of the up-to-5-minute slip a
// coarser tick would allow. Processed sequentially (never Promise.all) — one video at a
// time, per the RAM/disk constraint noted above, even if several ticks' worth of items
// are overdue at once.
async function checkSocialQueue() {
  if (!socialEnabled()) return;
  const due = SS.getQueue().filter(q => q.status === 'queued' && q.scheduledFor && new Date(q.scheduledFor).getTime() <= Date.now());
  for (const item of due) {
    await publishQueueItem(item);
  }
}

// Daily at 08:00: top up the queue for today from schedule.slots, oldest unposted Drive
// videos first. If Drive has nothing left to queue, alerts the owner instead of silently
// doing nothing — an empty queue with no alert would just look like the feature stopped
// working.
async function refillSocialQueue() {
  if (!socialEnabled()) return;
  if (!process.env.GOOGLE_REFRESH_TOKEN) return console.log('Social refill skipped: Google not configured.');
  const folderId = process.env.DRIVE_SOCIAL_FOLDER_ID;
  if (!folderId) return console.log('Social refill skipped: DRIVE_SOCIAL_FOLDER_ID not set.');

  const schedule = SS.getSchedule();
  if (!schedule.enabled) return console.log('Social refill skipped: schedule disabled.');

  let files;
  try { files = await G.listSocialVideos(folderId); }
  catch (e) { return console.error('Social refill: Drive listing failed:', e.message); }

  const queue = SS.getQueue();
  const alreadyQueued = new Set(queue.filter(q => q.status !== 'failed').map(q => q.driveFileId));
  const unposted = files.filter(f => !SS.isAlreadyUploaded(f.id) && !alreadyQueued.has(f.id));

  if (!unposted.length) {
    console.log('Social refill: no unposted videos left in the Drive folder.');
    try {
      await sendToOperatorAlert(
        '📭 Social posting: the Drive social-post folder has no unposted videos left. Add more reels to keep the queue filled.',
        process.env.SOCIAL_OWNER_NUMBER
      );
    } catch (e) { console.error('Social stock-empty alert failed:', e.message); }
    return;
  }

  const slots = (schedule.slots && schedule.slots.length) ? schedule.slots : ['09:00'];
  const perDay = Math.max(1, Math.min(schedule.postsPerDay || slots.length, slots.length));
  const picks = unposted.slice(0, perDay);

  for (let i = 0; i < picks.length; i++) {
    const file = picks[i];
    const [h, m] = slots[i].split(':').map(Number);
    const scheduledFor = istSlotToISOToday(h, m);
    let cap;
    try { cap = await generateSocialCaption(file.name); }
    catch (e) { cap = { title: file.name, caption: '', hashtags: [] }; console.error('Social refill: caption generation failed for', file.name, ':', e.message); }
    SS.addToQueue({ driveFileId: file.id, fileName: file.name, caption: cap.caption, title: cap.title, hashtags: cap.hashtags, scheduledFor });
    console.log(`Social refill: queued "${file.name}" for ${scheduledFor}`);
  }
}

// Every 6 hours: refresh views/reach/likes/comments for reels published in the last 7
// days. Best-effort per item — one failed fetch (e.g. a metric Meta renamed) shouldn't
// block refreshing the rest.
async function refreshSocialInsights() {
  if (!socialEnabled()) return;
  if (!process.env.FB_PAGE_ACCESS_TOKEN) return;
  const since = Date.now() - 7 * 86400e3;
  const published = SS.getQueue().filter(q => q.status === 'published' && q.fbVideoId && q.publishedAt >= since);
  for (const item of published) {
    try {
      const insights = await FB.getReelInsights(item.fbVideoId, process.env.FB_PAGE_ACCESS_TOKEN);
      SS.saveInsights(item.fbVideoId, insights);
    } catch (e) { console.error(`Social insights fetch failed for ${item.fbVideoId}:`, e.message); }
  }
}

// ===== 4) LEAD FOLLOW-UPS (24h / 3d / 7d, max 3 ever) =====
// Windows are cumulative from the last REAL reply (lastOutboundAt), not chained from
// the previous follow-up — appendMessage(isFollowUp: true) never touches that field,
// so this anchor stays put through the whole sequence. See src/leadResponder.js.
const FOLLOWUP_WINDOWS_MS = [24 * 3600e3, 3 * 86400e3, 7 * 86400e3];

async function checkLeadFollowUps() {
  for (const lead of LS.getAllLeads()) {
    if (!['informed', 'interested', 'silent'].includes(lead.state)) continue;
    if (lead.manualOverride) continue;
    if (lead.followUps.count >= 3) continue;
    if (!lead.lastOutboundAt) continue; // no real reply sent yet — nothing to follow up on
    // Outbound safety (Part 4): only follow up on a contact who has actually replied at
    // least once beyond the message that triggered the bot's first reply — a backlog
    // opener or first-touch lead who never engaged again shouldn't get chased.
    const inboundCount = (lead.messages || []).filter(m => m.dir === 'in').length;
    if (inboundCount < 2) continue;
    const windowIdx = lead.followUps.count; // 0 -> 24h due, 1 -> 3d due, 2 -> 7d due
    if (Date.now() - lead.lastOutboundAt < FOLLOWUP_WINDOWS_MS[windowIdx]) continue;
    try { await leadResponder.sendFollowUp(lead.jid, windowIdx + 1); }
    catch (e) { console.error('Follow-up failed for', lead.jid, ':', e.message); }
  }
}

// ===== 5) WEEKLY UNANSWERED-QUESTIONS DIGEST =====
const DIGEST_MAX_LINES = 30; // cap so one wild week doesn't produce an unreadable wall of text

async function sendUnansweredQuestionsDigest() {
  const since = Date.now() - 7 * 86400e3;
  const entries = LS.getLogSince(since, 'unanswered_question');
  if (!entries.length) return; // nothing collected this week — stay quiet, don't send an empty digest

  const shown = entries.slice(0, DIGEST_MAX_LINES);
  const lines = shown.map(e => {
    const lead = LS.getLead(e.jid);
    const who = lead ? (lead.pushName ? `${lead.phone} (${lead.pushName})` : lead.phone) : e.jid.split('@')[0];
    const q = e.detail?.question || '?';
    return `• ${who}: "${q}"${e.detail?.reason ? `\n  (${e.detail.reason})` : ''}`;
  });
  const overflow = entries.length > DIGEST_MAX_LINES ? `\n\n+${entries.length - DIGEST_MAX_LINES} more — check data/lead-log.jsonl` : '';

  const digest = `📋 Unanswered questions this week (${entries.length})\n\n${lines.join('\n\n')}${overflow}\n\nAdd answers to data/course-knowledge.md when you get a chance.`;
  try { await sendToOperatorAlert(digest); }
  catch (e) { console.error('Unanswered-questions digest send failed:', e.message); }
}

// ===== 6) BACKLOG SCAN =====
// Daily discovery run. The actual sends are a separate, frequent tick below — this one
// only finds candidates and queues them, never sends anything itself.
async function runBacklogScan() {
  try { await backlogScan.runBacklogScan(); }
  catch (e) { console.error('Backlog scan failed:', e.message); }
}

// NOTE: there is deliberately no automatic backlog-send tick anymore (Part 4 outbound
// safety) — the account got restricted once for auto-sending into old, unanswered chats.
// Discovery still runs daily below; every actual send now requires an operator clicking
// "Send" in the Leads tab, which calls src/backlogScan.js#sendBacklogItem directly via
// server.js's POST /api/backlog/:jid/send.

// ===== 7) PAYMENT REMINDER SCAN =====
// Daily discovery run, same split as the backlog scan above: this only queues candidates
// (3-days-before / due-today / 2-days-after, then an operator escalation alert if still
// unpaid) — nothing here ever messages a student. See src/studentPayments.js#scanForReminders
// and server.js's POST /api/payment-reminders/:id/send for the only actual send path.
function runPaymentReminderScan() {
  try {
    const { queued, escalated } = studentPayments.scanForReminders();
    if (queued || escalated) console.log(`Payment reminder scan: ${queued} queued, ${escalated} escalated to operator.`);
  } catch (e) { console.error('Payment reminder scan failed:', e.message); }
}

export function startScheduler() {
  cron.schedule('* * * * *', () => { checkClassReminders(); });   // every minute (10-min accuracy)
  cron.schedule('*/15 * * * *', () => { checkRecordings(); });
  cron.schedule('0 10 * * *', () => { runSocialPost(); });
  cron.schedule('0 * * * *', () => { checkLeadFollowUps(); });    // hourly
  cron.schedule('0 9 * * 1', () => { sendUnansweredQuestionsDigest(); }); // Monday 09:00
  cron.schedule('0 7 * * *', () => { runBacklogScan(); });        // daily 07:00, before silent hours end — discovery only, never sends
  cron.schedule('* * * * *', () => { checkSocialQueue(); });      // every minute — publish due Facebook reels (no-op unless SOCIAL_ENABLED)
  cron.schedule('0 8 * * *', () => { refillSocialQueue(); });     // daily 08:00 — refill today's reel queue
  cron.schedule('0 */6 * * *', () => { refreshSocialInsights(); }); // every 6h — refresh published-reel insights
  cron.schedule('15 8 * * *', () => { runPaymentReminderScan(); }); // daily 08:15 — queue payment reminders, discovery only, manual send
  console.log('⏰ Scheduler: reminders every 1m, recordings 15m, social daily 10:00, lead follow-ups hourly, unanswered-questions digest Mondays 09:00, backlog scan daily 07:00 (discovery only, manual send), FB reel queue every 1m, FB reel refill daily 08:00, FB reel insights every 6h, payment reminder scan daily 08:15 (discovery only, manual send).');
}

export const jobs = {
  checkClassReminders, checkRecordings, runSocialPost, checkLeadFollowUps,
  sendUnansweredQuestionsDigest, runBacklogScan,
  checkSocialQueue, refillSocialQueue, refreshSocialInsights,
  runPaymentReminderScan
};
