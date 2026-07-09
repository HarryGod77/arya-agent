// Google integrations: Calendar (auto Meet link), Drive, Gmail, YouTube.
// All use ONE OAuth2 client (one refresh token).
import { google } from 'googleapis';

function oauth() {
  const c = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  c.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return c;
}

const cal = () => google.calendar({ version: 'v3', auth: oauth() });
const drive = () => google.drive({ version: 'v3', auth: oauth() });
const gmail = () => google.gmail({ version: 'v1', auth: oauth() });
const youtube = () => google.youtube({ version: 'v3', auth: oauth() });

// ---------- CALENDAR + MEET ----------
// Creates a private event with an auto-generated Google Meet link.
// Invited students can join; anyone else must be admitted by the host.
export async function createClassEvent({ title, description = '', startISO, durationMin = 60, attendees = [] }) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMin * 60000);
  const res = await cal().events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: title,
      description,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
      end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
      attendees: (attendees || []).filter(Boolean).map(e => ({ email: e })),
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: false,
      conferenceData: {
        createRequest: { requestId: 'meet-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } }
      }
    }
  });
  const link = res.data.hangoutLink || res.data.conferenceData?.entryPoints?.[0]?.uri;
  return { eventId: res.data.id, meetLink: link };
}

// Delete a scheduled class (cancels the Meet + notifies invited students).
export async function deleteClassEvent(eventId) {
  if (!eventId) return;
  try {
    await cal().events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
  } catch (e) { /* already gone — ignore */ }
}

// ---------- GMAIL ----------
export async function sendEmail({ to, subject, text }) {
  const from = process.env.GOOGLE_SENDER_EMAIL;
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const raw = [
    from ? `From: ${from}` : '',
    `To: ${recipients}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text
  ].filter(Boolean).join('\n');
  const encoded = Buffer.from(raw).toString('base64url');
  await gmail().users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

// ---------- DRIVE ----------
export async function listInbox() {
  const res = await drive().files.list({
    q: `'${process.env.DRIVE_INBOX_FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType)'
  });
  return res.data.files || [];
}

export async function listPostQueue() {
  const res = await drive().files.list({
    q: `'${process.env.DRIVE_POST_QUEUE_FOLDER_ID}' in parents and trashed=false and mimeType contains 'video'`,
    fields: 'files(id,name,mimeType)',
    orderBy: 'createdTime'
  });
  return res.data.files || [];
}

export async function makeShareable(fileId) {
  await drive().permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  }).catch(() => {});
  const res = await drive().files.get({ fileId, fields: 'webViewLink,webContentLink' });
  return { view: res.data.webViewLink, download: res.data.webContentLink };
}

export async function ensureFolder(name, parentId) {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await drive().files.list({ q, fields: 'files(id)' });
  if (found.data.files?.length) return found.data.files[0].id;
  const created = await drive().files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id'
  });
  return created.data.id;
}

export async function moveFile(fileId, newParentId) {
  const f = await drive().files.get({ fileId, fields: 'parents' });
  const prev = (f.data.parents || []).join(',');
  await drive().files.update({ fileId, addParents: newParentId, removeParents: prev, fields: 'id' });
}

export async function downloadStream(fileId) {
  const res = await drive().files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return res.data;
}

// ---------- YOUTUBE ----------
export async function uploadYouTube({ title, description, tags, stream, asShort }) {
  const finalTitle = asShort && !/#shorts/i.test(title) ? `${title} #Shorts` : title;
  const finalDesc = asShort && !/#shorts/i.test(description) ? `${description}\n\n#Shorts` : description;
  const res = await youtube().videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title: finalTitle, description: finalDesc, tags },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    },
    media: { body: stream }
  });
  return `https://youtu.be/${res.data.id}`;
}


// List all video files in the inbox folder (Google Meet recordings land here).
export async function listInboxVideos() {
  const folder = process.env.DRIVE_INBOX_FOLDER_ID;
  if (!folder) return [];
  const res = await drive().files.list({
    q: `'${folder}' in parents and trashed=false and mimeType contains 'video'`,
    fields: 'files(id,name,createdTime,webViewLink)',
    orderBy: 'createdTime desc',
    pageSize: 200
  });
  return res.data.files || [];
}

// Find a recording matching a class. Google Meet names files after the meeting
// title, e.g. "Mind Reading — 2026 March batch — 2026/07/09 08:37 IST — Recording".
export async function findRecording({ topicText, batchName }) {
  if (!process.env.DRIVE_INBOX_FOLDER_ID) throw new Error('DRIVE_INBOX_FOLDER_ID not set in .env');
  const files = await listInboxVideos();
  const t = (topicText || '').toLowerCase().trim();
  const b = (batchName || '').toLowerCase().trim();
  const has = (f, x) => x && f.name.toLowerCase().includes(x);
  return files.find(f => has(f, t) && has(f, b))   // best: topic + batch
      || files.find(f => has(f, t))                // topic only
      || files.find(f => has(f, b))                // batch only
      || null;
}


// ---------- BATCH FOLDERS + PER-STUDENT ACCESS ----------
// Root folder that holds all batch folders.
export async function ensureRootFolder() {
  return ensureFolder('Arya Class Recordings', 'root');
}

// Get (or create) a batch's folder. Renames it if the batch name changed.
export async function ensureBatchFolder(name, existingId) {
  if (existingId) {
    try {
      await drive().files.update({ fileId: existingId, requestBody: { name }, fields: 'id' });
      return existingId;
    } catch { /* folder gone — recreate below */ }
  }
  const root = await ensureRootFolder();
  return ensureFolder(name, root);
}

// Give each email VIEWER access to the folder (only adds missing ones).
export async function ensureFolderAccess(folderId, emails) {
  const wanted = (emails || []).map(e => e.trim()).filter(Boolean);
  if (!folderId || !wanted.length) return;
  const cur = await drive().permissions.list({ fileId: folderId, fields: 'permissions(emailAddress,type)' });
  const have = new Set((cur.data.permissions || []).filter(p => p.type === 'user' && p.emailAddress).map(p => p.emailAddress.toLowerCase()));
  for (const email of wanted) {
    if (have.has(email.toLowerCase())) continue;
    try {
      await drive().permissions.create({ fileId: folderId, sendNotificationEmail: false, requestBody: { role: 'reader', type: 'user', emailAddress: email } });
    } catch {
      try { await drive().permissions.create({ fileId: folderId, sendNotificationEmail: true, requestBody: { role: 'reader', type: 'user', emailAddress: email } }); } catch {}
    }
  }
}

// Remove viewer access for specific emails (used when a student is removed from a batch).
export async function revokeFolderAccess(folderId, emails) {
  const set = (emails || []).map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!folderId || !set.length) return;
  const cur = await drive().permissions.list({ fileId: folderId, fields: 'permissions(id,emailAddress,type)' });
  for (const p of (cur.data.permissions || [])) {
    if (p.type === 'user' && p.emailAddress && set.includes(p.emailAddress.toLowerCase())) {
      try { await drive().permissions.delete({ fileId: folderId, permissionId: p.id }); } catch {}
    }
  }
}

// Move a recording into a folder and return its (folder-inherited) view link.
export async function moveIntoFolder(fileId, folderId) {
  await moveFile(fileId, folderId);
  const res = await drive().files.get({ fileId, fields: 'webViewLink' });
  return res.data.webViewLink;
}
