// Facebook Reels Publishing API — 3-phase flow (start -> upload -> finish).
// Separate from the legacy src/social.js (posts by handing Meta a public Drive URL,
// documented there as unreliable for large files) — this module uploads the raw video
// bytes directly to Meta's rupload host instead, so it doesn't depend on Drive's
// download link being publicly reachable at all.
import fs from 'fs';

const GRAPH = 'https://graph.facebook.com/v26.0';

function summarize(obj, max = 300) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch {
    return String(obj);
  }
}

// Builds a descriptive Error including Meta's error code/subcode/type when present —
// callers (scheduler.js's publish pipeline, server.js's routes) surface e.message
// directly to the panel, so this is the only place that needs to know Meta's error shape.
function metaError(prefix, res, data) {
  const err = data?.error;
  if (err) {
    const parts = [err.message || 'unknown error'];
    if (err.type) parts.push(`type=${err.type}`);
    if (err.code != null) parts.push(`code=${err.code}`);
    if (err.error_subcode != null) parts.push(`subcode=${err.error_subcode}`);
    if (err.fbtrace_id) parts.push(`trace=${err.fbtrace_id}`);
    return new Error(`${prefix}: ${parts.join(' ')}`);
  }
  return new Error(`${prefix}: HTTP ${res.status} ${res.statusText}`);
}

async function readJsonSafe(res) {
  try { return await res.json(); } catch { return null; }
}

// Phase 1/3: open an upload session. Returns the video id to publish later and the
// per-session upload URL (host is rupload.facebook.com, not graph.facebook.com).
export async function startUploadSession(pageId, token) {
  const url = `${GRAPH}/${pageId}/video_reels`;
  console.log(`FB reel: starting upload session for page ${pageId}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: token })
  });
  const data = await readJsonSafe(res);
  console.log(`FB reel: start response ${res.status} — ${summarize(data)}`);
  if (!res.ok || data?.error) throw metaError('FB reel start failed', res, data);
  if (!data?.video_id || !data?.upload_url) throw new Error(`FB reel start: missing video_id/upload_url in response — ${summarize(data)}`);
  return { video_id: data.video_id, upload_url: data.upload_url };
}

// Phase 2/3: PUT the raw video bytes to the session's upload_url. Streams the local file
// rather than reading it into a Buffer first — reels can be large and the server is
// RAM-constrained (see google.js#downloadDriveFile, which downloaded this same file the
// same way).
export async function uploadVideoFile(uploadUrl, localFilePath, token) {
  const stat = fs.statSync(localFilePath);
  console.log(`FB reel: uploading ${localFilePath} (${stat.size} bytes)`);
  const stream = fs.createReadStream(localFilePath);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      Offset: '0',
      file_size: String(stat.size),
      'Content-Type': 'application/octet-stream'
    },
    body: stream,
    duplex: 'half' // required by Node's fetch when the body is a stream
  });
  const data = await readJsonSafe(res);
  console.log(`FB reel: upload response ${res.status} — ${summarize(data)}`);
  if (!res.ok || data?.error) throw metaError('FB reel upload failed', res, data);
  if (data && data.success === false) throw new Error(`FB reel upload reported failure: ${summarize(data)}`);
  return data;
}

// Phase 3/3: finish + publish immediately.
export async function publishReel(pageId, videoId, description, token) {
  const url = `${GRAPH}/${pageId}/video_reels`;
  console.log(`FB reel: publishing ${videoId} on page ${pageId}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_phase: 'finish', video_id: videoId, description: description || '',
      video_state: 'PUBLISHED', access_token: token
    })
  });
  const data = await readJsonSafe(res);
  console.log(`FB reel: publish response ${res.status} — ${summarize(data)}`);
  if (!res.ok || data?.error) throw metaError('FB reel publish failed', res, data);
  return data;
}

// Deliberately no "scheduled" variant here — Meta's native video_state=SCHEDULED /
// scheduled_publish_time is never used. All timing lives in our own queue
// (socialStore.js's scheduledFor); every call to publishReel() above happens at our
// chosen moment and always publishes immediately (video_state=PUBLISHED), so from
// Facebook's side every post is an instant publish and only this server knows the schedule.

// Views/reach come from the video_insights metrics endpoint; likes/comments are plain
// edge fields on the video node itself, not insight metrics — hence the two calls.
// NOTE: exact available metric names/values for Reels have moved across Graph API
// versions in the past; if Meta renames/retires one of these, the caller ends up with a
// null for that field rather than a thrown error (a failed insights refresh shouldn't be
// treated as fatal — see scheduler.js's refreshSocialInsights).
export async function getReelInsights(videoId, token) {
  const metrics = ['blue_reels_play_count', 'post_video_views', 'post_video_view_time'];
  const url = `${GRAPH}/${videoId}/video_insights?metric=${metrics.join(',')}&access_token=${token}`;
  console.log(`FB reel: fetching insights for ${videoId}`);
  const res = await fetch(url);
  const data = await readJsonSafe(res);
  console.log(`FB reel: insights response ${res.status} — ${summarize(data)}`);
  if (!res.ok || data?.error) throw metaError('FB reel insights failed', res, data);

  const byName = {};
  for (const m of data?.data || []) {
    byName[m.name] = m.values?.[m.values.length - 1]?.value ?? null;
  }

  let likes = null, comments = null;
  try {
    const r2 = await fetch(`${GRAPH}/${videoId}?fields=likes.summary(true),comments.summary(true)&access_token=${token}`);
    const d2 = await readJsonSafe(r2);
    if (r2.ok && !d2?.error) {
      likes = d2.likes?.summary?.total_count ?? null;
      comments = d2.comments?.summary?.total_count ?? null;
    } else {
      console.error(`FB reel: likes/comments fetch failed for ${videoId} — ${summarize(d2)}`);
    }
  } catch (e) {
    console.error(`FB reel: likes/comments fetch threw for ${videoId}:`, e.message);
  }

  return {
    views: byName.blue_reels_play_count ?? byName.post_video_views ?? null,
    reach: byName.post_video_view_time ?? null,
    likes, comments
  };
}

// GET /me with the page token — used by the panel's connection-status strip. Just needs
// to succeed or throw; the id/name are a bonus for display.
export async function validateToken(token) {
  const url = `${GRAPH}/me?fields=id,name&access_token=${token}`;
  const res = await fetch(url);
  const data = await readJsonSafe(res);
  console.log(`FB token validate response ${res.status} — ${summarize(data)}`);
  if (!res.ok || data?.error) throw metaError('FB token validation failed', res, data);
  return { valid: true, id: data.id, name: data.name };
}
