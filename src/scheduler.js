// The brain: reminders + recordings + social posting + lead follow-ups.
import cron from 'node-cron';
import { read, update, alreadySent, markSent } from './store.js';
import * as G from './google.js';
import * as social from './social.js';
import { generateCaption } from './gemini.js';
import { sendMessage, sendToOperatorAlert } from './whatsapp.js';
import * as LS from './leadStore.js';
import * as leadResponder from './leadResponder.js';
import * as backlogScan from './backlogScan.js';

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
async function checkRecordings() {
  if (!googleReady() || !process.env.DRIVE_INBOX_FOLDER_ID) return;
  let files;
  try { files = await G.listInboxVideos(); } catch (e) { return console.error('Recording scan failed:', e.message); }
  if (!files.length) return;
  const db = read();
  for (const batch of db.batches) {
    for (const cls of batch.classes || []) {
      if (cls.recordingLink || cls.status === 'cancelled') continue;
      const start = new Date(cls.startISO).getTime();
      const end = start + (cls.durationMin || 60) * 60000;
      if (Date.now() < end) continue; // class not finished yet
      const name = className(cls.topic).toLowerCase();
      const bname = (batch.name || '').toLowerCase();
      const candidates = files.filter(f => {
        const created = new Date(f.createdTime).getTime();
        const timeOk = created >= start - 2 * 3600e3 && created <= start + 2 * 86400e3;
        return f.name.toLowerCase().includes(name) && timeOk;
      });
      const file = candidates.find(f => f.name.toLowerCase().includes(bname)) || candidates[0];
      if (!file) continue;
      try {
        // Ensure the batch folder exists + students have viewer access, then move the recording in.
        let folderId = batch.driveFolderId;
        if (!folderId) {
          folderId = await G.ensureBatchFolder(batch.name, null);
          update(d => { const b = d.batches.find(x => x.id === batch.id); if (b) b.driveFolderId = folderId; });
        }
        await G.ensureFolderAccess(folderId, batch.emails);
        const view = await G.moveIntoFolder(file.id, folderId);
        const msg = recordingMessage(className(cls.topic), view);
        await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
        if (batch.emails?.length) await G.sendEmail({ to: batch.emails, subject: `Recording: ${className(cls.topic)}`, text: msg }).catch(() => {});
        update(d => {
          const c = d.batches.find(b => b.id === batch.id)?.classes.find(x => x.id === cls.id);
          if (c) c.recordingLink = view;
        });
        console.log(`✅ Recording delivered (private) : ${batch.name} / ${cls.topic}`);
      } catch (e) { console.error('Recording delivery failed:', e.message); }
    }
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

// Checks every 15 min whether it's the queue's turn to send its next item — the actual
// pacing (5/day, 3h+ apart, silent-hours-aware) all lives inside trySendNextBacklogItem
// itself, this is just "is there anything to do right now".
async function trySendNextBacklogItem() {
  try { await backlogScan.trySendNextBacklogItem(); }
  catch (e) { console.error('Backlog send tick failed:', e.message); }
}

export function startScheduler() {
  cron.schedule('* * * * *', () => { checkClassReminders(); });   // every minute (10-min accuracy)
  cron.schedule('*/15 * * * *', () => { checkRecordings(); });
  cron.schedule('0 10 * * *', () => { runSocialPost(); });
  cron.schedule('0 * * * *', () => { checkLeadFollowUps(); });    // hourly
  cron.schedule('0 9 * * 1', () => { sendUnansweredQuestionsDigest(); }); // Monday 09:00
  cron.schedule('0 7 * * *', () => { runBacklogScan(); });        // daily 07:00, before silent hours end
  cron.schedule('*/15 * * * *', () => { trySendNextBacklogItem(); }); // every 15 min, pacing enforced internally
  console.log('⏰ Scheduler: reminders every 1m, recordings 15m, social daily 10:00, lead follow-ups hourly, unanswered-questions digest Mondays 09:00, backlog scan daily 07:00, backlog send-tick every 15m.');
}

export const jobs = {
  checkClassReminders, checkRecordings, runSocialPost, checkLeadFollowUps,
  sendUnansweredQuestionsDigest, runBacklogScan, trySendNextBacklogItem
};
