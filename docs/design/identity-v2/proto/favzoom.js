// Favicon crops for shots/favicon-zoom.png. Serve the identity-v2 folder on PORT (python3 -m http.server PORT --bind 127.0.0.1),
// then: PORT=<port> node proto/favzoom.js <out-dir>. Writes fav-<dpr>x-<theme>-<i>.png (i = 0 d3 master, 1 v2 master);
// the sheet is those eight crops scaled ×12 (16 px → 192 px) with nearest-neighbour: rows 1x, 2x; columns d3 light, v2 light, d3 dark, v2 dark.
const { chromium } = require('playwright'); const path = require('path');
const PORT = process.env.PORT || 8771; const OUT = process.argv[2] || '.';
(async () => { const b = await chromium.launch(); try { for (const dpr of [1, 2]) {
  const ctx = await b.newContext({ viewport: { width: 1150, height: 400 }, deviceScaleFactor: dpr }); const p = await ctx.newPage();
  for (const t of ['light', 'dark']) { await p.goto(`http://127.0.0.1:${PORT}/proto/brand.html?t=${t}`); await p.waitForTimeout(300);
    const boxes = await p.$$eval('.tab.on img', els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 }; }));
    let i = 0; for (const bx of boxes) await p.screenshot({ path: path.join(OUT, `fav-${dpr}x-${t}-${i++}.png`), clip: bx }); }
  await ctx.close(); } } finally { await b.close(); } })();
