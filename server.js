import 'dotenv/config';
import express from 'express';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCodeImage from 'qrcode';
import { read, update, id } from './src/store.js';
import {
  startWhatsApp, isWhatsAppReady, listGroups, sendMessage, resolveGroupJid, getQrCode,
  setInboundMessageHandler, setOutboundMessageHandler, setMissedCallHandler,
  getContactCacheStats, getKnownChatsStats
} from './src/whatsapp.js';
import * as G from './src/gemini.js';
import { startScheduler, jobs, matchRecordingForClass, publishQueueItem } from './src/scheduler.js';
import {
  createClassEvent, deleteClassEvent, sendEmail, listInboxVideos, listVideosSince,
  ensureFolder, moveFile, ensureBatchFolder, ensureFolderAccess, moveIntoFolder,
  listSocialVideos
} from './src/google.js';
import * as leadResponder from './src/leadResponder.js';
import * as LS from './src/leadStore.js';
import * as backlogScan from './src/backlogScan.js';
import * as invoicing from './src/invoicing.js';
import * as PS from './src/paymentStore.js';
import * as PCS from './src/paymentConfigStore.js';
import * as paymentSender from './src/paymentSender.js';
import * as SPS from './src/studentPaymentStore.js';
import * as studentPayments from './src/studentPayments.js';
import * as SS from './src/social/socialStore.js';
import * as FB from './src/social/facebookApi.js';
import { generateSocialCaption } from './src/social/captionGen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve Harry's Control Room panel (index.html, app.js, styles.css)

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

    const sinceISO = new Date(new Date(cls.startISO).getTime() - 3600e3).toISOString();
    const files = (await listVideosSince(sinceISO)).filter(f => f.mimeType?.startsWith('video/') && !/notes by gemini/i.test(f.name));
    const { chosen: match, reason } = matchRecordingForClass(cls, files);
    if (!match) return res.status(404).json({ error: `no recording found (${reason})` });

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
    knownChats: getKnownChatsStats(),
    replySplit: LS.getReplySplitToday(),
    outbound: {
      sentToday: LS.getOutboundSentToday(),
      dailyCap: Number(process.env.DAILY_OUTBOUND_CAP) || 20,
      enabled: process.env.OUTBOUND_ENABLED !== 'false'
    }
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

// Manual send only (Part 4 outbound safety) — nothing in this queue goes out on any
// cron anymore. This is the one and only path that actually delivers a backlog opener,
// and it only ever runs from an explicit "Send" click in the Leads tab.
app.post('/api/backlog/:jid/send', auth, async (req, res) => {
  try {
    const result = await backlogScan.sendBacklogItem(req.params.jid);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ---------- PAYMENTS / INVOICING ----------
// Operator-triggered only — see src/invoicing.js#confirmPayment for why the amount comes
// from a human, never from the bot, and why the payment record is written before the
// WhatsApp send is even attempted.
app.post('/api/leads/:jid/confirm-payment', auth, async (req, res) => {
  try {
    const result = await invoicing.confirmPayment({ jid: req.params.jid, amount: req.body?.amount });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/payments', auth, (req, res) => res.json(PS.getAllPayments()));

app.get('/api/payments/export', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
  res.send(PS.toCsv());
});

// Retry delivery when confirmPayment() generated the invoice fine but the WhatsApp send
// itself failed (waSent:false in the payments list).
app.post('/api/payments/:invoiceNumber/resend', auth, async (req, res) => {
  try {
    const result = await invoicing.resendInvoice(req.params.invoiceNumber);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- PAYMENT DETAILS SENDER (Part 1) ----------
// Editable UPI/bank block (data/payment-config.json) + a manual send-to-any-number tool.
// Distinct from the lead-invoice flow above: this fires BEFORE a payment to give someone
// something to pay against, not after one to confirm it.
app.get('/api/payment-config', auth, (req, res) => res.json(PCS.getConfig()));

app.put('/api/payment-config', auth, (req, res) => {
  const { upiId, accountName, bankName, accountNumber, ifsc, note } = req.body || {};
  res.json(PCS.updateConfig({ upiId, accountName, bankName, accountNumber, ifsc, note }));
});

// Text + UPI link for a given amount, no send — backs the panel's "Copy" button.
app.get('/api/payment-config/preview', auth, (req, res) => {
  res.json(paymentSender.previewPaymentDetails(req.query.amount ? Number(req.query.amount) : null));
});

app.post('/api/payment-config/send', auth, async (req, res) => {
  const { phone, amount } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  try {
    const result = await paymentSender.sendPaymentDetails({ phone, amount: amount ? Number(amount) : null });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- STUDENT PAYMENT LEDGER (Part 2) ----------
app.get('/api/students', auth, (req, res) => res.json(studentPayments.getAllStudents()));

// Must come before the GET /api/students/:id route below — otherwise Express matches
// "export" as an :id here first and this route is never reached.
app.get('/api/students/export', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="student-payments.csv"');
  res.send(SPS.toCsv());
});

app.get('/api/students/:id', auth, (req, res) => {
  const s = studentPayments.getStudentDetail(req.params.id);
  if (!s) return res.status(404).json({ error: 'student not found' });
  res.json(s);
});

app.post('/api/students', auth, (req, res) => {
  try { res.json(studentPayments.addStudent(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/students/:id', auth, (req, res) => {
  try { res.json(studentPayments.editStudent(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Editing an installment's amount/due date directly — used for uneven EMI splits before
// it's paid. Marking one paid goes through a dedicated route below (Part 3), not this one.
app.put('/api/students/:id/installments/:number', auth, (req, res) => {
  try { res.json(studentPayments.editInstallment(req.params.id, req.params.number, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- RECEIPTS / STATEMENTS / SCREENSHOT CONFIRMATION (Part 3) ----------
// Manual "Mark paid" click in the ledger — amount defaults to the installment's own
// amount but the operator can override it (e.g. a partial payment).
app.post('/api/students/:id/installments/:number/mark-paid', auth, async (req, res) => {
  try {
    const result = await studentPayments.markInstallmentPaid(req.params.id, req.params.number, { amount: req.body?.amount });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Confirming a screenshot-flagged installment — same "amount always typed by the operator,
// never parsed from the image" guarantee as /api/leads/:jid/confirm-payment.
app.post('/api/students/:id/confirm-screenshot', auth, async (req, res) => {
  const student = studentPayments.getStudentDetail(req.params.id);
  if (!student?.pendingScreenshot) return res.status(400).json({ error: 'No pending screenshot for this student' });
  try {
    const result = await studentPayments.confirmScreenshotPayment(req.params.id, student.pendingScreenshot.installmentNumber, req.body?.amount);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/students/:id/statement/send', auth, async (req, res) => {
  try { res.json(await studentPayments.sendStatement(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- PAYMENT REMINDERS — approval queue (Part 4) ----------
// Nothing here ever sends automatically — the daily cron (src/scheduler.js) only queues
// candidates via scanForReminders(); the operator's explicit "Send" click on one item is
// the one and only path that actually messages a student. Same pattern as the backlog
// scan / backlog send split.
app.get('/api/payment-reminders', auth, (req, res) => res.json(studentPayments.getReminderQueueWithDetails()));

app.post('/api/payment-reminders/scan', auth, (req, res) => {
  try { res.json(studentPayments.scanForReminders()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment-reminders/:id/send', auth, async (req, res) => {
  try { res.json(await studentPayments.sendReminderQueueItem(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment-reminders/:id/dismiss', auth, (req, res) => {
  res.json(studentPayments.dismissReminderItem(req.params.id));
});

// ---------- PAYMENTS DASHBOARD (Part 5) ----------
app.get('/api/payments/dashboard', auth, (req, res) => res.json(studentPayments.getDashboard()));

// ---------- SOCIAL (Facebook Reels auto-posting) ----------
// IST date-key helper, same fixed-offset approach used throughout the lead-responder
// subsystem (leadStore.js's istDateKey, paymentStore.js's istYear) — used here only to
// decide what counts as "today" for the status strip's queue/posted-count display.
const istDateKey = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

app.get('/api/social/status', auth, async (req, res) => {
  const result = {
    socialEnabled: process.env.SOCIAL_ENABLED === 'true',
    tokenValid: false, pageName: null, tokenError: null,
    stockCount: null, stockError: null,
    postedToday: 0, todaysQueue: []
  };

  if (process.env.FB_PAGE_ACCESS_TOKEN) {
    try {
      const v = await FB.validateToken(process.env.FB_PAGE_ACCESS_TOKEN);
      result.tokenValid = true;
      result.pageName = v.name;
    } catch (e) { result.tokenError = e.message; }
  } else {
    result.tokenError = 'FB_PAGE_ACCESS_TOKEN not set';
  }

  if (googleReady() && process.env.DRIVE_SOCIAL_FOLDER_ID) {
    try {
      const files = await listSocialVideos(process.env.DRIVE_SOCIAL_FOLDER_ID);
      result.stockCount = files.filter(f => !SS.isAlreadyUploaded(f.id)).length;
    } catch (e) { result.stockError = e.message; }
  } else {
    result.stockError = googleReady() ? 'DRIVE_SOCIAL_FOLDER_ID not set' : 'google auth missing';
  }

  const today = istDateKey();
  const queue = SS.getQueue();
  result.todaysQueue = queue.filter(q => q.scheduledFor && istDateKey(new Date(q.scheduledFor)) === today);
  result.postedToday = queue.filter(q => q.status === 'published' && q.publishedAt && istDateKey(new Date(q.publishedAt)) === today).length;

  res.json(result);
});

app.get('/api/social/queue', auth, (req, res) => {
  const insights = SS.getAllInsights();
  res.json(SS.getQueue().map(q => ({ ...q, insights: q.fbVideoId ? (insights[q.fbVideoId] || null) : null })));
});

// Manual trigger for the daily 08:00 refill — same job the cron calls.
app.post('/api/social/queue/refill', auth, async (req, res) => {
  try { await jobs.refillSocialQueue(); res.json({ ok: true, queue: SS.getQueue() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Publishes immediately instead of waiting for its scheduled time (or, given a bare
// driveFileId not yet in the queue, queues + publishes it on the spot) — shared with the
// 5-min cron tick via scheduler.js#publishQueueItem so both paths run the identical
// download -> upload -> publish -> cleanup sequence.
app.post('/api/social/publish-now', auth, async (req, res) => {
  try {
    const { queueItemId, driveFileId } = req.body || {};
    let item;
    if (queueItemId) {
      item = SS.getQueueItem(queueItemId);
      if (!item) return res.status(404).json({ error: 'queue item not found' });
    } else if (driveFileId) {
      if (SS.isAlreadyUploaded(driveFileId)) return res.status(400).json({ error: 'this Drive file was already posted' });
      const existing = SS.getQueue().find(q => q.driveFileId === driveFileId && q.status !== 'failed');
      if (existing) {
        item = existing;
      } else {
        if (!process.env.DRIVE_SOCIAL_FOLDER_ID) return res.status(400).json({ error: 'DRIVE_SOCIAL_FOLDER_ID not set' });
        const files = await listSocialVideos(process.env.DRIVE_SOCIAL_FOLDER_ID);
        const file = files.find(f => f.id === driveFileId);
        if (!file) return res.status(404).json({ error: 'file not found in the configured Drive social folder' });
        const cap = await generateSocialCaption(file.name).catch(() => ({ title: file.name, caption: '', hashtags: [] }));
        item = SS.addToQueue({ driveFileId: file.id, fileName: file.name, caption: cap.caption, title: cap.title, hashtags: cap.hashtags, scheduledFor: new Date().toISOString() });
      }
    } else {
      return res.status(400).json({ error: 'queueItemId or driveFileId required' });
    }

    const result = await publishQueueItem(item);
    if (result.status !== 'published') return res.status(500).json({ error: result.error || 'publish failed', item: result });
    res.json({ ok: true, item: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inline edits from the panel's queue list (caption/title/hashtags/scheduled time).
app.put('/api/social/queue/:id', auth, (req, res) => {
  const item = SS.getQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'queue item not found' });
  const { caption, title, hashtags, scheduledFor } = req.body || {};
  const patch = {};
  if (typeof caption === 'string') patch.caption = caption;
  if (typeof title === 'string') patch.title = title;
  if (Array.isArray(hashtags)) patch.hashtags = hashtags.filter(h => typeof h === 'string');
  if (typeof scheduledFor === 'string') patch.scheduledFor = scheduledFor;
  res.json(SS.updateQueueItem(item.id, patch));
});

app.post('/api/social/queue/:id/reorder', auth, (req, res) => {
  const newIndex = Number(req.body?.newIndex);
  if (!Number.isInteger(newIndex) || newIndex < 0) return res.status(400).json({ error: 'newIndex (integer >= 0) required' });
  if (!SS.getQueueItem(req.params.id)) return res.status(404).json({ error: 'queue item not found' });
  res.json({ ok: true, queue: SS.reorderQueue(req.params.id, newIndex) });
});

app.delete('/api/social/queue/:id', auth, (req, res) => {
  SS.removeFromQueue(req.params.id);
  res.json({ ok: true });
});

app.get('/api/social/schedule', auth, (req, res) => res.json(SS.getSchedule()));

app.post('/api/social/schedule', auth, (req, res) => {
  const { slots, timezone, enabled, postsPerDay } = req.body || {};
  const patch = {};
  if (Array.isArray(slots) && slots.every(s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s))) patch.slots = slots;
  if (typeof timezone === 'string' && timezone.trim()) patch.timezone = timezone.trim();
  if (typeof enabled === 'boolean') patch.enabled = enabled;
  if (Number.isFinite(postsPerDay) && postsPerDay > 0) patch.postsPerDay = Math.floor(postsPerDay);
  res.json(SS.setSchedule(patch));
});

app.post('/api/social/caption/regenerate', auth, async (req, res) => {
  try {
    const item = SS.getQueueItem(req.body?.queueItemId);
    if (!item) return res.status(404).json({ error: 'queue item not found' });
    const cap = await generateSocialCaption(item.fileName);
    res.json(SS.updateQueueItem(item.id, { title: cap.title, caption: cap.caption, hashtags: cap.hashtags }));
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// Local-dev safety switches — both default to the current live behavior (enabled), so
// production deploys are unaffected unless explicitly opted out. Exists because a laptop
// running this app can otherwise reconnect Baileys using a leftover data/wa-auth/ session
// for the SAME linked WhatsApp account already live on the server, which WhatsApp's
// multi-device protocol treats as a conflict and can force the real session offline.
// Set WHATSAPP_ENABLED=false in a LOCAL-ONLY .env to test the panel/API without touching
// WhatsApp at all. SCHEDULER_ENABLED=false additionally stops cron jobs from firing
// against real Google Calendar/Gmail/Drive or Meta posting if real credentials happen to
// be present locally too — recommended alongside WHATSAPP_ENABLED=false for local runs.
const whatsappEnabled = process.env.WHATSAPP_ENABLED !== 'false';
const schedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false';

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://localhost:${PORT} or http://${lanIP()}:${PORT}`);
  setInboundMessageHandler(leadResponder.handleInboundMessage);
  setOutboundMessageHandler(leadResponder.handleOutboundMessage);
  setMissedCallHandler(leadResponder.handleMissedCall);

  if (whatsappEnabled) {
    startWhatsApp();
  } else {
    console.log('⏸️  WHATSAPP_ENABLED=false — skipping WhatsApp connection (local-dev safety switch). /qr will show nothing and WA-dependent routes will no-op.');
  }

  if (schedulerEnabled) {
    startScheduler();
  } else {
    console.log('⏸️  SCHEDULER_ENABLED=false — skipping cron scheduler (local-dev safety switch). No reminders, recording checks, social posts, or lead-responder cron jobs will run.');
  }

  // One-time startup scan, ~60s after boot — a best-effort head start for the contact
  // cache to sync so this run isn't just an immediate fail-closed no-op. Not the
  // reliable mechanism though: that's the daily 07:00 cron in scheduler.js, which will
  // run regardless of whether this one found the cache ready in time. Only meaningful
  // when WhatsApp is actually connected.
  if (whatsappEnabled) {
    setTimeout(() => { backlogScan.runBacklogScan().catch(e => console.error('Startup backlog scan failed:', e.message)); }, 60000);
  }
});
