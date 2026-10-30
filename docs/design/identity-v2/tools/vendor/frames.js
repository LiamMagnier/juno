// Capture motion frames every 40 ms by seeking paused WAAPI animations.
// Vendored from d3 (identity-v2 session); W3 ports it to scripts/design-audit/motion-frames.mjs and points `base` at a gallery route.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const base = 'file://' + path.resolve(__dirname, '../proto/index.html');
const out = path.resolve(__dirname, '../motion/frames'); fs.mkdirSync(out, { recursive: true });
const JOBS = [
  ['menu-enter', 'menu', ['#menu', '#plusbtn'], false],
  ['submenu-enter', 'menu', ['#menu', '#submenu'], false],
  ['menu-exit', 'menu', ['#menu', '#submenu', '#plusbtn'], false],
  ['dialog-enter', 'dialog', ['#dialog'], false],
  ['dialog-exit', 'dialog', ['#dialog'], false],
  ['toast-enter', 'toast', ['#toast'], false],
  ['toast-exit', 'toast', ['#toast'], false],
  ['needs-enter', 'agent', ['#needs'], false],
  ['menu-enter', 'menu', ['#menu', '#plusbtn'], true],
  ['dialog-enter', 'dialog', ['#dialog'], true],
];
(async () => {
  const b = await chromium.launch();
  const manifest = [];
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const p = await ctx.newPage();
      for (const [name, scene, sels, reduced] of JOBS) {
        await p.goto(`${base}?scene=${scene}&theme=${theme}`);
        await p.evaluate(() => document.fonts.ready);
        const box = await p.evaluate((sels) => {
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (const s of sels) { const e = document.querySelector(s); if (!e) continue; const r = e.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
          return { x: Math.max(0, x0 - 40), y: Math.max(0, y0 - 40), width: Math.min(1440, x1 + 40) - Math.max(0, x0 - 40), height: Math.min(900, y1 + 40) - Math.max(0, y0 - 40) };
        }, sels);
        const total = await p.evaluate(([n, r]) => window.D3M.run(n, { reduced: r }), [name, reduced]);
        const tag = `${name}${reduced ? '-reduced' : ''}-${theme}`;
        const files = [];
        for (let t = 0; t <= total + 40; t += 40) {
          await p.evaluate((t) => window.D3M.seek(t), t);
          const f = `${out}/${tag}-${String(t).padStart(4, '0')}.png`;
          await p.screenshot({ path: f, clip: box });
          files.push(path.basename(f));
        }
        manifest.push({ tag, total, files });
        console.log(tag, total, files.length);
      }
      await ctx.close();
    }
  } finally { await b.close(); }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
})();
