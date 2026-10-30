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
 *   --raw                        also write every element record (raw/<route>.json)
 *   --no-screenshots             skip the annotated screenshots
 *   --timeout <ms>               navigation timeout (default 180000; the dev server compiles on first hit)
 *   --retries <n>                retries after a dropped connection, once the server answers again (default 2)
 *   --chromium <path>            a Chromium executable, when Playwright's own is missing
 *   --busy <selector>            loading placeholders to wait out before measuring
 *                                (default '.skeleton, [aria-busy="true"], [data-skeleton]')
 *   --busy-timeout <ms>          how long to wait for them (default 30000); a route still loading is marked
 *   --error-text <regex>         an h1/h2 matching this marks an error screen (the route fails, is retried once
 *                                the server answers, and is never scored); routes may set "allowError": true
 *
 * A route is a path, or an object:
 *   { "name": "chat · model menu", "path": "/chat", "auth": true,
 *     "waitFor": "main textarea",
 *     "open": [ { "click": "button[aria-haspopup=menu][aria-label*=Model]" }, { "waitFor": "[role=menu]" } ],
 *     "scope": null, "viewport": "390x844" }
 * Open steps: click, dblclick, hover, focus, press, fill, type, wait (ms),
 * waitFor, waitForHidden, scroll, eval, goto. Each step takes an optional
 * "nth" (which match) and "optional": true (a miss is not an error). A .mjs
 * routes module may give `open` as an async function (page) => {}.
 *
 * Outputs in --out: geometry.json, report.md, shots/<route>.png (annotated).
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
  DEFAULT_ICON_SIZES,
  DEFAULT_SPACING_SCALE,
  DEFAULT_TOLERANCES,
  FALLBACK_RADIUS_SCALE,
  aggregateSite,
  analyzeRoute,
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

function parseArgs(argv) {
  const args = {
    base: "http://localhost:3000",
    scheme: "light",
    viewport: "1440x900",
    concurrency: 2,
    top: 20,
    timeout: 180000,
    retries: 2,
    screenshots: true,
    busy: '.skeleton, [aria-busy="true"], [data-skeleton]',
    "busy-timeout": 30000,
    "error-text": "^(Something went wrong|This page could not be found\\.?|Page not found|Application error.*|Unhandled Runtime Error|Build Error|Failed to compile)$",
  };
  const flags = new Set(["full", "raw", "no-screenshots", "help"]);
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
    const name = a.slice(2);
    if (flags.has(name)) {
      if (name === "no-screenshots") args.screenshots = false;
      else args[name] = true;
      continue;
    }
    const value = argv[++k];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    args[name] = value;
  }
  args.concurrency = Math.max(1, Number(args.concurrency) || 1);
  args.top = Math.max(0, Number(args.top) || 0);
  args.timeout = Number(args.timeout) || 180000;
  args.retries = Math.max(0, Number(args.retries ?? 2));
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
      radiusSource = "read from tailwind.config.ts borderRadius";
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

async function waitForHydration(page, timeout) {
  await page
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
    .catch(() => {});
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
  const loc = (sel) => {
    const l = page.locator(sel);
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
    if (step.waitFor) return loc(step.waitFor).waitFor({ state: "visible", timeout: t });
    if (step.waitForHidden) return loc(step.waitForHidden).waitFor({ state: "hidden", timeout: t });
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
const TRANSIENT = /Timeout \d+ms exceeded|rendered an error page: "Something went wrong"|rendered the Next\.js error overlay|ERR_EMPTY_RESPONSE|ERR_CONNECTION_(REFUSED|RESET|CLOSED)|ECONNREFUSED|ECONNRESET|ERR_ABORTED|ERR_NETWORK_CHANGED|socket hang up|net::ERR_FAILED|Navigation failed because page crashed|Execution context was destroyed/;

/** Poll until the server answers anything at all (the shared dev server restarts itself). */
async function waitForServer(base, maxMs) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(new URL("/robots.txt", base), { signal: AbortSignal.timeout(15000) });
      await res.arrayBuffer().catch(() => {});
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}

async function measureWithRetry(browserCtx, route, args, ctxBase, outDir) {
  let result;
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    result = await measureRoute(browserCtx, route, args, ctxBase, outDir);
    if (!result.error || !TRANSIENT.test(result.error) || attempt === args.retries) break;
    console.error(`  ${route.name}: ${result.error.slice(0, 80)} · waiting for the server, then retrying`);
    await waitForServer(args.base, args.timeout);
  }
  return result;
}

async function measureRoute(browserCtx, route, args, ctxBase, outDir) {
  const page = await browserCtx.newPage();
  const result = { name: route.name, slug: route.slug, path: route.path };
  const started = Date.now();
  try {
    const url = new URL(route.path, args.base).href;
    const resp = await page.goto(url, { timeout: args.timeout, waitUntil: "domcontentloaded" });
    result.status = resp ? resp.status() : null;
    await page.waitForLoadState("load", { timeout: args.timeout }).catch(() => {});
    const final = new URL(page.url());
    result.finalPath = final.pathname + final.search;
    if (final.pathname.startsWith("/sign-in") && !route.path.startsWith("/sign-in")) {
      throw new Error(`redirected to ${final.pathname}: the storage state is signed out (refresh it, then rerun)`);
    }
    await waitForHydration(page, 30000);
    result.loadMs = Date.now() - started;
    await page.addStyleTag({ content: STILL_CSS }).catch(() => {});
    if (route.waitFor) await page.locator(route.waitFor).first().waitFor({ state: "visible", timeout: Math.min(args.timeout, 60000) });
    let ready = await waitForContent(page, args.busy, args["busy-timeout"]);
    await settle(page);
    const open = typeof route.open === "function" ? [route.open] : route.open;
    for (const step of open) await runStep(page, step, args.base, args.timeout);
    if (open.length) {
      ready = (await waitForContent(page, args.busy, Math.min(args["busy-timeout"], 10000))) && ready;
      await settle(page);
    }
    if (!ready) result.stillLoading = true;

    // An error boundary renders with HTTP 200; never score an error screen.
    const errorShown = await page.evaluate((pattern) => {
      const re = new RegExp(pattern, "i");
      const heads = [...document.querySelectorAll("h1, h2")].map((h) => (h.textContent || "").trim()).filter(Boolean);
      const hit = heads.find((t) => re.test(t));
      const portal = document.querySelector("nextjs-portal");
      const overlay = portal && portal.shadowRoot && portal.shadowRoot.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-overlay]");
      if (hit) return `rendered an error page: "${hit}"`;
      return overlay ? "rendered the Next.js error overlay" : null;
    }, args["error-text"]);
    if (errorShown && !route.allowError) throw new Error(errorShown);

    const vp = route.viewport ? parseViewport(route.viewport) : ctxBase.viewport;
    result.viewport = `${vp.width}x${vp.height}`;
    const ctx = makeContext({ scales: ctxBase.scales, tolerances: ctxBase.tolerances, viewport: vp });
    const target = ctx.phone ? ctx.tol.targetTouch : ctx.tol.targetPointer;
    const collected = await page.evaluate(collectGeometry, { full: !!args.full, scope: route.scope || null, targetSize: target });
    const records = collected.records;
    const analysis = analyzeRoute(records, ctx);
    const ref = (i) => refOf(records[i]);

    result.title = collected.title;
    result.hydrated = collected.hydrated;
    result.truncated = collected.truncated;
    result.elements = analysis.elements;
    result.score = analysis.score;
    result.counts = analysis.counts;
    result.scale = analysis.scale;
    result.histograms = analysis.histograms;
    result.offScale = analysis.offScale.map((o) => ({ ...o, examples: o.examples.map(ref) }));
    result.violations = analysis.findings.map((f) => ({ kind: f.kind, severity: f.severity, magnitude: f.magnitude, message: f.message, el: ref(f.el), related: f.related.map(ref), values: f.values }));
    result.notes = analysis.notes.slice(0, 300).map((n) => ({ kind: n.kind, reason: n.reason, el: ref(n.el), values: n.values }));
    const offenders = pickOffenders(analysis, args.top).map((f, k) => ({ n: k + 1, kind: f.kind, severity: f.severity, magnitude: f.magnitude, message: f.message, el: ref(f.el) }));
    result.offenders = offenders;

    if (args.screenshots) {
      fs.mkdirSync(path.join(outDir, "shots"), { recursive: true });
      const items = offenders.map((o) => ({ n: o.n, kind: o.kind, rect: o.el.rect }));
      await page.evaluate(drawOverlay, { items, fixed: !args.full });
      const rel = path.join("shots", `${route.slug}.png`);
      await page.screenshot({ path: path.join(outDir, rel), fullPage: !!args.full, animations: "disabled", caret: "hide" });
      result.screenshot = rel;
    }
    if (args.raw) {
      fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
      fs.writeFileSync(path.join(outDir, "raw", `${route.slug}.json`), JSON.stringify(records));
    }
  } catch (err) {
    result.error = String(err?.message || err).split("\n")[0];
  } finally {
    await page.close().catch(() => {});
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
  if (!args.out) throw new Error("--out <dir> is required");
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const viewport = parseViewport(args.viewport);
  const phone = isPhoneViewport(viewport);
  const { scales, tolerances, radiusSource } = loadScales(args);
  let routes = await loadRoutes(args.routes);
  if (args.only) routes = routes.filter((r) => r.name.includes(args.only) || r.path.includes(args.only));
  if (!routes.length) throw new Error("No routes to measure");
  if (args.state && !fs.existsSync(args.state)) throw new Error(`No storage state at ${args.state}`);

  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    playwright = require(path.join(REPO, "node_modules", "playwright"));
  }
  if (!(await waitForServer(args.base, args.timeout))) throw new Error(`${args.base} does not answer`);
  const browser = await launch(playwright.chromium, args);
  const contexts = new Map();
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
  const results = new Array(routes.length);
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < routes.length) {
      const k = next++;
      const route = routes[k];
      const vp = route.viewport ? parseViewport(route.viewport) : viewport;
      const bctx = await contextFor(route.auth !== false, vp);
      const r = await measureWithRetry(bctx, route, args, ctxBase, outDir);
      results[k] = r;
      done++;
      const tail = r.error ? `FAILED ${r.error}` : `${r.elements} elements · score ${r.score.score} · ${r.counts.violations} violations`;
      const split = r.loadMs !== undefined ? ` (load ${(r.loadMs / 1000).toFixed(1)}s, open+measure ${((r.ms - r.loadMs) / 1000).toFixed(1)}s)` : "";
      console.error(`[${done}/${routes.length}] ${route.name} · ${tail} · ${(r.ms / 1000).toFixed(1)}s${split}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(args.concurrency, routes.length) }, worker));
  } finally {
    for (const c of contexts.values()) await (await c).close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // Timings stay out of geometry.json so two runs of an unchanged page are identical.
  const routeResults = results.map((r) => {
    const rest = { ...r };
    delete rest.ms;
    delete rest.loadMs;
    return rest;
  });
  const site = aggregateSite(routeResults.map((r) => (r.score ? { name: r.name, analysis: { elements: r.elements, counts: r.counts, scale: r.scale, score: r.score, histograms: r.histograms, offScale: r.offScale } } : { name: r.name })));
  const run = {
    meta: {
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
    },
    site,
    routes: routeResults,
  };
  let compare = null;
  if (args.compare) {
    compare = compareRuns(JSON.parse(fs.readFileSync(args.compare, "utf8")), run);
    run.compare = compare;
  }
  fs.writeFileSync(path.join(outDir, "geometry.json"), JSON.stringify(run, null, 1));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(run, { compare }));
  console.error(`geometry-audit: site score ${site.score ?? "n/a"} (on scale ${site.scaleShare ?? "-"}%, clean ${site.cleanShare ?? "-"}%), ${site.violations} violations, ${site.measured}/${site.routes} routes in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.error(`geometry-audit: wrote ${path.join(outDir, "report.md")}`);
  if (site.failed) process.exitCode = 2;
}

main().catch((err) => {
  console.error(`geometry-audit: ${err?.stack || err}`);
  process.exit(1);
});
