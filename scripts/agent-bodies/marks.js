// Rasterize each agent mark (agent-face.tsx Mark) to a 1024px alpha mask on the 64-unit grid.
const { chromium } = require('playwright');
const cx = 51, cy = 12, r = 4.6;
const at = (deg) => { const t = deg * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
const s = at(-10), e = at(-80), ball = at(-45);
const M = {
  ring: `<path d="M${s[0]} ${s[1]} A${r} ${r} 0 1 1 ${e[0]} ${e[1]}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="${ball[0]}" cy="${ball[1]}" r="1.4" fill="#fff"/>`,
  spark: '<path fill="#fff" d="M51 5 Q52.4 10.6 58 12 Q52.4 13.4 51 19 Q49.6 13.4 44 12 Q49.6 10.6 51 5 Z"/>',
  leaf: '<path fill="#fff" d="M44 18 C44 11 49 6 57 6 C57 13 52 18 44 18 Z"/>',
  antenna: '<path d="M32 8 L32 2.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="2.5" r="2.2" fill="#fff"/>',
};
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [k, body] of Object.entries(M)) {
    await p.setContent(`<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="1024" height="1024">${body}</svg></body></html>`);
    await p.screenshot({ path: `mask-mark-${k}.png`, omitBackground: true });
  }
  await b.close();
})();
