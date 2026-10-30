#!/usr/bin/env node
/**
 * Geometry audit: measures the rendered product's spacing, radii, control
 * heights, alignment and targets, and scores them against the design scales.
 *
 *   node scripts/design-audit/geometry-audit.mjs \
 *     --base http://localhost:3000 \
 *     --routes scripts/design-audit/routes.json \
 *     --state path/to/storage-state.json \
 *     --out /tmp/geometry/before \
 *     [--scheme light|dark] [--viewport 1440x900|390x844]
 *
 * Other flags:
 *   --routes "/chat,/projects"   a comma list instead of a file (.json, .mjs or .txt)
 *   --only <text>                only routes whose name contains <text>
 *   --concurrency <n>            pages measured at once (default 2)
 *   --full                       measure the whole document, not the first viewport
 *   --top <n>                    offenders outlined per screenshot (default 20)
 *   --scales <file.json>         override { spacing, radius, radiusPercent, controlHeight, iconSize, tolerances }
 *   --compare <geometry.json>    add a before/after table against an earlier run
 *   --no-raw                     skip raw/<route>.json (every element record) and shots/<route>.clean.png
 *   --resume                     keep the routes the run already in --out measured (re-scored from their
 *                                raw records) and measure only the failed or missing ones
 *   --redo <text,...>            with --resume, measure again the routes whose name contains any of these;
 *                                "@loading" also redoes every route that was still showing placeholders
 *   --reanalyze <run dir>        re-score a saved run from its raw records with the current rules,
 *                                scales and tolerances, and redraw its screenshots; no app server needed
 *                                (writes into --out, or back into the run dir)
 *   --no-screenshots             skip the annotated screenshots
 *   --timeout <ms>               navigation timeout (default 180000; the dev server compiles on first hit)
 *   --retries <n>                retries after a dropped connection, once the server has answered steadily
 *                                for 10 s, then 20, 40 and 60 s (default 3)
 *   --chromium <path>            a Chromium executable, when Playwright's own is missing
 *   --busy <selector>            loading placeholders to wait out before measuring
 *                                (default '.skeleton, [aria-busy="true"], [data-skeleton]')
 *   --busy-timeout <ms>          how long to wait for them (default 60000); a route still loading is marked
 *   --min-elements <n>           fewer visible boxes than this is a failed load, retried (default 8,
 *                                3 when only an opened layer is measured; a route may set "minElements")
 *   --error-text <regex>         an h1/h2 matching this marks an error screen (the route fails, is retried once
 *                                the server answers, and is never scored); routes may set "allowError": true.
 *                                The default also catches the product's own error boundaries and not-found
 *                                screens ("… couldn’t load", "… couldn’t start", "… isn’t here"), and panels
 *                                (role=status or alert) titled so; "allowError": "panels" accepts those panels only
 *
 * A route is a path, or an object:
 *   { "name": "chat · model menu", "path": "/chat", "auth": true,
 *     "waitFor": "main textarea",
 *     "open": [ { "click": "button[aria-haspopup=menu][aria-label*=Model]" }, { "waitFor": "[role=menu]" } ],
 *     "scope": null, "viewport": "390x844" }
 * With open steps the route measures only the layers they add to <body>
 * (portaled menus, popovers, dialogs) unless "scope" is "page" or a selector.
 * Open steps: click, dblclick, hover, focus, press, fill, type, wait (ms),
 * waitFor, waitForHidden, waitForUrl (a regex), scroll, eval, goto. Each step takes an optional
 * "nth" (which match) and "optional": true (a miss is not an error). A .mjs
 * routes module may give `open` as an async function (page) => {}.
 * A route or a step with "when": "phone" or "desktop" runs only at that width
 * (under 600 px is a phone), so one routes file serves both viewports: a phone
 * opens the sidebar drawer where a desktop hovers a row.
 *
 * Outputs in --out: geometry.json, report.md, shots/<route>.png (annotated),
 * shots/<route>.clean.png and raw/<route>.json (for --reanalyze).
 * Pure logic lives in geometry-lib.mjs (tested by tests/design-geometry-audit.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { collectGeometry, drawOverlay } from "./geometry-collect.mjs";
import {
  DEFAULT_CONTROL_HEIGHTS,
  DEFAULT_ERROR_TEXT,
  DEFAULT_ICON_SIZES,
  DEFAULT_SPACING_SCALE,
  DEFAULT_TOLERANCES,
  FALLBACK_RADIUS_SCALE,
  KIND_COLORS,
  aggregateSite,
  analyzeRoute,
  appliesAt,
  compareRuns,
  isPhoneViewport,
  makeContext,
  normalizeRoutes,
  parseCssVars,
  parseRadiusLadder,
  parseViewport,
  pickOffenders,
  refOf,
} from "./geometry-lib.mjs";
import { renderMarkdown } from "./geometry-report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const require = createRequire(import.meta.url);

const OPTIONS = new Set(["routes", "state", "out", "only", "scales", "compare", "redo", "reanalyze", "chromium"]);

function parseArgs(argv) {
  const args = {
    base: "http://localhost:3000",
    scheme: "light",
    viewport: "1440x900",
    concurrency: 2,
    top: 20,
    timeout: 180000,
    retries: 3,
    screenshots: true,
    raw: true,
    busy: '.skeleton, [aria-busy="true"], [data-skeleton]',
    "min-elements": 8,
    "busy-timeout": 60000,
    "error-text": DEFAULT_ERROR_TEXT,
  };
  const flags = new Set(["full", "no-raw", "no-screenshots", "resume", "help"]);
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
    const name = a.slice(2);
    if (flags.has(name)) {
      if (name === "no-screenshots") args.screenshots = false;
      else if (name === "no-raw") args.raw = false;
      else args[name] = true;
      continue;
    }
    if (!(name in args) && !OPTIONS.has(name)) throw new Error(`Unknown option --${name} (see --help)`);
    const value = argv[++k];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    args[name] = value;
  }
  args.concurrency = Math.max(1, Number(args.concurrency) || 1);
  args.top = Math.max(0, Number(args.top) || 0);
  args.timeout = Number(args.timeout) || 180000;
  args.retries = Math.max(0, Number(args.retries ?? 3));
  args["busy-timeout"] = Math.max(0, Number(args["busy-timeout"]));
  if (!["light", "dark"].includes(args.scheme)) throw new Error("--scheme is light or dark");
  return args;
}

function loadScales(args) {
  let radius = null;
  let radiusPercent = [];
  let radiusSource = null;
  try {
    const tw = fs.readFileSync(path.join(REPO, "tailwind.config.ts"), "utf8");
    let vars = {};
    try {
      vars = parseCssVars(fs.readFileSync(path.join(REPO, "src/app/globals.css"), "utf8"), ["--radius"]);
    } catch {
      /* globals.css is optional: var() rungs are skipped without it */
    }
    const ladder = parseRadiusLadder(tw, vars);
    if (ladder) {
      radius = ladder.px;
      radiusPercent = ladder.percent;
      radiusSource = "the borderRadius ladder in tailwind.config.ts";
    }
  } catch {
    /* fall back below */
  }
  const scales = {
    spacing: DEFAULT_SPACING_SCALE,
    radius: radius || FALLBACK_RADIUS_SCALE,
    radiusPercent,
    controlHeight: DEFAULT_CONTROL_HEIGHTS,
    iconSize: DEFAULT_ICON_SIZES,
  };
  let tolerances = {};
  if (args.scales) {
    const custom = JSON.parse(fs.readFileSync(args.scales, "utf8"));
    for (const k of ["spacing", "radius", "radiusPercent", "controlHeight", "iconSize"]) if (Array.isArray(custom[k])) scales[k] = custom[k].slice().sort((a, b) => a - b);
    if (custom.tolerances) tolerances = custom.tolerances;
    radiusSource = Array.isArray(custom.radius) ? `from ${args.scales}` : radiusSource;
  }
  if (!scales.radius.includes(0)) scales.radius = [0, ...scales.radius];
  return { scales, tolerances, radiusSource };
}

async function loadRoutes(spec) {
  if (!spec) spec = path.join(HERE, "routes.json");
  if (fs.existsSync(spec)) {
    if (/\.m?js$/.test(spec)) {
      const mod = await import(pathToFileURL(path.resolve(spec)).href);
      return normalizeRoutes(mod.default || mod.routes);
    }
    return normalizeRoutes(fs.readFileSync(spec, "utf8"));
  }
  return normalizeRoutes(spec);
}

function findChromium() {
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), ".cache", "ms-playwright"), "/opt/pw-browsers"].filter(Boolean);
  let wanted = null;
  for (const file of [path.join(REPO, "node_modules", "playwright-core", "browsers.json")]) {
    try {
      const browsers = JSON.parse(fs.readFileSync(file, "utf8")).browsers;
      wanted = browsers.find((b) => b.name === "chromium-headless-shell")?.revision || null;
      if (wanted) break;
    } catch {
      /* unknown revision: take any */
    }
  }
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const m = /^chromium(_headless_shell)?-(\d+)$/.exec(entry);
      if (!m) continue;
      const exe = m[1] ? path.join(dir, entry, "chrome-headless-shell-linux64", "chrome-headless-shell") : path.join(dir, entry, "chrome-linux64", "chrome");
      if (fs.existsSync(exe)) found.push({ exe, rev: m[2], shell: !!m[1] });
    }
  }
  found.sort((a, b) => (b.rev === wanted) - (a.rev === wanted) || b.shell - a.shell || Number(b.rev) - Number(a.rev));
  return found[0]?.exe || null;
}

async function launch(chromium, args) {
  const opts = { args: ["--disable-dev-shm-usage", "--hide-scrollbars", "--font-render-hinting=none"] };
  if (args.chromium) return chromium.launch({ ...opts, executablePath: args.chromium });
  try {
    return await chromium.launch(opts);
  } catch (err) {
    if (!/Executable doesn't exist/.test(String(err?.message))) throw err;
    const exe = findChromium();
    if (!exe) throw err;
    console.error(`geometry-audit: Playwright's Chromium is missing; using ${exe}`);
    return chromium.launch({ ...opts, executablePath: exe });
  }
}

const STILL_CSS = `*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;animation-iteration-count:1!important;transition-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}nextjs-portal{display:none!important}`;

/**
 * Wait for React to hydrate, in short slices so a failed script chunk (the
 * server restarted after sending the HTML) ends the wait at once instead of
 * after the full timeout.
 */
async function waitForHydration(page, timeout, failed) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const reason = failed();
    if (reason) throw new Error(reason);
    if (await hydratedWithin(page, Math.min(2000, Math.max(1, until - Date.now())))) return true;
  }
  return false;
}

function hydratedWithin(page, timeout) {
  return page
    .waitForFunction(
      () => {
        const all = document.body ? document.body.getElementsByTagName("*") : [];
        if (!all.length) return false;
        let seen = 0;
        let hydrated = 0;
        for (const e of all) {
          if (++seen > 300) break;
          for (const k in e) {
            if (k.startsWith("__reactFiber$")) {
              hydrated++;
              break;
            }
          }
        }
        return hydrated >= Math.max(1, Math.min(seen, 300) * 0.3);
      },
      null,
      { timeout, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);
}

/** Wait until a cheap layout signature stops changing (max ~4 s). */
async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => {});
  let last = null;
  for (let k = 0; k < 16; k++) {
    const sig = await page
      .evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const els = document.body ? document.body.getElementsByTagName("*") : [];
                let s = els.length;
                const step = Math.max(1, Math.floor(els.length / 500));
                for (let i = 0; i < els.length; i += step) {
                  const r = els[i].getBoundingClientRect();
                  s = (s * 31 + Math.round(r.x) * 7 + Math.round(r.y) * 13 + Math.round(r.width) * 3 + Math.round(r.height)) % 1000000007;
                }
                resolve(s);
              }),
            ),
          ),
      )
      .catch(() => null);
    if (sig !== null && sig === last) return true;
    last = sig;
    await page.waitForTimeout(250);
  }
  return false;
}

/** Wait until no loading placeholder is visible in the viewport. Returns false on timeout. */
async function waitForContent(page, selector, timeout) {
  if (!selector || timeout <= 0) return true;
  try {
    await page.waitForFunction(
      (sel) => {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && getComputedStyle(el).visibility !== "hidden") return false;
        }
        return true;
      },
      selector,
      { timeout, polling: 300 },
    );
    return true;
  } catch {
    return false;
  }
}

async function runStep(page, step, base, timeout) {
  if (typeof step === "function") return step(page);
  const t = Math.min(timeout, 20000);
  // The first VISIBLE match: a hidden duplicate earlier in the DOM (a mobile
  // drawer's copy, an offscreen field) must not stall the step.
  const loc = (sel, visibleOnly = !step.force) => {
    const all = page.locator(sel);
    const l = visibleOnly ? all.filter({ visible: true }) : all;
    return step.nth === undefined ? l.first() : l.nth(step.nth);
  };
  const run = async () => {
    if (step.click) return loc(step.click).click({ timeout: t, button: step.button || "left", position: step.position, force: !!step.force });
    if (step.dblclick) return loc(step.dblclick).dblclick({ timeout: t });
    if (step.rightclick) return loc(step.rightclick).click({ timeout: t, button: "right" });
    if (step.hover) return loc(step.hover).hover({ timeout: t, force: !!step.force });
    if (step.focus) return loc(step.focus).focus({ timeout: t });
    if (step.press) return step.on ? loc(step.on).press(step.press, { timeout: t }) : page.keyboard.press(step.press);
    if (step.fill) {
      const [sel, text] = Array.isArray(step.fill) ? step.fill : [step.fill, step.text || ""];
      return loc(sel).fill(text, { timeout: t });
    }
    if (step.type) {
      const [sel, text] = Array.isArray(step.type) ? step.type : [step.type, step.text || ""];
      return loc(sel).pressSequentially(text, { timeout: t });
    }
    if (step.wait !== undefined) return page.waitForTimeout(Number(step.wait));
    // Waits may sit behind a first compile of the next page: allow them longer than a click.
    if (step.waitFor) return loc(step.waitFor).waitFor({ state: "visible", timeout: Math.max(t, Math.min(timeout, 120000)) });
    if (step.waitForHidden) return loc(step.waitForHidden, false).waitFor({ state: "hidden", timeout: t });
    if (step.waitForUrl) return page.waitForURL(new RegExp(step.waitForUrl), { timeout: Math.max(t, Math.min(timeout, 120000)) });
    if (step.scroll) {
      const { selector, x = 0, y = 0 } = typeof step.scroll === "object" ? step.scroll : { y: Number(step.scroll) };
      return page.evaluate(
        ({ selector, x, y }) => {
          const el = selector ? document.querySelector(selector) : document.scrollingElement;
          if (el) el.scrollTo(x, y);
        },
        { selector, x, y },
      );
    }
    if (step.eval) return page.evaluate(step.eval);
    if (step.goto) return page.goto(new URL(step.goto, base).href, { timeout, waitUntil: "domcontentloaded" });
    throw new Error(`Unknown open step ${JSON.stringify(step)}`);
  };
  try {
    await run();
  } catch (err) {
    if (!step.optional) throw err;
  }
}

// A server restart mid-load leaves a page that never hydrates or never shows
// its selector, so timeouts are retried too (once the server answers again).
const TRANSIENT = /rendered almost nothing|script chunk failed to load|Timeout \d+ms exceeded|rendered an error page|rendered the Next\.js error overlay|ERR_EMPTY_RESPONSE|ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ECONNREFUSED|ECONNRESET|ERR_ABORTED|ERR_NETWORK_CHANGED|socket hang up|net::ERR_FAILED|Navigation failed because page crashed|Execution context was destroyed/;

/**
 * Poll until the server answers anything at all (the shared dev server restarts
 * itself). With `steadyMs`, every poll over that long must answer: a server
 * being stopped keeps answering for a few seconds, and a retry sent then is
 * refused at once, which used to burn every retry in half a minute.
 */
async function waitForServer(base, maxMs, steadyMs = 0) {
  const until = Date.now() + maxMs;
  let upSince = null;
  while (Date.now() < until) {
    let up = false;
    try {
      const res = await fetch(new URL("/robots.txt", base), { signal: AbortSignal.timeout(15000) });
      await res.arrayBuffer().catch(() => {});
      up = true;
    } catch {
      /* down, or restarting */
    }
    if (up) {
      upSince ??= Date.now();
      if (Date.now() - upSince >= steadyMs) return true;
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      upSince = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}

async function measureWithRetry(browserCtx, route, args, ctxBase, outDir, session = null) {
  let result;
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    // A retry always loads the page afresh.
    result = await measureRoute(browserCtx, route, args, ctxBase, outDir, attempt === 0 ? session : null);
    if (!result.error || !TRANSIENT.test(result.error) || attempt === args.retries) break;
    // Backing off (10, 20, 40, then 60 s of steady answers) spreads the
    // attempts past a burst of restarts or of recompiles of other people's edits.
    const steady = Math.min(60000, 10000 * 2 ** attempt);
    console.error(`  ${route.name}: ${result.error.slice(0, 80)} · waiting for ${steady / 1000} s of steady answers, then retrying`);
    await waitForServer(args.base, args.timeout, steady);
  }
  return result;
}

/** Run the pure analysis and copy it into a route result. Returns the offenders. */
function fillAnalysis(result, records, ctx, args) {
  const analysis = analyzeRoute(records, ctx);
  const ref = (i) => refOf(records[i]);
  result.elements = analysis.elements;
  result.score = analysis.score;
  result.counts = analysis.counts;
  result.scale = analysis.scale;
  result.histograms = analysis.histograms;
  result.offScale = analysis.offScale.map((o) => ({ ...o, examples: o.examples.map(ref) }));
  result.violations = analysis.findings.map((f) => ({ kind: f.kind, severity: f.severity, magnitude: f.magnitude, message: f.message, el: ref(f.el), related: f.related.map(ref), values: f.values }));
  result.notes = analysis.notes.slice(0, 300).map((n) => ({ kind: n.kind, reason: n.reason, el: ref(n.el), values: n.values }));
  const offenders = pickOffenders(analysis, args.top, records).map((f, k) => ({ n: k + 1, kind: f.kind, severity: f.severity, magnitude: f.magnitude, message: f.message, el: ref(f.el) }));
  result.offenders = offenders;
  return offenders;
}

function overlayItems(offenders) {
  return offenders.map((o) => ({ n: o.n, kind: o.kind, rect: o.el.rect, color: (KIND_COLORS[o.kind] || ["#111"])[0] }));
}

/** Draw the outlines onto a saved clean screenshot (no app server needed). */
async function annotateOffline(browser, cleanPath, outPath, items, vp) {
  // The shot's pixel ratio is its own width over the CSS viewport width (PNG IHDR width at byte 16).
  const png = fs.readFileSync(cleanPath);
  const dpr = Math.max(1, Math.round((png.readUInt32BE(16) / vp.width) * 100) / 100);
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr });
  try {
    const page = await ctx.newPage();
    const b64 = png.toString("base64");
    await page.setContent(`<!doctype html><html><body style="margin:0;overflow:hidden"><img id="shot" src="data:image/png;base64,${b64}" style="display:block"></body></html>`);
    const size = await page.evaluate(async (ratio) => {
      const img = document.getElementById("shot");
      await img.decode();
      img.style.width = `${img.naturalWidth / ratio}px`;
      return { width: img.naturalWidth / ratio, height: img.naturalHeight / ratio };
    }, dpr);
    await page.evaluate(drawOverlay, { items, fixed: false });
    // Outlines of boxes that run past the fold must not grow the image.
    await page.screenshot({ path: outPath, fullPage: true, clip: { x: 0, y: 0, width: size.width, height: size.height } });
  } finally {
    await ctx.close();
  }
}

async function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    return require(path.join(REPO, "node_modules", "playwright"));
  }
}

/**
 * Re-score one saved route from its raw records with the current rules and
 * redraw its outlines on its clean screenshot. Returns null when the route
 * has no raw records to work from.
 */
async function reanalyzeRoute(old, from, outDir, args, scales, tolerances, fallbackViewport, getBrowser) {
  const rawPath = path.join(from, "raw", `${old.slug}.json`);
  if (!fs.existsSync(rawPath)) return null;
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  const vp = parseViewport(old.viewport || raw.viewportName || `${fallbackViewport.width}x${fallbackViewport.height}`);
  const ctx = makeContext({ scales, tolerances, viewport: vp });
  const result = {};
  for (const k of ["name", "slug", "path", "status", "finalPath", "viewport", "scope", "title", "hydrated", "truncated", "stillLoading"]) if (old[k] !== undefined) result[k] = old[k];
  // The same guard as a live run: a near-empty capture is a failed load, not a perfect page.
  const scoped = (old.scope || raw.scope || "page") !== "page";
  const minElements = scoped ? Math.min(3, Number(args["min-elements"])) : Number(args["min-elements"]);
  if (raw.records.length < minElements) return { ...result, error: `rendered almost nothing (${raw.records.length} elements; minElements ${minElements})` };
  const offenders = fillAnalysis(result, raw.records, ctx, args);
  if (from !== outDir) {
    fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
    fs.copyFileSync(rawPath, path.join(outDir, "raw", `${old.slug}.json`));
  }
  const clean = path.join(from, "shots", `${old.slug}.clean.png`);
  if (args.screenshots && fs.existsSync(clean)) {
    fs.mkdirSync(path.join(outDir, "shots"), { recursive: true });
    if (from !== outDir) fs.copyFileSync(clean, path.join(outDir, "shots", `${old.slug}.clean.png`));
    const rel = path.join("shots", `${old.slug}.png`);
    await annotateOffline(await getBrowser(), clean, path.join(outDir, rel), overlayItems(offenders), vp);
    result.screenshot = rel;
  }
  return result;
}

/** Re-score a saved run from its raw records with the current rules (no app server). */
async function reanalyze(args) {
  const from = path.resolve(args.reanalyze);
  const outDir = path.resolve(args.out || from);
  const previous = JSON.parse(fs.readFileSync(path.join(from, "geometry.json"), "utf8"));
  const { scales, tolerances, radiusSource } = loadScales(args);
  const meta = { ...previous.meta, scales, radiusSource, tolerances: { ...DEFAULT_TOLERANCES, ...tolerances } };
  fs.mkdirSync(outDir, { recursive: true });
  let browser = null;
  const getBrowser = async () => (browser ||= await launch((await loadPlaywright()).chromium, args));
  const routeResults = [];
  try {
    for (const old of previous.routes) {
      const result = await reanalyzeRoute(old, from, outDir, args, scales, tolerances, meta.viewport, getBrowser);
      if (!result) {
        routeResults.push({ name: old.name, slug: old.slug, path: old.path, error: old.error || "no raw records saved (the run used --no-raw)" });
        continue;
      }
      routeResults.push(result);
      console.error(`reanalyzed ${old.name} · ${result.error ? `FAILED ${result.error}` : `score ${result.score.score} · ${result.counts.violations} violations`}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return { meta, routeResults, outDir };
}

/** Pages are kept between routes on the same path, signed-in state and viewport. */
function sessionKey(route, vp) {
  return `${route.auth === false ? "out" : "in"}|${vp.width}x${vp.height}|${route.path}`;
}

/**
 * Bring a kept page back to how it loaded: close what the last route opened
 * (Escape), drop focus and hover, and check that <body> holds exactly the
 * visible layers it held after load and that the URL has not moved. False
 * when it cannot: the caller then loads the page afresh.
 */
async function resetPage(page, routePath) {
  const clean = () =>
    page
      .evaluate((wanted) => {
        const home = window.__geometryHome;
        if (!home) return false;
        const want = new URL(wanted, location.href);
        if (location.pathname + location.search !== want.pathname + want.search) return false;
        const shown = (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        const extra = [...document.body.children].filter((e) => !home.has(e) && shown(e));
        return extra.length === 0 && [...home].every((e) => e.isConnected);
      }, routePath)
      .catch(() => false);
  await page.evaluate(() => document.getElementById("__geometry_overlay")?.remove()).catch(() => {});
  let ok = await clean();
  for (let k = 0; k < 3 && !ok; k++) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    ok = await clean();
  }
  if (!ok) return false;
  await page.evaluate(() => document.activeElement && document.activeElement !== document.body && document.activeElement.blur?.()).catch(() => {});
  await page.mouse.move(0, 0).catch(() => {});
  await settle(page);
  return clean();
}

async function measureRoute(browserCtx, route, args, ctxBase, outDir, session = null) {
  const vp = route.viewport ? parseViewport(route.viewport) : ctxBase.viewport;
  const key = sessionKey(route, vp);
  const result = { name: route.name, slug: route.slug, path: route.path };
  const started = Date.now();
  // A page the previous route on this path left open (it only opened menus or
  // dialogs) is reset and reused: on the shared dev server a fresh load of
  // /chat costs minutes, and its eight menus would pay it eight times.
  let page = null;
  if (session?.page && session.key === key && !session.page.isClosed()) {
    page = session.page;
    session.page = null;
    if (!(await resetPage(page, route.path))) {
      await page.close().catch(() => {});
      page = null;
    }
  } else if (session?.page) {
    await session.page.close().catch(() => {});
    session.page = null;
  }
  const reused = !!page;
  if (!page) {
    page = await browserCtx.newPage();
    const fresh = { chunkFailure: null, errors: [] };
    page.__geometry = fresh;
    // Kept so an error screen says what broke it (a chunk that timed out, a render error).
    // Kept so an error screen says what broke it (a lazy chunk that failed, a
    // render error). An uncaught error alone does not fail the route: the
    // agent thread's announcement-popup chunk failed on every load without
    // touching the view, and a chunk that does break the view shows its error
    // boundary, which the error-screen check catches.
    page.on("pageerror", (err) => {
      if (fresh.errors.length < 5) fresh.errors.push(String(err?.message || err).split("\n")[0].slice(0, 200));
    });
    const onChunk = (url, why) => {
      // Connection-level failures and 5xx only: a cancelled prefetch (ERR_ABORTED) is not a restart.
      // NETWORK_CHANGED: Chromium drops every open connection when the host's
      // network interfaces change (another job starting a container).
      if (!fresh.chunkFailure && /\/_next\/static\//.test(url) && /REFUSED|RESET|EMPTY_RESPONSE|CLOSED|NETWORK_CHANGED|HTTP 5/.test(why)) fresh.chunkFailure = `script chunk failed to load (${why}): the server restarted or the connection dropped mid-load`;
    };
    page.on("requestfailed", (req) => onChunk(req.url(), req.failure()?.errorText || "failed"));
    page.on("response", (res) => {
      if (res.status() >= 500) onChunk(res.url(), `HTTP ${res.status()}`);
    });
  }
  const state = page.__geometry;
  let keep = false;
  try {
    let ready = true;
    if (!reused) {
      const url = new URL(route.path, args.base).href;
      const resp = await page.goto(url, { timeout: args.timeout, waitUntil: "domcontentloaded" });
      state.status = resp ? resp.status() : null;
      await page.waitForLoadState("load", { timeout: args.timeout }).catch(() => {});
      const final = new URL(page.url());
      state.finalPath = final.pathname + final.search;
      if (final.pathname.startsWith("/sign-in") && !route.path.startsWith("/sign-in")) {
        throw new Error(`redirected to ${final.pathname}: the storage state is signed out (refresh it, then rerun)`);
      }
      // Measuring server HTML before React hydrates gives a different page (no
      // client-only UI, no component names), so a page that never hydrates fails
      // and is retried. Routes that are not React pages set "hydrate": false.
      if (route.hydrate !== false && !(await waitForHydration(page, args.timeout, () => state.chunkFailure))) {
        throw new Error(`never hydrated (Timeout ${args.timeout}ms exceeded waiting for React)`);
      }
      result.loadMs = Date.now() - started;
      await page.addStyleTag({ content: STILL_CSS }).catch(() => {});
      if (route.waitFor) await page.locator(route.waitFor).filter({ visible: true }).first().waitFor({ state: "visible", timeout: Math.min(args.timeout, 60000) });
      ready = await waitForContent(page, args.busy, args["busy-timeout"]);
      await settle(page);
      await page.evaluate(() => (window.__geometryHome = new Set(document.body.children)));
      state.ready = ready;
    } else {
      result.loadMs = 0;
      result.reusedPage = true;
      if (route.waitFor) await page.locator(route.waitFor).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 20000 });
      ready = state.ready !== false;
    }
    result.status = state.status;
    result.finalPath = state.finalPath;
    // Steps marked "when": "phone" or "desktop" run only at that width.
    const open = (typeof route.open === "function" ? [route.open] : route.open).filter((step) => appliesAt(step, isPhoneViewport(vp)));
    // Remember what <body> held before the open script: the layers it adds
    // (menus, popovers, dialogs) are what an "open" route measures by default.
    if (open.length) await page.evaluate(() => (window.__geometryBase = new Set(document.body.children)));
    for (const step of open) await runStep(page, step, args.base, args.timeout);
    if (open.length) {
      // A menu or popover fetches its own content when it opens (the
      // notifications list): it gets the same wait as the page.
      ready = (await waitForContent(page, args.busy, args["busy-timeout"])) && ready;
      await settle(page);
    }
    if (state.chunkFailure) throw new Error(state.chunkFailure);
    if (!ready) result.stillLoading = true;

    // An error boundary renders with HTTP 200; never score an error screen.
    const errorShown = await page.evaluate((pattern) => {
      const re = new RegExp(pattern, "i");
      // Headings, and the titles of status and alert panels: a menu or panel
      // that failed to load ("Couldn’t load notifications") is an error state too.
      const shown = (h) => {
        const r = h.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const textOf = (h) => (h.textContent || "").trim().replace(/\s+/g, " ");
      const page = [...document.querySelectorAll("h1, h2")].filter(shown).map(textOf).find((t) => re.test(t));
      if (page) return { kind: "page", message: `rendered an error page: "${page}"` };
      const portal = document.querySelector("nextjs-portal");
      const overlay = portal && portal.shadowRoot && portal.shadowRoot.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-overlay]");
      if (overlay) return { kind: "page", message: "rendered the Next.js error overlay" };
      const panel = [...document.querySelectorAll("[role=status], [role=alert]")]
        .map((e) => e.querySelector("h1, h2, h3, p, strong") || e)
        .filter(shown)
        .map(textOf)
        .find((t) => re.test(t));
      return panel ? { kind: "panel", message: `rendered an error page: "${panel}"` } : null;
    }, args["error-text"]);
    // "allowError": true accepts any error state; "panels" (the /dev galleries,
    // which show error panels on purpose) still fails on a page-level error.
    const accepted = route.allowError === true || (route.allowError === "panels" && errorShown?.kind === "panel");
    if (errorShown && !accepted) throw new Error(`${errorShown.message}${state.errors.length ? ` after: ${state.errors[0]}` : ""}`);

    result.viewport = `${vp.width}x${vp.height}`;
    const ctx = makeContext({ scales: ctxBase.scales, tolerances: ctxBase.tolerances, viewport: vp });
    const target = ctx.phone ? ctx.tol.targetTouch : ctx.tol.targetPointer;
    const scope = route.scope === "page" ? null : route.scope || (open.length ? "new" : null);
    const collected = await page.evaluate(collectGeometry, { full: !!args.full, scope, targetSize: target, busy: args.busy });
    result.scope = collected.scope;
    result.title = collected.title;
    result.hydrated = collected.hydrated;
    result.truncated = collected.truncated;
    const records = collected.records;
    // A blank or half-torn-down page (the server restarted under it) must not
    // be scored as a perfect page: too few boxes is a failed load.
    const minElements = route.minElements ?? (collected.scope === "page" ? Number(args["min-elements"]) : Math.min(3, Number(args["min-elements"])));
    if (records.length < minElements) throw new Error(`rendered almost nothing (${records.length} elements; minElements ${minElements})`);
    const offenders = fillAnalysis(result, records, ctx, args);

    // The raw records and a clean screenshot let --reanalyze re-score this
    // run with new rules or tolerances, and redraw the outlines, offline.
    if (args.raw) {
      fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
      const meta = { ...collected };
      delete meta.records;
      // stillLoading travels with the records, so a run resumed from raw files
      // alone (no geometry.json) still knows the capture was half-loaded.
      fs.writeFileSync(path.join(outDir, "raw", `${route.slug}.json`), JSON.stringify({ ...meta, viewportName: result.viewport, ...(result.stillLoading ? { stillLoading: true } : {}), records }));
    }
    if (args.screenshots) {
      fs.mkdirSync(path.join(outDir, "shots"), { recursive: true });
      const shot = { fullPage: !!args.full, animations: "disabled", caret: "hide" };
      if (args.raw) await page.screenshot({ ...shot, path: path.join(outDir, "shots", `${route.slug}.clean.png`) });
      await page.evaluate(drawOverlay, { items: overlayItems(offenders), fixed: !args.full });
      const rel = path.join("shots", `${route.slug}.png`);
      await page.screenshot({ ...shot, path: path.join(outDir, rel) });
      result.screenshot = rel;
    }
    // Only a page whose route opened layers (scope "new") or nothing at all is
    // kept: a scrolled or navigated page is not the page the next route expects.
    keep = !!session && (!open.length || (collected.scope !== "page" && !route.scope));
  } catch (err) {
    result.error = String(err?.message || err).split("\n")[0];
  } finally {
    if (keep) {
      session.page = page;
      session.key = key;
    } else await page.close().catch(() => {});
  }
  result.ms = Date.now() - started;
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(src.slice(src.indexOf("/**") + 3, src.indexOf("*/")).replace(/^ \* ?/gm, ""));
    return;
  }
  if (args.reanalyze) {
    const { meta, routeResults, outDir } = await reanalyze(args);
    writeRun(meta, routeResults, outDir, args);
    return;
  }
  if (!args.out) throw new Error("--out <dir> is required");
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const viewport = parseViewport(args.viewport);
  const phone = isPhoneViewport(viewport);
  const { scales, tolerances, radiusSource } = loadScales(args);
  let routes = await loadRoutes(args.routes);
  if (args.only) routes = routes.filter((r) => r.name.includes(args.only) || r.path.includes(args.only));
  // Routes marked "when": "phone" or "desktop" are measured only at that width.
  routes = routes.filter((r) => appliesAt(r, isPhoneViewport(r.viewport ? parseViewport(r.viewport) : viewport)));
  if (!routes.length) throw new Error("No routes to measure");
  if (args.state && !fs.existsSync(args.state)) throw new Error(`No storage state at ${args.state}`);

  const playwright = await loadPlaywright();
  if (!(await waitForServer(args.base, args.timeout))) throw new Error(`${args.base} does not answer`);
  let browser = await launch(playwright.chromium, args);
  const contexts = new Map();
  // A browser that died (out of memory) is relaunched; its contexts go with it.
  let relaunching = null;
  const ensureBrowser = async () => {
    if (browser.isConnected()) return;
    relaunching ||= (async () => {
      console.error("geometry-audit: the browser went away; relaunching it");
      contexts.clear();
      browser = await launch(playwright.chromium, args);
    })().finally(() => (relaunching = null));
    await relaunching;
  };
  const contextFor = async (auth, vp) => {
    const key = `${auth ? "in" : "out"}|${vp.width}x${vp.height}`;
    if (!contexts.has(key)) {
      const small = isPhoneViewport(vp);
      contexts.set(
        key,
        browser
          .newContext({
            viewport: vp,
            deviceScaleFactor: small ? 2 : 1,
            isMobile: small,
            hasTouch: small,
            colorScheme: args.scheme,
            locale: "en-US",
            timezoneId: "UTC",
            storageState: auth && args.state ? args.state : undefined,
          })
          .then(async (c) => {
            // Other people's edits must not hot-reload the page mid-measurement:
            // the dev server's HMR socket is answered by a silent mock.
            if (typeof c.routeWebSocket === "function") await c.routeWebSocket(/\/_next\/webpack-hmr/, () => {});
            // next-themes reads localStorage before the media query: pin it.
            await c.addInitScript((scheme) => {
              try {
                localStorage.setItem("theme", scheme);
              } catch {
                /* storage may be unavailable on error pages */
              }
            }, args.scheme);
            return c;
          }),
      );
    }
    return contexts.get(key);
  };

  const ctxBase = { scales, tolerances, viewport };
  const runMeta = () => ({
    tool: "scripts/design-audit/geometry-audit.mjs",
    version: 1,
    base: args.base,
    scheme: args.scheme,
    viewport,
    phone,
    full: !!args.full,
    scales,
    radiusSource,
    tolerances: { ...DEFAULT_TOLERANCES, ...tolerances },
  });
  // --resume: routes the run in --out already measured (and saved raw records
  // for) are re-scored from those records; only the rest are measured again.
  const resumeFrom = new Map();
  if (args.resume) {
    const redo = args.redo ? String(args.redo).split(",").map((t) => t.trim()).filter(Boolean) : [];
    const keep = (name) => !redo.some((t) => t !== "@loading" && name.includes(t));
    const redoLoading = redo.includes("@loading");
    if (fs.existsSync(path.join(outDir, "geometry.json"))) {
      for (const r of JSON.parse(fs.readFileSync(path.join(outDir, "geometry.json"), "utf8")).routes || []) {
        if (r.score && keep(r.name) && !(redoLoading && r.stillLoading)) resumeFrom.set(r.name, r);
      }
    }
    // A run stopped before it wrote geometry.json still left raw records behind.
    for (const route of routes) {
      const rawPath = path.join(outDir, "raw", `${route.slug}.json`);
      if (resumeFrom.has(route.name) || !keep(route.name) || !fs.existsSync(rawPath)) continue;
      const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
      // A half-loaded capture is redone; so is one whose loading state is unknown (saved before the flag was).
      if (redoLoading && (raw.stillLoading || fs.existsSync(path.join(outDir, "geometry.json")))) continue;
      resumeFrom.set(route.name, { name: route.name, slug: route.slug, path: route.path, viewport: raw.viewportName, scope: raw.scope, title: raw.title, hydrated: raw.hydrated, truncated: raw.truncated, ...(raw.stillLoading ? { stillLoading: true } : {}) });
    }
    console.error(`geometry-audit: resuming, ${resumeFrom.size} routes kept from ${outDir}`);
  }
  const results = new Array(routes.length);
  // Written after every route, so an interrupted run can be picked up with --resume.
  const writeProgress = () => {
    try {
      writeRun(runMeta(), results.filter(Boolean).map(stripTimings), outDir, args, true);
    } catch (err) {
      console.error(`geometry-audit: could not write progress: ${err?.message || err}`);
    }
  };
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  const worker = async () => {
    // Each worker keeps its last page for the next route on the same path.
    const session = { page: null, key: null };
    try {
      await work(session);
    } finally {
      if (session.page) await session.page.close().catch(() => {});
    }
  };
  const work = async (session) => {
    while (next < routes.length) {
      const k = next++;
      const route = routes[k];
      const vp = route.viewport ? parseViewport(route.viewport) : viewport;
      const kept = resumeFrom.get(route.name);
      if (kept) {
        const r = await reanalyzeRoute(kept, outDir, outDir, args, scales, tolerances, viewport, async () => browser);
        if (r && !r.error) {
          results[k] = { ...r, ms: 0 };
          done++;
          console.error(`[${done}/${routes.length}] ${route.name} · kept from the previous run · score ${r.score.score}`);
          continue;
        }
      }
      await ensureBrowser();
      const bctx = await contextFor(route.auth !== false, vp);
      if (session.page && (session.page.context() !== bctx || session.page.isClosed())) session.page = null;
      const r = await measureWithRetry(bctx, route, args, ctxBase, outDir, session);
      results[k] = r;
      done++;
      writeProgress();
      const tail = r.error ? `FAILED ${r.error}` : `${r.elements} elements · score ${r.score.score} · ${r.counts.violations} violations`;
      const split = r.reusedPage ? " (on the page the last route loaded)" : r.loadMs !== undefined ? ` (load ${(r.loadMs / 1000).toFixed(1)}s, open+measure ${((r.ms - r.loadMs) / 1000).toFixed(1)}s)` : "";
      console.error(`[${done}/${routes.length}] ${route.name} · ${tail} · ${(r.ms / 1000).toFixed(1)}s${split}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(args.concurrency, routes.length) }, worker));
  } finally {
    for (const c of contexts.values()) await (await c).close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const site = writeRun(runMeta(), results.map(stripTimings), outDir, args);
  console.error(`geometry-audit: ${site.measured}/${site.routes} routes in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

/** Timings stay out of geometry.json so two runs of an unchanged page are identical. */
function stripTimings(r) {
  const rest = { ...r };
  delete rest.ms;
  delete rest.loadMs;
  delete rest.reusedPage;
  return rest;
}

/** Aggregate, compare, and write geometry.json and report.md. */
function writeRun(meta, routeResults, outDir, args, quiet = false) {
  const site = aggregateSite(routeResults.map((r) => (r.score ? { name: r.name, analysis: { elements: r.elements, counts: r.counts, scale: r.scale, score: r.score, histograms: r.histograms, offScale: r.offScale } } : { name: r.name })));
  const run = { meta, site, routes: routeResults };
  let compare = null;
  if (args.compare) {
    compare = compareRuns(JSON.parse(fs.readFileSync(args.compare, "utf8")), run);
    run.compare = compare;
  }
  fs.writeFileSync(path.join(outDir, "geometry.json"), JSON.stringify(run, null, 1));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(run, { compare }));
  if (quiet) return site;
  console.error(`geometry-audit: site score ${site.score ?? "n/a"} (on scale ${site.scaleShare ?? "-"}%, clean ${site.cleanShare ?? "-"}%), ${site.violations} violations`);
  console.error(`geometry-audit: wrote ${path.join(outDir, "report.md")}`);
  if (site.failed) process.exitCode = 2;
  return site;
}

main().catch((err) => {
  console.error(`geometry-audit: ${process.env.GEOMETRY_DEBUG ? err?.stack || err : err?.message || err}`);
  process.exit(1);
});
