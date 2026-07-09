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
export async function createClassEvent(title, startISO, endISO, description = '', attendees = []) {
  // Fix: server.js ke arguments ke sath compatibility match ki gayi hai
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
      attendees: attendees.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: 'meet-' + Date.now(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    }
  });

  const meetLink = res.data.conferenceData?.entryPoints?.[0]?.uri || '';
  console.log(`📅 Calendar event created: ${title}. Meet: ${meetLink}`);
  return res.data.id; 
}

// Delete an event.
export async function deleteClassEvent(eventId) {
  if (!eventId) return;
  await cal().events.delete({ calendarId: 'primary', eventId });
  console.log(`🗑️ Calendar event deleted: ${eventId}`);
}

// ---------- YOUTUBE ----------
// Find a video in the channel that matches the topic name.
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

// ---------- GMAIL (SENDER IDENTITY FIXED) ----------
// Helper to safely build an email raw payload.
function buildEmailRaw({ to, subject, html }) {
  // SENDER IDENTITY FIX: Yahan "Arya Chandel" naam explicit jod diya gaya hai
  const senderName = "Arya Chandel";
  const fromHeader = `${senderName} <${process.env.GOOGLE_EMAIL}>`;

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

export async function sendEmail({ to, subject, html }) {
  const raw = buildEmailRaw({ to, subject, html });
  await gmail().users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log(`✉️ Email successfully sent to: ${to} from ${process.env.GOOGLE_EMAIL}`);
}

// ---------- DRIVE OOMPHS ----------
// Find videos in Zoom/local backup root folder.
export async function listInboxVideos() {
  const root = process.env.GOOGLE_DRIVE_INBOX_FOLDER_ID;
  if (!root) return [];
  const res = await drive().files.list({
    q: `'${root}' in parents and mimeType configures 'video/' and trashed = false`,
    fields: 'files(id, name, mimeType)'
  });
  return res.data.files || [];
}

// Safely ensure folder exists under parent.
export async function ensureFolder(name, parentId) {
  const res = await drive().files.list({
    q: `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)'
  });
  if (res.data.files?.[0]?.id) return res.data.files[0].id;
  const cre = await drive().files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id'
  });
  return cre.data.id;
}

// Move file to new parent.
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

export async function ensureBatchFolder(batchName) {
  return await ensureFolder(batchName, process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
}

// Ensure viewer access for specific emails.
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

// Remove viewer access for specific emails.
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

// Move a recording into a folder and return its link.
export async function moveIntoFolder(fileId, folderId) {
  await moveFile(fileId, folderId);
  const res = await drive().files.get({ fileId, fields: 'webViewLink' });
  return res.data.webViewLink;
}

export async function makeShareable(fileId) {
  try {
    await drive().permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });
  } catch (e) {
    console.error(`Warning: makeShareable failed for ${fileId}: ${e.message}`);
  }
}