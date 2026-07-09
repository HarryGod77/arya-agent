// WhatsApp via Baileys (unofficial WhatsApp Web session on YOUR number).
import { createRequire } from 'module';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCodeImage from 'qrcode'; // Naya image QR generator

const require = createRequire(import.meta.url);
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const silentLogger = pino({ level: 'silent' });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', 'data', 'wa-auth');

let sock = null;
let ready = false;
let myJid = null;
let starting = false;
let globalQrCode = null; // Browser ke liye QR code save karne ke liye

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
      [span_1](start_span)printQRInTerminal: true, // Ise true rakha hai taaki logs me bhi dikhe agar zaroorat ho[span_1](end_span)
      logger: silentLogger,
      browser: ['Arya Agent', 'Chrome', '120.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Agar naya QR aata hai toh use variable me save karein
      if (qr) {
        globalQrCode = qr;
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

export async function sendMessage(target, text, wantsGroup = false) {
  if (!ready || !sock) {
    throw new Error('WhatsApp client taiyar nahi hai. Pehle /qr par jaakar scan karein.');
  }
  const prefix = wantsGroup ? '📢 Announcement to group:\n\n' : '';
  try {
    await sock.sendMessage(target, { text: prefix + text });
    console.log(`✅ Message DELIVERED to ${wantsGroup ? 'GROUP' : 'SELF'}: ${target}`);
    return { sent: true, target };
  } catch (e) {
    console.error(`❌ sendMessage FAILED to ${target}: ${e.message}`);
    if (wantsGroup) {
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
  const m = s.match(/chat\.whatsapp\\.com\/([A-Za-z0-9]{20,24})/);
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

// Ye naye helpers hain jo server.js me kaam aayenge
export const getQrCode = () => globalQrCode;
export const isReady = () => ready;