#!/usr/bin/env node
/**
 * Where the main thread goes while a reader scrolls a paged conversation back
 * to its first message (Workstream I follow-up, docs/rework/program/
 * PERFORMANCE.md "Paged history"). A CPU profile of the whole scroll, cut into
 * the page's long tasks (PerformanceObserver), attributed through the build's
 * source maps.
 *
 *   ALEVR_BUNDLE_SOURCEMAPS=1 next build && next start -p 3201
 *   node scripts/perf/profile-history-scroll.mjs --state <storage.json> [--profile remote] [--top 30]
 *
 * Prints, for the samples inside long tasks: self time by source file, self
 * time by function, and inclusive time for the frames named by --focus.
 *
 * Read with care: a forced style or layout is charged to whichever script read
 * it first (an icon's getComputedStyle, a getBoundingClientRect), so a large
 * self time there is often the cost of laying out rows that just mounted. A
 * DevTools trace (Layout and UpdateLayoutTree events) separates the two. That
 * is how the window bug in "Scroll-back long tasks" (PERFORMANCE.md) was found:
 * the profile blamed the icons; the trace showed each landing laying out twice
 * the rows it should.
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { SourceMapConsumer } from "source-map-js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://localhost:3201";
const PROFILE = args.profile ?? "remote";
const KEY = args.conversation ?? "perf-long-2000";
const EMAIL = process.env.E2E_EMAIL ?? "e2e@juno.test";
const TOP = Number(args.top ?? 30);
const root = path.join(process.cwd(), ".next");

const prisma = new PrismaClient();
const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
const conversation = await prisma.conversation.findUniqueOrThrow({ where: { userId_clientRequestId: { userId: user.id, clientRequestId: KEY } } });
await prisma.$disconnect();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, storageState: args.state });
await context.addInitScript(() => {
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
  } catch {}
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
if (PROFILE === "remote") {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 60, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 2 });
}
await page.goto(`${BASE}/chat/${conversation.id}`);
await page.waitForSelector("[data-transcript-key]");
await page.waitForTimeout(2500);

await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
const before = await page.evaluate(() => performance.now());
await cdp.send("Profiler.start");
const after = await page.evaluate(() => performance.now());
const scroller = page.locator('[aria-label="Conversation messages"]');
const box = await scroller.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let tick = 0; tick < 1500; tick++) {
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(16);
  const done = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Conversation messages"]');
    return el.scrollTop <= 0 && document.querySelector('[role="log"]')?.dataset.historyOlder !== "true";
  });
  if (done) break;
}
await page.waitForTimeout(1000);
const { profile } = await cdp.send("Profiler.stop");
const longTasks = (await page.evaluate(() => window.__longTasks)).filter(([start]) => start >= before);
await browser.close();

// Sample timeline: each sample's node and its time.
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const times = [];
let t = profile.startTime;
for (const d of profile.timeDeltas) { t += d; times.push(t); }
const idle = (id) => nodes.get(id).callFrame.functionName === "(idle)";

// The page's own long tasks, placed on the profile's clock. The profile
// starts between the two performance.now() reads around Profiler.start; the
// midpoint is within a few ms, against tasks of 50 ms and more.
const zero = profile.startTime - ((before + after) / 2) * 1000;
const tasks = [];
for (const [startMs, durationMs] of longTasks) {
  const from = zero + startMs * 1000;
  const to = from + durationMs * 1000;
  let a = times.findIndex((x) => x >= from);
  if (a < 0) continue;
  let b = a;
  while (b + 1 < times.length && times[b + 1] <= to) b++;
  tasks.push([a, b]);
}

// Source maps, loaded lazily per script.
const consumers = new Map();
function consumerFor(url) {
  if (consumers.has(url)) return consumers.get(url);
  let c = null;
  const m = /\/_next\/(static\/.+\.js)/.exec(url);
  if (m) {
    const mapPath = path.join(root, `${decodeURIComponent(m[1])}.map`);
    if (fs.existsSync(mapPath)) c = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapPath, "utf8")));
  }
  consumers.set(url, c);
  return c;
}
const clean = (source) =>
  source.replace(/^webpack:\/\/_N_E\//, "").replace(/^\.\//, "").replace(/\?.*$/, "").replace(/^.*node_modules\/((?:@[^/]+\/)?[^/]+).*$/, "npm:$1");
const frameName = new Map();
function describe(id) {
  if (frameName.has(id)) return frameName.get(id);
  const { callFrame: f } = nodes.get(id);
  let file = f.url ? f.url.replace(/^.*\/_next\//, "") : f.functionName;
  let fn = f.functionName || "(anonymous)";
  const c = f.url ? consumerFor(f.url) : null;
  if (c) {
    const pos = c.originalPositionFor({ line: f.lineNumber + 1, column: f.columnNumber });
    if (pos.source) {
      file = clean(pos.source);
      if (pos.name) fn = pos.name;
      fn = `${fn} (${file.replace(/^npm:/, "")}:${pos.line})`;
    }
  }
  const d = { file, fn };
  frameName.set(id, d);
  return d;
}

const selfByFile = new Map();
const selfByFn = new Map();
const inclusive = new Map();
const focus = (args.focus ?? "").split(",").filter(Boolean);
let busy = 0;
const add = (map, key, us) => map.set(key, (map.get(key) ?? 0) + us);
for (const [a, b] of tasks) {
  for (let i = a; i <= b; i++) {
    const id = profile.samples[i];
    if (idle(id)) continue;
    const dt = (times[i + 1] ?? times[i]) - times[i];
    busy += dt;
    const d = describe(id);
    add(selfByFile, d.file, dt);
    add(selfByFn, d.fn, dt);
    const seen = new Set();
    for (let p = id; p !== undefined; p = parent.get(p)) {
      const fn = describe(p).fn;
      if (seen.has(fn)) continue;
      seen.add(fn);
      if (!focus.length || focus.some((f) => fn.includes(f))) add(inclusive, fn, dt);
    }
  }
}
const ms = (us) => (us / 1000).toFixed(1).padStart(8);
console.log(`profile: ${PROFILE}, long tasks ${longTasks.length} (${Math.round(longTasks.reduce((n, [, d]) => n + d, 0))} ms), ${(busy / 1000).toFixed(0)} ms of samples inside them; each: ${longTasks.map(([, d]) => Math.round(d)).join(", ")} ms`);
console.log("\nself time by source:");
for (const [k, v] of [...selfByFile].sort((x, y) => y[1] - x[1]).slice(0, TOP)) console.log(`${ms(v)} ms  ${k}`);
console.log("\nself time by function:");
for (const [k, v] of [...selfByFn].sort((x, y) => y[1] - x[1]).slice(0, TOP)) console.log(`${ms(v)} ms  ${k}`);
console.log("\ninclusive time:");
for (const [k, v] of [...inclusive].sort((x, y) => y[1] - x[1]).slice(0, TOP * 2)) console.log(`${ms(v)} ms  ${k}`);
