import 'dotenv/config';
import express from 'express';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { read, update, id } from './src/store.js';
import { startWhatsApp, isReady, listGroups, sendMessage, resolveGroupJid } from './src/whatsapp.js';
import { startScheduler, jobs } from './src/scheduler.js';
import { createClassEvent, deleteClassEvent, findRecording, makeShareable, sendEmail, listInboxVideos, ensureFolder, moveFile, ensureBatchFolder, ensureFolderAccess, revokeFolderAccess, moveIntoFolder } from './src/google.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const googleReady = () => !!process.env.GOOGLE_REFRESH_TOKEN;

// ---- Professional message + formatting helpers ----
const IST = 'Asia/Kolkata';
function className(topic) {
  return String(topic).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: IST });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: IST });
}
function newClassMessage(batch, cls) {
  const name = className(cls.topic);
  return `🔮 ${name} — Class Scheduled

📅 ${fmtDate(cls.startISO)}
🕐 ${fmtTime(cls.startISO)} IST

*English*
• Please join 10 minutes before the class with your registered name and email.
• This is a private link — just tap it and wait; the host will admit you.
• Joining from a phone? Please install the Google Meet app (Android / iOS) first.

*हिंदी*
• कृपया क्लास से 10 मिनट पहले अपने रजिस्टर्ड नाम और ईमेल के साथ जुड़ें।
• यह एक प्राइवेट लिंक है — बस लिंक पर टैप करें और प्रतीक्षा करें; होस्ट आपको admit करेगा।
• मोबाइल से जुड़ रहे हैं? कृपया पहले Google Meet ऐप (Android / iOS) इंस्टॉल कर लें।

🔗 Join: ${cls.meetLink}

Regards,
Harry Rajput`;
}

function cancelMessage(name, startISO, reason) {
  return `⚠️ Class Cancelled — ${name}

📅 ${fmtDate(startISO)} · 🕐 ${fmtTime(startISO)} IST

*English:* This class has been cancelled.
Reason: ${reason}
We will share the next schedule soon.

*हिंदी:* यह क्लास रद्द कर दी गई है।
कारण: ${reason}
अगली तारीख़ की जानकारी हम जल्द देंगे।

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

function auth(req, res, next) {
  if (req.headers['x-admin-pass'] === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Wrong password' });
}

app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/login', (req, res) => res.json({ ok: req.body.password === process.env.ADMIN_PASSWORD }));

app.get('/api/config', auth, (req, res) => res.json(read().config));
app.put('/api/config', auth, (req, res) => {
  const db = update(d => { d.config = { ...d.config, ...req.body }; });
  res.json(db.config);
});

app.get('/api/batches', auth, (req, res) => res.json(read().batches));

app.post('/api/batches', auth, async (req, res) => {
  try {
    const { name, whatsappGroupJid, emails, driveRootFolderId } = req.body;
    let jid = '';
    try { jid = await resolveGroupJid(whatsappGroupJid); } catch (e) { return res.status(400).json({ error: 'Group link/JID: ' + e.message }); }
    const cleanEmails = (emails || []).map(e => e.trim()).filter(Boolean);
    let driveFolderId = '';
    if (googleReady()) {
      try {
        driveFolderId = await ensureBatchFolder(name, null);
        await ensureFolderAccess(driveFolderId, cleanEmails);
      } catch (e) { console.error('Batch folder setup failed:', e.message); }
    }
    const batch = {
      id: id(), name,
      whatsappGroupJid: jid,
      emails: cleanEmails,
      driveFolderId,
      driveRootFolderId: driveRootFolderId || '',
      classes: []
    };
    update(d => d.batches.push(batch));
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit a batch (name, emails, group JID/link, drive folder). Keeps its classes.
app.put('/api/batches/:bid', auth, async (req, res) => {
  try {
    const { name, whatsappGroupJid, emails, driveRootFolderId } = req.body;
    const db = read();
    const batch = db.batches.find(b => b.id === req.params.bid);
    if (!batch) return res.status(404).json({ error: 'batch not found' });
    let jid = batch.whatsappGroupJid;
    if (whatsappGroupJid !== undefined) {
      try { jid = await resolveGroupJid(whatsappGroupJid); } catch (e) { return res.status(400).json({ error: 'Group link/JID: ' + e.message }); }
    }
    const oldEmails = batch.emails || [];
    const newEmails = emails !== undefined ? (emails || []).map(e => e.trim()).filter(Boolean) : oldEmails;
    const newName = name !== undefined ? name : batch.name;
    let driveFolderId = batch.driveFolderId || '';
    if (googleReady()) {
      try {
        driveFolderId = await ensureBatchFolder(newName, driveFolderId || null);
        await ensureFolderAccess(driveFolderId, newEmails);
        const removed = oldEmails.filter(e => !newEmails.map(x => x.toLowerCase()).includes(e.toLowerCase()));
        await revokeFolderAccess(driveFolderId, removed);
      } catch (e) { console.error('Batch folder sync failed:', e.message); }
    }
    update(d => {
      const b = d.batches.find(x => x.id === req.params.bid);
      b.name = newName;
      b.emails = newEmails;
      b.whatsappGroupJid = jid;
      b.driveFolderId = driveFolderId;
      if (driveRootFolderId !== undefined) b.driveRootFolderId = driveRootFolderId;
    });
    res.json(read().batches.find(b => b.id === req.params.bid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/batches/:bid', auth, (req, res) => {
  update(d => { d.batches = d.batches.filter(b => b.id !== req.params.bid); });
  res.json({ ok: true });
});

// Add a class. If no Meet link is given and Google is connected, a PRIVATE
// Meet link is auto-generated from the class info. Sends WhatsApp immediately.
app.post('/api/batches/:bid/classes', auth, async (req, res) => {
  try {
    const { topic, startISO, meetLink: manualLink, durationMin } = req.body;
    if (!topic || !startISO) return res.status(400).json({ error: 'topic and date/time required' });

    const db = read();
    const batch = db.batches.find(b => b.id === req.params.bid);
    if (!batch) return res.status(404).json({ error: 'batch not found' });

    let meetLink = (manualLink || '').trim();
    let eventId = null;

    if (!meetLink) {
      if (!googleReady()) return res.status(400).json({ error: 'Google not connected — paste a Meet link, or connect Google' });
      const ev = await createClassEvent({
        title: `${className(topic)} — ${batch.name}`,
        description: `Private class for ${batch.name}. Host will admit participants.`,
        startISO,
        durationMin: Number(durationMin) || 60,
        attendees: batch.emails
      });
      meetLink = ev.meetLink;
      eventId = ev.eventId;
    }

    const cls = { id: id(), topic, startISO, meetLink, eventId, durationMin: Number(durationMin) || 60, status: 'scheduled', createdAt: Date.now() };
    update(d => { d.batches.find(b => b.id === req.params.bid).classes.push(cls); });

    await sendMessage({ text: newClassMessage(batch, cls), groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });

    res.json(cls);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel a class: delete the Meet, notify group + email with a reason, keep it in history.
app.delete('/api/batches/:bid/classes/:cid', auth, async (req, res) => {
  try {
    const reason = (req.body && req.body.reason && String(req.body.reason).trim()) || 'Not specified';
    const db = read();
    const batch = db.batches.find(b => b.id === req.params.bid);
    if (!batch) return res.status(404).json({ error: 'batch not found' });
    const cls = (batch.classes || []).find(c => c.id === req.params.cid);
    if (!cls) return res.status(404).json({ error: 'class not found' });
    if (cls.eventId && googleReady()) await deleteClassEvent(cls.eventId);
    const msg = cancelMessage(className(cls.topic), cls.startISO, reason);
    await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
    if (batch.emails?.length) await sendEmail({ to: batch.emails, subject: `Class Cancelled: ${className(cls.topic)}`, text: msg }).catch(() => {});
    update(d => {
      const c = d.batches.find(x => x.id === req.params.bid).classes.find(y => y.id === req.params.cid);
      c.status = 'cancelled'; c.cancelReason = reason; c.eventId = null;
    });
    res.json({ ok: true, cancelled: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Permanently remove a class from history.
app.delete('/api/batches/:bid/classes/:cid/purge', auth, (req, res) => {
  update(d => {
    const b = d.batches.find(x => x.id === req.params.bid);
    if (b) b.classes = (b.classes || []).filter(c => c.id !== req.params.cid);
  });
  res.json({ ok: true });
});

// Manually check Drive for THIS class's recording and send it to the group + email now.
app.post('/api/batches/:bid/classes/:cid/send-recording', auth, async (req, res) => {
  try {
    if (!googleReady()) return res.status(400).json({ error: 'Google not connected' });
    const db = read();
    const batch = db.batches.find(b => b.id === req.params.bid);
    if (!batch) return res.status(404).json({ error: 'batch not found' });
    const cls = (batch.classes || []).find(c => c.id === req.params.cid);
    if (!cls) return res.status(404).json({ error: 'class not found' });
    const file = await findRecording({ topicText: className(cls.topic), batchName: batch.name });
    if (!file) return res.status(404).json({ error: 'No recording found in Drive yet for this class' });
    let view;
    if (batch.driveFolderId) {
      await ensureFolderAccess(batch.driveFolderId, batch.emails);
      view = await moveIntoFolder(file.id, batch.driveFolderId);
    } else {
      view = (await makeShareable(file.id)).view;
    }
    const msg = recordingMessage(className(cls.topic), view);
    await sendMessage({ text: msg, groupJid: batch.whatsappGroupJid, directToGroup: db.config.whatsappDirectToGroup });
    if (batch.emails?.length) await sendEmail({ to: batch.emails, subject: `Recording: ${className(cls.topic)}`, text: msg }).catch(() => {});
    res.json({ sent: true, file: file.name, link: view });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Organize existing Drive recordings into Batch / Topic folders ----
function classifyRecording(fileName) {
  const n = (fileName || '').toLowerCase();
  let batch = 'Others';
  
  // Check for explicit batch names
  if (n.includes('diwali')) batch = 'Diwali Batch';
  else if (n.includes('rakhi')) batch = 'Rakhi Batch';
  else if (n.includes('march')) batch = 'March Batch';
  else {
    // Check for "Batch X" pattern (e.g., "Batch 7 class 4" → "Batch 7")
    const m = n.match(/batch\s+(\d+)/);
    if (m) batch = `Batch ${m[1]}`;
  }
  
  // Add year if found
  const y = n.match(/20\d{2}/);
  if (y) batch += ' ' + y[0];
  
  let topic = 'General';
  if (n.includes('hypnos')) topic = 'Hypnosis';
  else if (n.includes('mind reading') || n.includes('mind-reading')) topic = 'Mind Reading';
  else if (n.includes('invisible touch')) topic = 'Invisible Touch';
  else if (n.includes('introduction') || n.includes('intro')) topic = 'Introduction';
  else if (n.includes('practice')) topic = 'Practice';
  else if (n.includes('act') && !n.includes('facts')) topic = 'Acts';
  else if (n.includes('special')) topic = 'Special';
  else if (n.includes('classic')) topic = 'Classic';
  else if (n.includes('advance')) topic = 'Advanced';
  
  return { batch, topic };
}

// PREVIEW only — shows the plan, moves nothing.
app.get('/api/organize/preview', auth, async (req, res) => {
  try {
    if (!googleReady() || !process.env.DRIVE_INBOX_FOLDER_ID) return res.status(400).json({ error: 'Connect Google + set DRIVE_INBOX_FOLDER_ID first' });
    const files = await listInboxVideos();
    const plan = files.map(f => { const c = classifyRecording(f.name); return { name: f.name, target: `${c.batch} / ${c.topic}` }; });
    res.json({ count: plan.length, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// APPLY — actually creates folders and moves files (share links stay intact).
app.post('/api/organize/execute', auth, async (req, res) => {
  try {
    if (!googleReady() || !process.env.DRIVE_INBOX_FOLDER_ID) return res.status(400).json({ error: 'Connect Google + set DRIVE_INBOX_FOLDER_ID first' });
    const root = process.env.DRIVE_INBOX_FOLDER_ID;
    const files = await listInboxVideos();
    let moved = 0;
    for (const f of files) {
      const c = classifyRecording(f.name);
      const batchFolder = await ensureFolder(c.batch, root);
      const topicFolder = await ensureFolder(c.topic, batchFolder);
      await moveFile(f.id, topicFolder);
      moved++;
    }
    res.json({ moved, total: files.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whatsapp/status', auth, (req, res) => res.json({ ready: isReady() }));
app.get('/api/whatsapp/groups', auth, async (req, res) => res.json(await listGroups()));

app.post('/api/run/:job', auth, async (req, res) => {
  const fn = jobs[req.params.job];
  if (!fn) return res.status(404).json({ error: 'no such job' });
  try { await fn(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎩 Arya Agent running!');
  console.log('   On this laptop:  http://localhost:' + PORT);
  console.log('   On your phone:   http://' + lanIP() + ':' + PORT + '   (same WiFi)\n');
  console.log('   Google auto-Meet: ' + (googleReady() ? 'ON ✅' : 'OFF (paste links manually)'));
  startWhatsApp().catch(e => console.error('WhatsApp start error:', e.message));
  startScheduler();
});
