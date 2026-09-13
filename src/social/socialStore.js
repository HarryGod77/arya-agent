// Facebook auto-posting data layer — data/social.json. Same read-modify-write pattern as
// paymentStore.js/leadStore.js, and deliberately its own file for the same reason: a bad
// write to this high-churn queue/insights data should never risk corrupting batch/class
// data in db.json.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCIAL_PATH = path.join(__dirname, '..', '..', 'data', 'social.json');

const DEFAULT_DB = {
  uploadedFileIds: [], // Drive file ids already posted — never post the same one twice
  queue: [],           // [{id, driveFileId, fileName, caption, title, hashtags, scheduledFor, status, fbVideoId, error, createdAt, publishedAt, publishDelaySeconds}]
  // scheduledFor is OUR schedule only — Meta is never told a time. publishDelaySeconds
  // (set by scheduler.js#publishQueueItem once actually published) is how many seconds
  // late the 1-min cron tick got to it, for diagnosing tick/backlog drift.
  schedule: { slots: ['09:00', '14:00', '20:00'], timezone: 'Asia/Kolkata', enabled: true, postsPerDay: 3 },
  insights: {}          // fbVideoId -> {views, reach, likes, comments, fetchedAt}
};

function ensure() {
  if (!fs.existsSync(path.dirname(SOCIAL_PATH))) fs.mkdirSync(path.dirname(SOCIAL_PATH), { recursive: true });
  if (!fs.existsSync(SOCIAL_PATH)) fs.writeFileSync(SOCIAL_PATH, JSON.stringify(DEFAULT_DB, null, 2));
}

export function read() {
  ensure();
  return JSON.parse(fs.readFileSync(SOCIAL_PATH, 'utf-8'));
}

export function write(db) {
  ensure();
  fs.writeFileSync(SOCIAL_PATH, JSON.stringify(db, null, 2));
}

export function update(fn) {
  const db = read();
  fn(db);
  write(db);
  return db;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- uploaded-file dedupe ----------
export function isAlreadyUploaded(fileId) {
  return read().uploadedFileIds.includes(fileId);
}

export function markUploaded(fileId) {
  update(d => { if (!d.uploadedFileIds.includes(fileId)) d.uploadedFileIds.push(fileId); });
}

// ---------- queue ----------
export function addToQueue({ driveFileId, fileName, caption, title, hashtags, scheduledFor }) {
  const item = {
    id: genId(), driveFileId, fileName, caption: caption || '', title: title || '',
    hashtags: hashtags || [], scheduledFor: scheduledFor || null, status: 'queued',
    fbVideoId: null, error: null, createdAt: Date.now(), publishedAt: null, publishDelaySeconds: null
  };
  update(d => { d.queue.push(item); });
  return item;
}

export function getQueue() {
  return read().queue;
}

export function getQueueItem(id) {
  return read().queue.find(q => q.id === id) || null;
}

export function updateQueueItem(id, patch) {
  let updated = null;
  update(d => {
    const item = d.queue.find(q => q.id === id);
    if (item) { Object.assign(item, patch); updated = item; }
  });
  return updated;
}

export function removeFromQueue(id) {
  update(d => { d.queue = d.queue.filter(q => q.id !== id); });
}

// The panel's queue list is edited by on-screen position, not a numeric priority field —
// this just splices the item to sit at newIndex among the rest.
export function reorderQueue(id, newIndex) {
  let updated = null;
  update(d => {
    const idx = d.queue.findIndex(q => q.id === id);
    if (idx === -1) return;
    const [item] = d.queue.splice(idx, 1);
    const at = Math.max(0, Math.min(newIndex, d.queue.length));
    d.queue.splice(at, 0, item);
    updated = d.queue;
  });
  return updated || read().queue;
}

// ---------- schedule ----------
export function getSchedule() {
  return read().schedule;
}

export function setSchedule(patch) {
  update(d => { d.schedule = { ...d.schedule, ...patch }; });
  return read().schedule;
}

// ---------- insights ----------
export function saveInsights(fbVideoId, data) {
  update(d => { d.insights[fbVideoId] = { ...data, fetchedAt: Date.now() }; });
}

export function getInsights(fbVideoId) {
  return read().insights[fbVideoId] || null;
}

export function getAllInsights() {
  return read().insights;
}
