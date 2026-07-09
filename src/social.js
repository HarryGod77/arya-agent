// Facebook Page + Instagram posting via Meta Graph API.
// YouTube upload lives in google.js (uses the Google OAuth).
const GRAPH = 'https://graph.facebook.com/v20.0';

// ---------- FACEBOOK PAGE ----------
// Post as a normal VIDEO (simplest, reliable). file_url must be publicly reachable.
export async function postFacebookVideo({ fileUrl, caption }) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const r = await fetch(`${GRAPH}/${pageId}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_url: fileUrl, description: caption, access_token: token })
  });
  const d = await r.json();
  if (d.error) throw new Error('FB video: ' + d.error.message);
  return d.id;
}

// Post as a REEL (multi-step: start -> upload -> finish).
export async function postFacebookReel({ fileUrl, caption }) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;

  // 1) start
  const start = await (await fetch(`${GRAPH}/${pageId}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: token })
  })).json();
  if (start.error) throw new Error('FB reel start: ' + start.error.message);
  const videoId = start.video_id;

  // 2) upload (hosted-file method)
  const up = await fetch(`https://rupload.facebook.com/video-upload/v20.0/${videoId}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_url: fileUrl }
  });
  if (!up.ok) throw new Error('FB reel upload failed: ' + up.status);

  // 3) finish + publish
  const finish = await (await fetch(
    `${GRAPH}/${pageId}/video_reels?upload_phase=finish&video_id=${videoId}` +
    `&video_state=PUBLISHED&description=${encodeURIComponent(caption)}&access_token=${token}`,
    { method: 'POST' }
  )).json();
  if (finish.error) throw new Error('FB reel finish: ' + finish.error.message);
  return videoId;
}

// ---------- INSTAGRAM (Reels only) ----------
// Needs a PUBLIC video_url. Two steps: create container -> poll -> publish.
export async function postInstagramReel({ fileUrl, caption }) {
  const igId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;

  // 1) create container
  const c = await (await fetch(`${GRAPH}/${igId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', video_url: fileUrl, caption, access_token: token })
  })).json();
  if (c.error) throw new Error('IG container: ' + c.error.message);

  // 2) poll until ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await (await fetch(`${GRAPH}/${c.id}?fields=status_code&access_token=${token}`)).json();
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error('IG processing error');
  }

  // 3) publish
  const p = await (await fetch(`${GRAPH}/${igId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: c.id, access_token: token })
  })).json();
  if (p.error) throw new Error('IG publish: ' + p.error.message);
  return p.id;
}
