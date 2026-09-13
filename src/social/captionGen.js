// Facebook Reels caption generation — reuses gemini.js's tiered model routing (the same
// quota-pool-fallback mechanism the lead responder uses) instead of hardcoding a separate
// model choice for social posting.
import { callGeminiJSON, getTierModel, GeminiQuotaExhaustedError } from '../gemini.js';

function fallbackCaption(filename) {
  const base = String(filename || 'reel').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const title = (base.replace(/\b\w/g, c => c.toUpperCase()) || 'New Reel').slice(0, 100);
  return {
    title,
    caption: `${title} ✨ Dekhiye kya hota hai jab dimaag padhna seekh jaaye!`,
    hashtags: ['#mentalism', '#magic', '#mindreading', '#reels', '#viral', '#theoracle', '#arya']
  };
}

// filename: the Drive video's name — often uninformative ("VID_20260304.mp4"). context:
// optional free-text hint (e.g. the batch/topic it came from) to steer the caption when
// the filename alone doesn't say much. Uses tier 2 (mid) — not safety-critical like the
// lead responder's payment/objection replies, but not a bare greeting either.
export async function generateSocialCaption(filename, context = '') {
  const model = getTierModel(2);
  const prompt = `You write Facebook Reels captions for a mentalist/magician performer's
page (brand: Arya / "The Oracle"). Video file: "${filename}". ${context ? 'Context: ' + context : ''}

Write for a Facebook Reels audience: an engaging hook as the very first line (it has to
stop the scroll), then 1-3 more lines building intrigue. Match the tone of the page's
existing content — default to a Hindi-English (Hinglish) mix unless the context says
otherwise.

Return ONLY JSON, no markdown, in exactly this shape:
{"title": "short title, under 60 chars", "caption": "the full reel caption, hook first", "hashtags": ["#tag1", "#tag2"]}
Hashtags: 5-10 relevant tags, each starting with "#", no spaces inside a tag.`;

  try {
    const parsed = await callGeminiJSON(prompt, { model });
    const fb = fallbackCaption(filename);
    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags.filter(h => typeof h === 'string' && h.startsWith('#')).slice(0, 10)
      : [];
    return {
      title: (typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fb.title).slice(0, 100),
      caption: typeof parsed.caption === 'string' && parsed.caption.trim() ? parsed.caption.trim() : fb.caption,
      hashtags: hashtags.length ? hashtags : fb.hashtags
    };
  } catch (e) {
    if (e instanceof GeminiQuotaExhaustedError) console.error(e.message);
    else console.error('Social caption generation failed, using filename-derived fallback:', e.message);
    return fallbackCaption(filename);
  }
}
