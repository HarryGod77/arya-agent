// Minimal inline-SVG icon set — Harry's Control Room.
// Replaces the emoji used throughout the old panel (🎥 ✏️ 🗑 📁 🔥 💰 📸 💳 🚩 ⏰ ⚠️ 🎓
// 🗂 ◈ ...) with a single consistent line-icon language: 24x24 grid, uniform stroke,
// currentColor — no CDN, no font, no build step, just inline SVG strings.
const STROKE = '1.8';

function gearSpokes() {
  let out = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * 45) * Math.PI / 180;
    const x1 = (12 + Math.cos(a) * 7.2).toFixed(2), y1 = (12 + Math.sin(a) * 7.2).toFixed(2);
    const x2 = (12 + Math.cos(a) * 9.2).toFixed(2), y2 = (12 + Math.sin(a) * 9.2).toFixed(2);
    out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  return out;
}

const PATHS = {
  mail: `<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>`,
  trash: `<path d="M4 7h16"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>`,
  plus: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  edit: `<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>`,
  folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>`,
  calendar: `<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`,
  video: `<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3Z"/>`,
  message: `<rect x="3" y="5" width="18" height="12" rx="3"/><path d="M8 21l3-4"/>`,
  alertTriangle: `<path d="M12 3 2 20h20Z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="16.6" r=".6" fill="currentColor" stroke="none"/>`,
  alertCircle: `<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><circle cx="12" cy="16" r=".6" fill="currentColor" stroke="none"/>`,
  checkCircle: `<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9"/>`,
  creditCard: `<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>`,
  flag: `<path d="M5 21V4"/><path d="M5 4h13l-3 4 3 4H5"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>`,
  users: `<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17.5" cy="8.5" r="2.3"/><path d="M15.2 14a5 5 0 0 1 5.8 6"/>`,
  gear: `<circle cx="12" cy="12" r="3.4"/>${gearSpokes()}`,
  play: `<path d="M7 4.5v15l13-7.5Z"/>`,
  upload: `<path d="M12 19V5"/><polyline points="6 10 12 4 18 10"/><line x1="4" y1="21" x2="20" y2="21"/>`,
  download: `<path d="M12 5v14"/><polyline points="6 14 12 20 18 14"/><line x1="4" y1="21" x2="20" y2="21"/>`,
  chevronDown: `<polyline points="6 9 12 15 18 9"/>`,
  x: `<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>`,
  refresh: `<path d="M21 12a9 9 0 1 1-2.6-6.4"/><polyline points="21 3 21 9 15 9"/>`,
  search: `<circle cx="10.5" cy="10.5" r="6.5"/><line x1="21" y1="21" x2="15.5" y2="15.5"/>`,
  externalLink: `<path d="M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/><path d="M15 3h6v6"/><line x1="21" y1="3" x2="11" y2="13"/>`,
  camera: `<rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.6-2h4.8L16 6"/>`,
  diamond: `<path d="M12 2 22 12 12 22 2 12Z"/>`
};

// icon('trash') -> inline <svg> string, currentColor so it inherits text color from
// wherever it's placed (row-icon, button, badge, ...). Unknown names warn and render
// nothing rather than throwing, so a typo doesn't take down a whole render pass.
export function icon(name, { size = 16, className = '' } = {}) {
  const body = PATHS[name];
  if (!body) {
    console.warn(`icon(): unknown icon "${name}"`);
    return '';
  }
  return `<svg class="icon${className ? ' ' + className : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
