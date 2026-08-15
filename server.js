import 'dotenv/config';
import express from 'express';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCodeImage from 'qrcode';
import { read, update, id } from './src/store.js';
import {
  startWhatsApp, isWhatsAppReady, listGroups, sendMessage, resolveGroupJid, getQrCode,
  setInboundMessageHandler, setOutboundMessageHandler, getContactCacheStats, getKnownChatsStats
} from './src/whatsapp.js';
import * as G from './src/gemini.js';
import { startScheduler, jobs } from './src/scheduler.js';
import {
  createClassEvent, deleteClassEvent, sendEmail, listInboxVideos,
  ensureFolder, moveFile, ensureBatchFolder, ensureFolderAccess, moveIntoFolder
} from './src/google.js';
import * as leadResponder from './src/leadResponder.js';
import * as LS from './src/leadStore.js';
import * as backlogScan from './src/backlogScan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve The Oracle control panel (index.html, app.js, styles.css)

const googleReady = () => !!process.env.GOOGLE_REFRESH_TOKEN;
const IST = 'Asia/Kolkata';

// ---------- helpers ----------
function className(topic) {
  return String(topic).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: IST });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: IST });

function classAddedMessage(name, startISO, meetLink) {
  return `📢 New Class Scheduled — ${name}

📅 ${fmtDate(startISO)}
🕐 ${fmtTime(startISO)} IST
🔗 Join: ${meetLink}

*English:* Please join on time with your registered name and email. Tap the link and wait — the host will admit you.
*हिंदी:* कृपया समय पर अपने रजिस्टर्ड नाम और ईमेल के साथ जुड़ें। लिंक पर टैप करके प्रतीक्षा करें — होस्ट आपको admit करेगा।

Regards,
Harry Rajput`;
}

function classCancelledMessage(name, startISO, reason) {
  return `❌ Class Cancelled — ${name}
📅 ${fmtDate(startISO)} · 🕐 ${fmtTime(startISO)} IST
${reason ? `\n📝 Reason: ${reason}\n` : ''}
*English:* This class has been cancelled. Sorry for the inconvenience.
*हिंदी:* यह क्लास रद्द कर दी गई है। असुविधा के लिए क्षमा करें।

Regards,
Harry Rajput`;
}

function recordingMessage(name, link) {
  return `🎥 Recording Available — ${name}

*English:* Here is the recording of the class. Open it while signed in with your registered email.
*हिंदी:* क्लास की रिकॉर्डिंग यहाँ है। अपने रजिस्टर्ड ईमेल से साइन-इन करके खोलें।

🔗 ${link}

Regards,
Harry Rajput`;
}

// Drive organizer classification
function classify(fileName) {
  const n = (fileName || '').toLowerCase();
  let batch = 'Unsorted';
  const bm = n.match(/batch\s*\d+/);
  if (bm) batch = bm[0].replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  else if (n.includes('diwali')) batch = 'Diwali';
  else if (n.includes('rakhi')) batch = 'Rakhi';
  else if (n.includes('march')) batch = 'March';

  let topic = 'General';
  if (n.includes('hypnos')) topic = 'Hypnosis';
  else if (n.includes('mind')) topic = 'Mind Reading';
  else if (n.includes('act')) topic = 'Acts';
  else if (n.includes('practice')) topic = 'Practice';
  else if (n.includes('advanc')) topic = 'Advanced';
  else if (n.includes('classic')) topic = 'Classic';

  return { batch, topic, target: `${batch} / ${topic}` };
}

// ---------- QR endpoint (browser) ----------
app.get('/qr', async (req, res) => {
  const qrData = getQrCode();
  if (isWhatsAppReady()) return res.send('<h3 style="font-family:Arial;text-align:center;margin-top:50px">✅ WhatsApp connected aur ready hai!</h3>');
  if (!qrData) return res.send('<h3 style="font-family:Arial;text-align:center;margin-top:50px">⏳ QR Code ban raha hai... 5 second baad page Refresh (F5) karein.</h3>');
  try {
    const qrImageSrc = await QRCodeImage.toDataURL(qrData);
    res.send(`
      <div style="text-align:center;margin-top:50px;font-family:Arial,sans-serif">
        <h2>Arya Agent — WhatsApp se connect karne ke liye scan karein</h2>
        <div style="margin:20px auto;padding:10px;border:1px solid #ccc;display:inline-block;background:#fff">
          <img src="${qrImageSrc}" alt="WhatsApp QR Code" style="width:300px;height:300px"/>
        </div>
        <p><strong>Phone → WhatsApp → Linked Devices → Scan.</strong></p>
      </div>`);
  } catch (err) {
    console.error('QR image error:', err);
    res.status(500).send('QR Code image generate nahi ho payi.');
  }
});

// ---------- AUTH ----------
// Frontend (app.js) sends the passphrase in the "x-admin-pass" header.
const auth = (req, res, next) => {
  if (req.headers['x-admin-pass'] === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'unauthorized' });
};

// LOGIN (no auth middleware — this is where the password gets checked)
app.post('/api/login', (req, res) => {
  if (req.body?.password === process.env.ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong passphrase.' });
});

// ---------- WHATSAPP ----------
app.get('/api/whatsapp/status', auth, (req, res) => res.json({ ready: isWhatsAppReady() }));
app.get('/api/whatsapp/groups', auth, async (req, res) => {
  try { res.json(await listGroups()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- CONFIG ----------
app.get('/api/config', auth, (req, res) => res.json(read().config));
app.put('/api/config', auth, (req, res) => {
  update(d => { d.config = { ...d.config, ...req.body }; });
  res.json({ ok: true });
});

// ---------- BATCHES ----------
app.get('/api/batches', auth, (req, res) => res.json(read().batches));

app.post('/api/batches', auth, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'batch name required' });
    const emails = (req.body.emails || []).map(e => e.trim()).filter(Boolean);
    let groupJid = (req.body.whatsappGroupJid || '').trim();
    if (groupJid && !groupJid.includes('@g.us')) {
      try { groupJid = (await resolveGroupJid(groupJid)) || groupJid; } catch {}
    }
    const batch = { id: id(), name, emails, whatsappGroupJid: groupJid, classes: [] };

    if (googleReady()) {
      try {
        batch.driveFolderId = await ensureBatchFolder(name);
        await ensureFolderAccess(batch.driveFolderId, emails);
      } catch (e) { console.error('Drive folder setup failed:', e.message); }
    }

    update(d => { d.batches.push(batch); });
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/batches/:id', auth, async (req, res) => {
  try {
    const emails = (req.body.emails || []).map(e => e.trim()).filter(Boolean);
    let groupJid = (req.body.whatsappGroupJid || '').trim();
    if (groupJid && !groupJid.includes('@g.us')) {
      try { groupJid = (await resolveGroupJid(groupJid)) || groupJid; } catch {}
    }
    let updated = null;
    update(d => {
      const b = d.batches.find(x => x.id === req.params.id);
      if (!b) return;
      if (req.body.name) b.name = req.body.name.trim();
      b.emails = emails;
      b.whatsappGroupJid = groupJid;
      updated = b;
    });
    if (!updated) return res.status(404).json({ error: 'batch not found' });
    if (googleReady() && updated.driveFolderId) {
      try { await ensureFolderAccess(updated.driveFolderId, emails); } catch (e) { console.error('access sync failed:', e.message); }
    }
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/batches/:id', auth, (req, res) => {
  update(d => { d.batches = d.batches.filter(b => b.id !== req.params.id); });
  res.json({ ok: true });
});

// ---------- CLASSES ----------
app.post('/api/batches/:bid/classes', auth, async (req, res) => {
  try {
    const db = read();
    const batch = db.batches.find(b => b.id === req.params.bid);
    if (!batch) return res.status(404).json({ error: 'batch not found' });

    const topic = (req.body.topic || '').trim();
    const startISO = req.body.startISO;
    if (!topic || !startISO) return res.status(400).json({ error: 'topic and startISO required' });

    let meetLink = (req.body.meetLink || '').trim();
    let eventId = null;

    if (!meetLink) {
      if (!googleReady()) return res.status(400).json({ error: 'google auth missing — cannot auto-generate Meet link' });
      const ev = await createClassEvent(className(topic), startISO, null, '', batch.emails);
      meetLink = ev.meetLink;
      eventId = ev.eventId;
    }

    const cls = { id: id(), topic, startISO, meetLink, eventId, durationMin: 60, status: 'scheduled', createdAt: Date.now() };
    update(d => { d.batches.find(b => b.id === batch.id).classes.push(cls); });

    // Notify via WhatsApp + email (best-effort)
    const msg = classAddedMessage(className(topic), startISO, meetLink);
    try {
      await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
      if (googleReady() && batch.emails.length) {
        await sendEmail({ to: batch.emails, subject: `New Class: ${className(topic)}`, text: msg }).catch(() => {});
      }
    } catch (e) { console.error('class notify failed:', e.message); }

    res.json(cls);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancel a class (with reason) — notifies students
app.delete('/api/batches/:bid/classes/:cid', auth, async (req, res) => {
  try {
    const db = read();
    const batch = db.batches.find(b => b.id === req.params.bid);
    const cls = batch?.classes.find(c => c.id === req.params.cid);
    if (!cls) return res.status(404).json({ error: 'class not found' });

    const reason = req.body?.reason || '';
    update(d => {
      const c = d.batches.find(b => b.id === batch.id).classes.find(x => x.id === cls.id);
      if (c) { c.status = 'cancelled'; c.cancelReason = reason; }
    });

    if (cls.eventId && googleReady()) { try { await deleteClassEvent(cls.eventId); } catch (e) { console.error('cal delete failed:', e.message); } }

    const msg = classCancelledMessage(className(cls.topic), cls.startISO, reason);
    try {
      await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
      if (googleReady() && batch.emails.length) {
        await sendEmail({ to: batch.emails, subject: `Class Cancelled: ${className(cls.topic)}`, text: msg }).catch(() => {});
      }
    } catch (e) { console.error('cancel notify failed:', e.message); }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Permanently remove a class from history
app.delete('/api/batches/:bid/classes/:cid/purge', auth, (req, res) => {
  update(d => {
    const b = d.batches.find(x => x.id === req.params.bid);
    if (b) b.classes = b.classes.filter(c => c.id !== req.params.cid);
  });
  res.json({ ok: true });
});

// Manually find + deliver a recording for a class
app.post('/api/batches/:bid/classes/:cid/send-recording', auth, async (req, res) => {
  try {
    if (!googleReady()) return res.status(400).json({ error: 'google auth missing' });
    const db = read();
    const batch = db.batches.find(b => b.id === req.params.bid);
    const cls = batch?.classes.find(c => c.id === req.params.cid);
    if (!cls) return res.status(404).json({ error: 'class not found' });

    const files = await listInboxVideos();
    const name = className(cls.topic).toLowerCase();
    const match = files.find(f => (f.name || '').toLowerCase().includes(name)) || files[0];
    if (!match) return res.status(404).json({ error: 'no recording found in Drive inbox' });

    let folderId = batch.driveFolderId;
    if (!folderId) {
      folderId = await ensureBatchFolder(batch.name);
      update(d => { const b = d.batches.find(x => x.id === batch.id); if (b) b.driveFolderId = folderId; });
    }
    await ensureFolderAccess(folderId, batch.emails);
    const link = await moveIntoFolder(match.id, folderId);

    update(d => {
      const c = d.batches.find(b => b.id === batch.id).classes.find(x => x.id === cls.id);
      if (c) c.recordingLink = link;
    });

    const msg = recordingMessage(className(cls.topic), link);
    await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
    if (batch.emails.length) await sendEmail({ to: batch.emails, subject: `Recording: ${className(cls.topic)}`, text: msg }).catch(() => {});

    res.json({ ok: true, link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- DRIVE ORGANIZER ----------
app.get('/api/organize/preview', auth, async (req, res) => {
  try {
    if (!googleReady()) return res.status(400).json({ error: 'google auth missing' });
    const files = await listInboxVideos();
    const plan = files.map(f => ({ name: f.name, target: classify(f.name).target }));
    res.json({ count: files.length, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/organize/execute', auth, async (req, res) => {
  try {
    if (!googleReady()) return res.status(400).json({ error: 'google auth missing' });
    const files = await listInboxVideos();
    const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || process.env.DRIVE_INBOX_FOLDER_ID || 'root';
    let moved = 0;
    for (const f of files) {
      const c = classify(f.name);
      const batchFolder = await ensureFolder(c.batch, root);
      const topicFolder = await ensureFolder(c.topic, batchFolder);
      await moveFile(f.id, topicFolder);
      moved++;
    }
    res.json({ moved, total: files.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- LEADS ----------
app.get('/api/leads', auth, (req, res) => res.json(LS.getAllLeads()));

app.get('/api/leads/stats', auth, (req, res) => {
  const cfg = leadResponder.getConfig();
  res.json({
    dailyCount: LS.getDailyCount(), dailyCap: cfg.dailyCap,
    mode: cfg.mode, paymentAutoSend: cfg.paymentAutoSend,
    contactCache: getContactCacheStats(),
    knownChats: getKnownChatsStats()
  });
});

// filtered_saved_contact log entries — recovery list for numbers wrongly hard-skipped.
app.get('/api/leads/filtered-contacts', auth, (req, res) => res.json(LS.getFilteredContacts()));

app.get('/api/leads/:jid', auth, (req, res) => {
  const lead = LS.getLead(req.params.jid);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json({ ...lead, log: LS.getLogForJid(req.params.jid) });
});

app.post('/api/leads/:jid/converted', auth, (req, res) => {
  const jid = req.params.jid;
  if (!LS.getLead(jid)) return res.status(404).json({ error: 'lead not found' });
  LS.setState(jid, 'converted');
  LS.logEvent({ jid, action: 'marked_converted', detail: null });
  res.json({ ok: true });
});

app.post('/api/leads/:jid/ignore', auth, (req, res) => {
  const jid = req.params.jid;
  if (!LS.getLead(jid)) return res.status(404).json({ error: 'lead not found' });
  LS.setManualOverride(jid, 'ignore');
  LS.logEvent({ jid, action: 'manual_ignore', detail: null });
  res.json({ ok: true });
});

// Recovery path for a jid that was hard-skipped as a saved contact but is actually a
// real lead — creates a tracked record so future messages from this jid get classified.
app.post('/api/leads/:jid/treat-as-lead', auth, (req, res) => {
  const jid = req.params.jid;
  const lead = LS.createLead(jid, { phone: jid.split('@')[0] });
  LS.logEvent({ jid, action: 'treated_as_lead', detail: null });
  res.json(lead);
});

// ---------- LEARNING LOOP ----------
// Queue of {jid, phone, pushName, question, answer} pairs captured when the operator
// manually answered something the bot flagged as an 'unanswered_question' escalation.
// Nothing here ever touches course-knowledge.md until the operator explicitly approves
// it below — see src/gemini.js#appendFaqPair.
app.get('/api/learning-queue', auth, (req, res) => res.json(LS.getLearningQueue()));

app.post('/api/learning-queue/:id/approve', auth, (req, res) => {
  const item = LS.getLearningQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'learning queue item not found' });
  const question = (req.body?.question ?? item.question ?? '').trim();
  const answer = (req.body?.answer ?? item.answer ?? '').trim();
  if (!question || !answer) return res.status(400).json({ error: 'question and answer are both required' });
  try {
    G.appendFaqPair(question, answer);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  LS.removeFromLearningQueue(item.id);
  LS.logEvent({ jid: item.jid, action: 'learning_pair_approved', detail: { question } });
  res.json({ ok: true });
});

app.post('/api/learning-queue/:id/discard', auth, (req, res) => {
  const item = LS.getLearningQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'learning queue item not found' });
  LS.removeFromLearningQueue(item.id);
  LS.logEvent({ jid: item.jid, action: 'learning_pair_discarded', detail: null });
  res.json({ ok: true });
});

// ---------- BACKLOG SCAN ----------
// On-demand trigger for the Leads tab's "Scan now" button — same runBacklogScan() the
// 07:00 daily cron calls, just fired manually instead of waiting for it.
app.post('/api/backlog/scan', auth, async (req, res) => {
  try {
    const result = await backlogScan.runBacklogScan();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backlog', auth, (req, res) => {
  res.json({
    queue: LS.getBacklogQueue(),
    firstRunCleared: LS.isBacklogFirstRunCleared(),
    sentToday: LS.getBacklogSentToday(),
    lastSendAt: LS.getBacklogLastSendAt()
  });
});

app.post('/api/backlog/:jid/approve', auth, (req, res) => {
  LS.approveBacklogItem(req.params.jid);
  res.json({ ok: true });
});

// Permanent exclusion, not just a one-time skip — creates/marks the lead as manually
// ignored so a future daily scan can't just re-discover and re-queue the same chat.
app.post('/api/backlog/:jid/remove', auth, (req, res) => {
  const jid = req.params.jid;
  LS.removeFromBacklogQueue(jid);
  if (!LS.getLead(jid)) LS.createLead(jid, { phone: jid.split('@')[0] });
  LS.setManualOverride(jid, 'ignore');
  LS.logEvent({ jid, action: 'backlog_removed', detail: null });
  backlogScan.maybeClearFirstRun();
  res.json({ ok: true });
});

// ---------- RUN JOBS MANUALLY ----------
app.post('/api/run/:job', auth, async (req, res) => {
  const fn = jobs[req.params.job];
  if (!fn) return res.status(404).json({ error: 'no such job' });
  try { await fn(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- START ----------
function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://localhost:${PORT} or http://${lanIP()}:${PORT}`);
  setInboundMessageHandler(leadResponder.handleInboundMessage);
  setOutboundMessageHandler(leadResponder.handleOutboundMessage);
  startWhatsApp();
  startScheduler();
  // One-time startup scan, ~60s after boot — a best-effort head start for the contact
  // cache to sync so this run isn't just an immediate fail-closed no-op. Not the
  // reliable mechanism though: that's the daily 07:00 cron in scheduler.js, which will
  // run regardless of whether this one found the cache ready in time.
  setTimeout(() => { backlogScan.runBacklogScan().catch(e => console.error('Startup backlog scan failed:', e.message)); }, 60000);
});
