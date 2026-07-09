// Gemini: generate caption + hashtags + description from the video filename/topic.
// Uses REST so no extra SDK needed.
const MODEL = 'gemini-2.0-flash';

export async function generateCaption({ platform, filename, hint }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallback(filename, platform);

  const prompt = `You write social captions for a mentalist/magician performer (brand: Arya / "The Oracle").
Platform: ${platform}. Video file: "${filename}". ${hint ? 'Context: ' + hint : ''}
Return ONLY JSON, no markdown: {"caption": "...", "hashtags": ["#..","#.."], "description": "..."}
Caption: punchy, mysterious, 1-2 lines. Hashtags: 8-12 relevant. Description: 2-3 lines for YouTube/FB.`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      caption: parsed.caption || fallback(filename, platform).caption,
      hashtags: parsed.hashtags || [],
      description: parsed.description || ''
    };
  } catch (e) {
    console.error('Gemini caption failed, using fallback:', e.message);
    return fallback(filename, platform);
  }
}

function fallback(filename, platform) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
  return {
    caption: `${base} ✨ Kya aap dekh paaoge sach?`,
    hashtags: ['#mentalism', '#magic', '#mindreading', '#illusion', '#theoracle'],
    description: `${base}\n\nExperience the impossible. #mentalism`
  };
}
