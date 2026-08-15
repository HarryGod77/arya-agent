// Simple JSON file store — no DB setup needed to start.
// Swap for Postgres later if scale demands.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_DB = {
  config: {
    postsPerDay: 1,
    whatsappDirectToGroup: false, // toggle: false = Note-to-Self (safe), true = post to group (ban risk)
    social: {
      facebook: { enabled: true, format: 'reel' },   // 'reel' | 'video'
      instagram: { enabled: true, format: 'reel' },  // always reel
      youtube: { enabled: true, format: 'short' }     // 'short' | 'video'
    },
    leadResponder: {
      mode: 'draft',                          // 'draft' = notify self, 'auto' = reply the lead directly (ban risk)
      dailyCap: 30,                            // max NEW leads (not messages) handled per IST calendar day
      silentHours: { start: 23, end: 8 },      // IST hours, wraps midnight — no sends in this window
      paymentAutoSend: false                   // opt-in — also needs PAYMENT_DETAILS filled in course-knowledge.md
    }
  },
  batches: [],   // { id, name, whatsappGroupJid, emails:[], classes:[...] }
  sentLog: {}    // idempotency: key -> timestamp
};

function ensure() {
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
}

export function read() {
  ensure();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

export function write(db) {
  ensure();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function update(fn) {
  const db = read();
  fn(db);
  write(db);
  return db;
}

// Idempotency helpers — taaki ek reminder/recording do baar na jaaye
export function alreadySent(key) {
  return !!read().sentLog[key];
}
export function markSent(key) {
  update(db => { db.sentLog[key] = new Date().toISOString(); });
}

export function id() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
