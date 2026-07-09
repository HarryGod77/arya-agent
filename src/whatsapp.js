// WhatsApp via Baileys (unofficial WhatsApp Web session on YOUR number).
import { createRequire } from 'module';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

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
      printQRInTerminal: false,
      logger: silentLogger,
      browser: ['Arya Agent', 'Chrome', '120.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        console.log('\n\n========== SCAN THIS QR WITH WHATSAPP ==========\n');
        qrcode.generate(qr, { small: true });
        console.log('\nPhone: WhatsApp > Settings > Linked Devices > Link a Device\n');
      }
      if (connection === 'open') {
        ready = true; starting = false;
        myJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
        console.log('\n\n✅✅ WhatsApp CONNECTED as', sock.user?.id, '\n\n');
      }
      if (connection === 'close') {
        ready = false; starting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.log('WhatsApp logged out — delete data/wa-auth folder and rescan.');
        } else {
          console.log('WhatsApp reconnecting in 3s...');
          setTimeout(() => startWhatsApp(), 3000);
        }
      }
    });
  } catch (e) {
    starting = false;
    console.error('WhatsApp start failed:', e.message);
    setTimeout(() => startWhatsApp(), 5000);
  }
  return sock;
}

export function isReady() { return ready; }

export async function sendMessage({ text, groupJid, directToGroup }) {
  if (!ready || !sock) {
    console.warn('❌ WhatsApp not ready — message skipped');
    return { sent: false, reason: 'not-ready' };
  }
  const wantsGroup = !!(directToGroup && groupJid);
  const target = wantsGroup ? groupJid : myJid;
  console.log(`📤 Sending message → directToGroup=${directToGroup} · groupJid=${groupJid || '(none)'} · target=${target}`);
  const prefix = (target === myJid && groupJid) ? '👉 FORWARD karo group me:\n\n' : '';
  try {
    await sock.sendMessage(target, { text: prefix + text });
    console.log(`✅ Message DELIVERED to ${wantsGroup ? 'GROUP' : 'SELF'}: ${target}`);
    return { sent: true, target };
  } catch (e) {
    console.error(`❌ sendMessage FAILED to ${target}: ${e.message}`);
    // If group send failed, fall back to self so you still get the message
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

// Accepts either a group JID (120363...@g.us) or a WhatsApp invite link
// (https://chat.whatsapp.com/XXXX) and returns the proper group JID.
export async function resolveGroupJid(input) {
  const s = (input || '').trim();
  if (!s) return '';
  const m = s.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  if (!m) return s; // already a JID (or blank/placeholder)
  if (!ready || !sock) throw new Error('WhatsApp not connected yet — try again in a few seconds');
  const info = await sock.groupGetInviteInfo(m[1]);
  return info.id; // resolved group JID
}
