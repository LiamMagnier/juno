#!/usr/bin/env node
/**
 * How much of the transcript Chrome restyles when one row is inserted
 * (docs/rework/program/PERFORMANCE.md, "Row insertion restyle"). A DevTools
 * trace with invalidation tracking around two kinds of insertion:
 *
 *   - `insert`: an empty <div> appended to, then removed from, the transcript
 *     (`role="log"`) twenty times, each followed by a forced style read. No
 *     React work at all, so the element count is the cost of the CSS alone.
 *   - `scroll`: the transcript scrolled up 40 × 600 px from script, so the
 *     window mounts real rows (and older pages land).
 *
 *   next dev -p 3201 (or ALEVR_BUNDLE_SOURCEMAPS=1 next build && next start -p 3201)
 *   node scripts/perf/trace-row-insert-restyle.mjs --state <storage.json> [--base http://localhost:3201]
 *        [--conversation perf-long-2000] [--mode insert|scroll|both] [--cpu 4] [--trace out.json]
 *
 * Prints, per mode: every element style Chrome resolved (StyleResolver::
 * ResolveStyle), and how many of those ran inside Layout; the UpdateLayoutTree
 * events (elements, ms); and the invalidation reasons Chrome recorded, with the
 * invalidation set behind each. Read the resolves, not UpdateLayoutTree's
 * elementCount: the transcript sits in a size container, so most of its
 * restyle runs in Layout and that count misses it. `--trace` saves the raw
 * trace for DevTools.
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://localhost:3201";
const KEY = args.conversation ?? "perf-long-2000";
const MODE = args.mode ?? "both";
const EMAIL = process.env.E2E_EMAIL ?? "e2e@juno.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "E2E-Test-Password-2026!";
const STATE = args.state;

const prisma = new PrismaClient();
const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
const conversation = await prisma.conversation.findUniqueOrThrow({ where: { userId_clientRequestId: { userId: user.id, clientRequestId: KEY } } });
await prisma.$disconnect();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...(STATE && fs.existsSync(STATE) ? { storageState: STATE } : {}) });
const page = await context.newPage();
if (!(STATE && fs.existsSync(STATE))) {
  await page.goto(`${BASE}/sign-in`, { timeout: 240_000 });
  await page.waitForSelector('input[name="email"]:not([disabled])');
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/chat/, { timeout: 60_000 });
  await page.evaluate(() => localStorage.setItem("juno:onboarded:v1", "1"));
  if (STATE) await context.storageState({ path: STATE });
}
// A development server compiles the route on first request: give it time.
await page.goto(`${BASE}/chat/${conversation.id}`, { timeout: 240_000 });
await page.waitForSelector('[aria-label="Conversation transcript"] [data-message-id]', { timeout: 120_000 });
await page.waitForTimeout(3000);
const { mounted, inPage } = await page.evaluate(() => ({
  mounted: document.querySelector('[aria-label="Conversation transcript"]').querySelectorAll("*").length,
  inPage: document.querySelectorAll("*").length,
}));

const cdp = await context.newCDPSession(page);
// `--cpu 4` slows the page's CPU four times, for a mid-range laptop or a phone.
if (Number(args.cpu) > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(args.cpu) });
const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.invalidationTracking",
];

async function trace(run) {
  const events = [];
  const onData = (e) => { for (const event of e.value) events.push(event); };
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", { traceConfig: { includedCategories: CATEGORIES, recordMode: "recordAsMuchAsPossible" }, transferMode: "ReportEvents" });
  const marks = await run();
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", onData);
  return { events, marks };
}

function summarize(label, events) {
  const recalcs = events.filter((e) => e.name === "UpdateLayoutTree" && e.ph === "X" && e.args?.elementCount != null);
  const counts = recalcs.map((e) => e.args.elementCount).sort((a, b) => a - b);
  const total = recalcs.reduce((s, e) => s + (e.dur ?? 0), 0) / 1000;
  const reasons = new Map();
  for (const e of events) {
    if (e.name !== "StyleInvalidatorInvalidationTracking") continue;
    const d = e.args?.data ?? {};
    const sets = (d.invalidationList ?? []).map((s) => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "id")))).join(" | ");
    const key = `${d.reason ?? "?"}  ${sets}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  const recalcReasons = new Map();
  for (const e of events) {
    if (e.name !== "StyleRecalcInvalidationTracking") continue;
    const r = e.args?.data?.reason ?? "?";
    recalcReasons.set(r, (recalcReasons.get(r) ?? 0) + 1);
  }
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const elements = counts.reduce((s, n) => s + n, 0);
  // Every element style Chrome resolved, wherever it ran. Inside a size
  // container (`@container`), the restyle of the container's subtree runs during
  // Layout, not in UpdateLayoutTree, and its elementCount leaves it out: on the
  // real scroll that is nearly all of it.
  const resolves = events.filter((e) => e.name === "StyleResolver::ResolveStyle").map((e) => e.ts).sort((a, b) => a - b);
  const inside = (name) => {
    let n = 0, ms = 0, max = 0;
    const each = [];
    for (const x of events) {
      if (x.ph !== "X" || x.name !== name) continue;
      let lo = 0, hi = resolves.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (resolves[mid] < x.ts) lo = mid + 1; else hi = mid; }
      let k = 0;
      for (let i = lo; i < resolves.length && resolves[i] <= x.ts + x.dur; i++) k++;
      n += k; max = Math.max(max, k);
      if (k) { ms += x.dur / 1000; each.push(k); }
    }
    return { n, ms, max, each };
  };
  const inLayout = inside("Layout");
  console.log(`\n## ${label}`);
  console.log(`element styles resolved: ${resolves.length} (inside Layout, for container queries: ${inLayout.n}, at most ${inLayout.max} in one Layout; those Layouts took ${inLayout.ms.toFixed(1)} ms)`);
  // Main-thread tasks over 50 ms, the ones a reader feels as a hitch.
  const longTasks = events.filter((e) => e.name === "RunTask" && e.ph === "X" && e.dur > 50_000).map((e) => e.dur / 1000);
  const longMs = longTasks.reduce((sum, ms) => sum + ms, 0);
  console.log(`long tasks (> 50 ms): ${longTasks.length}, ${longMs.toFixed(0)} ms in all, longest ${Math.max(0, ...longTasks).toFixed(0)} ms`);
  console.log(`UpdateLayoutTree: ${recalcs.length} events, ${elements} elements in all (median ${median}, max ${counts.at(-1) ?? 0}), ${total.toFixed(1)} ms`);
  console.log(`elements per recalc: ${counts.join(" ")}`);
  console.log(`styles resolved per Layout that resolved any, in order: ${inLayout.each.join(" ")}`);
  console.log("StyleInvalidator reasons (count):");
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(5)}  ${k.slice(0, 400)}`);
  console.log("StyleRecalc reasons (count):");
  for (const [k, n] of [...recalcReasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  return { label, resolves: resolves.length, resolvesInLayout: inLayout.n, maxInOneLayout: inLayout.max, restyleLayoutMs: Number(inLayout.ms.toFixed(1)), longTasks: longTasks.length, longTaskMs: Math.round(longMs), longestTaskMs: Math.round(Math.max(0, ...longTasks)), recalcs: recalcs.length, elements, median, max: counts.at(-1) ?? 0, totalMs: Number(total.toFixed(1)) };
}

console.log(`transcript elements mounted: ${mounted} (${inPage} in the page)`);
const results = [];
const allEvents = [];

if (MODE === "insert" || MODE === "both") {
  const { events } = await trace(() => page.evaluate(() => {
    const log = document.querySelector('[aria-label="Conversation transcript"]');
    const anchor = log.querySelector("[data-message-id]");
    let read = "";
    for (let i = 0; i < 20; i++) {
      const row = document.createElement("div");
      log.insertBefore(row, anchor);
      read += getComputedStyle(row).color; // forces the style update this insert caused
      row.remove();
      read += getComputedStyle(anchor).color;
    }
    return read.length;
  }));
  // A loop, not a spread: the old CSS produced more events than a call's arguments can hold.
  if (args.trace) for (const event of events) allEvents.push(event);
  results.push(summarize("insert: 20 synthetic rows (insert + remove, forced style each)", events));
}

if (MODE === "scroll" || MODE === "both") {
  // Scrolled from script, not the wheel: a pointer over the rows adds hover
  // restyles that have nothing to do with rows mounting.
  await page.evaluate(() => {
    window.__rowsInserted = 0;
    const log = document.querySelector('[aria-label="Conversation transcript"]');
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.hasAttribute("data-message-id")) window.__rowsInserted++;
    }).observe(log, { childList: true });
    // Every element that entered the transcript, rows and their contents, each
    // counted once: the floor for what Chrome must style. The restyle is
    // transcript-wide when the resolves run far past it.
    window.__elementsInserted = 0;
    const seen = new WeakSet();
    const count = (el) => { if (!seen.has(el)) { seen.add(el); window.__elementsInserted++; } for (const child of el.children) count(child); };
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) count(n);
    }).observe(log, { childList: true, subtree: true });
  });
  const { events } = await trace(async () => {
    for (let tick = 0; tick < 40; tick++) {
      await page.evaluate(() => { document.querySelector('[aria-label="Conversation messages"]').scrollTop -= 600; });
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(1500);
  });
  const { inserted, elementsInserted } = await page.evaluate(() => ({ inserted: window.__rowsInserted, elementsInserted: window.__elementsInserted }));
  if (args.trace) for (const event of events) allEvents.push(event);
  results.push({
    ...summarize(`scroll: 40 × 600 px up (${inserted} rows, ${elementsInserted} elements in all, inserted into the transcript)`, events),
    inserted,
    elementsInserted,
  });
}

if (args.trace) fs.writeFileSync(args.trace, JSON.stringify({ traceEvents: allEvents }));
console.log(`\n${JSON.stringify({ mounted, inPage, results })}`);
await browser.close();
