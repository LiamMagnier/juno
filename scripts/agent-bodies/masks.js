// Rasterize each agent body silhouette (the exact paths from agent-face.tsx) to a 1024px alpha mask.
const { chromium } = require('playwright');
const S = {
  tile: '<path d="M21 6 H43 Q58 6 58 21 V43 Q58 58 43 58 H21 Q6 58 6 43 V21 Q6 6 21 6 Z"/>',
  halo: '<path fill-rule="evenodd" d="M32 4 A28 28 0 1 1 31.99 4 Z M32 9 A5 5 0 1 0 32.01 9 Z"/>',
  prism: '<path d="M27 5 Q32 2 37 5 L55 16 Q60 19 60 25 V40 Q60 46 55 49 L37 60 Q32 63 27 60 L9 49 Q4 46 4 40 V25 Q4 19 9 16 Z"/>',
  orb: '<circle cx="32" cy="33" r="26"/>',
  pebble: '<rect x="6" y="9" width="52" height="48" rx="20"/>',
  capsule: '<rect x="12" y="5" width="40" height="56" rx="20"/>',
  petal: '<path d="M8 9 H34 C48 9 58 21 58 35 C58 49 47 59 33 59 C19 59 8 48 8 34 Z"/>',
  bloom: '<circle cx="22" cy="23" r="15"/><circle cx="42" cy="23" r="15"/><circle cx="22" cy="43" r="15"/><circle cx="42" cy="43" r="15"/><rect x="22" y="23" width="20" height="20"/>',
  spark: '<path d="M32 5 C36 22 42 28 59 33 C42 38 36 44 32 61 C28 44 22 38 5 33 C22 28 28 22 32 5 Z"/>',
};
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [k, body] of Object.entries(S)) {
    await p.setContent(`<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="1024" height="1024" fill="#fff">${body}</svg></body></html>`);
    await p.screenshot({ path: `mask-${k}.png`, omitBackground: true });
  }
  await b.close();
})();
