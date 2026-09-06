// Google integrations: Calendar (auto Meet link), Drive, Gmail, YouTube.
// All use ONE OAuth2 client (one refresh token).
import { google } from 'googleapis';
import { Readable } from 'stream';

// --- Env fallbacks: works with BOTH old and new variable names ---
const SENDER_EMAIL  = process.env.GOOGLE_SENDER_EMAIL || process.env.GOOGLE_EMAIL || '';
const INBOX_FOLDER  = process.env.DRIVE_INBOX_FOLDER_ID || process.env.GOOGLE_DRIVE_INBOX_FOLDER_ID || '';
const ROOT_FOLDER   = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || process.env.DRIVE_INBOX_FOLDER_ID || 'root';

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
// Returns { eventId, meetLink } so server.js can save the join link.
export async function createClassEvent(title, startISO, endISO, description = '', attendees = []) {
  const start = new Date(startISO);
  const end = endISO ? new Date(endISO) : new Date(start.getTime() + 60 * 60000);

  const res = await cal().events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: title,
      description,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
      end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
      attendees: (attendees || []).map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: 'meet-' + Date.now(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }
  });

  const meetLink = res.data.conferenceData?.entryPoints?.[0]?.uri || res.data.hangoutLink || '';
  console.log(`📅 Calendar event created: ${title}. Meet: ${meetLink}`);
  return { eventId: res.data.id, meetLink };
}

// Delete an event.
export async function deleteClassEvent(eventId) {
  if (!eventId) return;
  await cal().events.delete({ calendarId: 'primary', eventId });
  console.log(`🗑️ Calendar event deleted: ${eventId}`);
}

// ---------- YOUTUBE ----------
export async function findRecording(topicName) {
  const q = (topicName || '').trim().toLowerCase();
  if (!q) return null;
  const res = await youtube().search.list({
    part: 'snippet',
    type: 'video',
    forMine: true,
    maxResults: 50
  });
  const item = (res.data.items || []).find(i => (i.snippet?.title || '').toLowerCase().includes(q));
  if (!item) return null;
  return { id: item.id?.videoId, title: item.snippet?.title, thumb: item.snippet?.thumbnails?.high?.url };
}

// ---------- GMAIL ----------
function buildEmailRaw({ to, subject, html }) {
  const senderName = 'Arya Chandel';
  const fromHeader = SENDER_EMAIL ? `${senderName} <${SENDER_EMAIL}>` : senderName;
  const parts = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html
  ];
  return Buffer.from(parts.join('\n')).toString('base64url');
}

// Accepts { to, subject, html } OR { to, subject, text }. "to" can be a string or array.
export async function sendEmail({ to, subject, html, text }) {
  const body = html || (text ? text.replace(/\n/g, '<br>') : '');
  const toStr = Array.isArray(to) ? to.join(', ') : to;
  if (!toStr) return;
  const raw = buildEmailRaw({ to: toStr, subject, html: body });
  await gmail().users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log(`✉️ Email sent to: ${toStr}${SENDER_EMAIL ? ' from ' + SENDER_EMAIL : ''}`);
}

// ---------- DRIVE ----------
// Files manually dropped into the operator's own "inbox" folder — used only by the
// Drive Organizer tool (server.js /api/organize/*), which sorts whatever the operator
// puts there. Distinct from listVideosSince below: Meet's own auto-recordings never
// land in this folder, which is the bug the Drive-wide search exists to work around.
export async function listInboxVideos() {
  if (!INBOX_FOLDER) return [];
  const res = await drive().files.list({
    q: `'${INBOX_FOLDER}' in parents and mimeType contains 'video/' and trashed = false`,
    fields: 'files(id, name, mimeType, createdTime)'
  });
  return res.data.files || [];
}

// Drive-wide video search. Google Meet drops recordings into its own account-level
// "Meet Recordings" folder (not any folder we control), so we can't filter by parent —
// search all of Drive and let the caller narrow by time window / name match instead.
export async function listVideosSince(sinceISO) {
  const res = await drive().files.list({
    q: `mimeType='video/mp4' and trashed=false and createdTime > '${sinceISO}'`,
    fields: 'files(id, name, mimeType, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 100,
  });
  return res.data.files || [];
}

// Ensure a folder exists under parent, return its id.
export async function ensureFolder(name, parentId) {
  const parent = parentId || ROOT_FOLDER;
  const res = await drive().files.list({
    q: `name = '${name.replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)'
  });
  if (res.data.files?.[0]?.id) return res.data.files[0].id;
  const cre = await drive().files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] },
    fields: 'id'
  });
  return cre.data.id;
}

// Move file to a new parent folder.
export async function moveFile(fileId, targetFolderId) {
  const file = await drive().files.get({ fileId, fields: 'parents' });
  const previousParents = (file.data.parents || []).join(',');
  await drive().files.update({
    fileId,
    addParents: targetFolderId,
    removeParents: previousParents,
    fields: 'id, parents'
  });
}

// Ensure a batch folder exists under the recordings root.
export async function ensureBatchFolder(batchName, parentId) {
  return ensureFolder(batchName, parentId || ROOT_FOLDER);
}

// Grant viewer access to specific emails.
export async function ensureFolderAccess(folderId, emails) {
  const wanted = (emails || []).map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!folderId || !wanted.length) return;
  const cur = await drive().permissions.list({ fileId: folderId, fields: 'permissions(id,emailAddress,type)' });
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

// Revoke viewer access for specific emails.
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

// Move a recording into a folder and return its shareable view link.
export async function moveIntoFolder(fileId, folderId) {
  await moveFile(fileId, folderId);
  const res = await drive().files.get({ fileId, fields: 'webViewLink' });
  return res.data.webViewLink;
}

// Generic small-file upload — used by src/invoicing.js to back up generated invoice
// PDFs to Drive. Best-effort from the caller's side (see invoicing.js's try/catch); this
// function itself just does the upload and returns the new file's id.
export async function uploadFile(name, buffer, mimeType, folderId) {
  const res = await drive().files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id'
  });
  return res.data.id;
}

export async function makeShareable(fileId) {
  try {
    await drive().permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
  } catch (e) {
    console.error(`Warning: makeShareable failed for ${fileId}: ${e.message}`);
  }
}
