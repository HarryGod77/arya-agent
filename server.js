import 'dotenv/config';
import express from 'express';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCodeImage from 'qrcode'; 
import { read, update, id } from './src/store.js';
import { startWhatsApp, isWhatsAppReady, listGroups, sendMessage, resolveGroupJid, getQrCode } from './src/whatsapp.js';
import { startScheduler, jobs } from './src/scheduler.js';
import { createClassEvent, deleteClassEvent, findRecording, makeShareable, sendEmail, listInboxVideos, ensureFolder, moveFile, ensureBatchFolder, ensureFolderAccess, revokeFolderAccess, moveIntoFolder } from './src/google.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const googleReady = () => !!process.env.GOOGLE_REFRESH_TOKEN;

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

// Helper to handle recording classification safely
function classifyRecording(fileName) {
  const name = fileName || '';
  return {
    batch: name.includes('batch') ? 'Batch Class' : 'General',
    topic: name.split('—')[0] || 'Topic'
  };
}

// --- BROWSER QR CODE ENDPOINT ---
app.get('/qr', async (req, res) => {
  const qrData = getQrCode();
  
  if (isWhatsAppReady()) {
    return res.send('<h3>✅ WhatsApp connected aur ready hai!</h3>');
  }
  
  if (!qrData) {
    return res.send('<h3>⏳ QR Code ban raha hai... Kripya 5 second baad page ko Refresh (F5) karein.</h3>');
  }

  try {
    const qrImageSrc = await QRCodeImage.toDataURL(qrData);
    res.send(`
      <div style="text-align: center; margin-top: 50px; font-family: Arial, sans-serif;">
        <h2>Arya Agent WhatsApp se connect karne ke liye scan karein</h2>
        <div style="margin: 20px auto; padding: 10px; border: 1px solid #ccc; display: inline-block; background: #fff;">
          <img src="${qrImageSrc}" alt="WhatsApp QR Code" style="width: 300px; height: 300px;"/>
        </div>
        <p><strong>Status:</strong> Phone ke WhatsApp -> Linked Devices me jaakar scan karein.</p>
      </div>
    `);
  } catch (err) {
    console.error('QR Image banane mein dikkat aayi:', err);
    res.status(500).send('QR Code image generate nahi ho payi.');
  }
});

// ---- API Routes ----
const auth = (req, res, next) => {
  if (req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'unauthorized' });
};

app.get('/api/config', auth, async (req, res) => res.json(await read()));
app.post('/api/config', auth, async (req, res) => {
  await update(req.body);
  res.json({ ok: true });
});

app.post('/api/classes', auth, async (req, res) => {
  if (!googleReady()) return res.status(400).json({ error: 'google auth missing' });
  try {
    const data = await read();
    const c = { id: id(), topic: req.body.topic, start: req.body.start, end: req.body.end, processed: false };
    c.calendarEventId = await createClassEvent(className(c.topic), c.start, c.end);
    data.classes.push(c);
    await update(data);
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/classes/:id', auth, async (req, res) => {
  try {
    const data = await read();
    const idx = data.classes.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const [c] = data.classes.splice(idx, 1);
    if (c.calendarEventId && googleReady()) {
      try { await deleteClassEvent(c.calendarEventId); } catch (e) { console.error('cal delete failed:', e.message); }
    }
    await update(data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/process-recordings', auth, async (req, res) => {
  if (!googleReady()) return res.status(400).json({ error: 'google auth missing' });
  try {
    const data = await read();
    const files = await listInboxVideos();
    const rootFolder = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || 'root';
    let moved = 0;
    for (const f of files) {
      const c = classifyRecording(f.name);
      const batchFolder = await ensureFolder(c.batch, rootFolder);
      const topicFolder = await ensureFolder(c.topic, batchFolder);
      await moveFile(f.id, topicFolder);
      moved++;
    }
    res.json({ moved, total: files.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whatsapp/status', auth, (req, res) => res.json({ ready: isWhatsAppReady() }));
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
  console.log(`🚀 Server listening on http://localhost:${PORT} or http://${lanIP()}:${PORT}`);
  startWhatsApp();
  startScheduler();
});