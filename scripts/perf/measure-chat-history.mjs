#!/usr/bin/env node
/**
 * First load of a very long conversation, against a PRODUCTION build
 * (Workstream I, docs/rework/program/PERFORMANCE.md "Paged history").
 *
 *   next build && next start -p 3201             (DATABASE_URL = a throwaway DB)
 *   npx tsx scripts/seed-e2e-user.ts && npx tsx scripts/perf/seed-perf-data.ts
 *   node scripts/perf/measure-chat-history.mjs --base http://localhost:3201 \
 *        --label before --state /tmp/state.json --out docs/rework/program/perf/history-before-local.json
 *
 * Per run (cache cleared, so every run is a cold load):
 *   - hard load of /chat/<perf-long-2000>: bytes transferred (document, scripts,
 *     everything), TTFB and server time from Navigation Timing, ready (first
 *     transcript row in the DOM), settled (network quiet 300 ms)
 *   - long tasks and their total and max during the load
 *   - the soft-navigation RSC payload for the same route, and the server's
 *     time to last byte for it, fetched with the session cookie from Node
 * Then, once: scroll to the top of the conversation by wheel (how many history
 * requests, long tasks, whether the reader's row stays put across each page
 * that lands), and find "perf-anchor-6" (time until the match is centred).
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://localhost:3201";
const RUNS = Number(args.runs ?? 5);
const LABEL = args.label ?? "run";
const OUT = args.out;
const STATE = args.state;
const PROFILE = args.profile ?? "local";
const KEY = args.conversation ?? "perf-long-2000";
const EMAIL = process.env.E2E_EMAIL ?? "e2e@juno.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "E2E-Test-Password-2026!";
const r1 = (n) => Math.round(n * 10) / 10;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

const INIT = () => {
  window.__perf = { longTasks: [] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
};

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { userId_clientRequestId: { userId: user.id, clientRequestId: KEY } } });
  const messageCount = await prisma.message.count({ where: { conversationId: conversation.id } });
  const anchor = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, clientId: "perf-rich-6" } }).catch(() => null);
  await prisma.$disconnect();
  const url = `/chat/${conversation.id}`;

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...(STATE && fs.existsSync(STATE) ? { storageState: STATE } : {}) });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  if (PROFILE === "remote") {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 60, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 2 });
  }
  const ledger = [];
  const byId = new Map();
  cdp.on("Network.requestWillBeSent", (e) => { const rec = { url: e.request.url, type: e.type, start: Date.now(), end: null, bytes: 0, decoded: 0 }; byId.set(e.requestId, rec); ledger.push(rec); });
  cdp.on("Network.responseReceived", (e) => { const r = byId.get(e.requestId); if (r) r.type = e.type ?? r.type; });
  cdp.on("Network.dataReceived", (e) => { const r = byId.get(e.requestId); if (r) r.decoded += e.dataLength; });
  cdp.on("Network.loadingFinished", (e) => { const r = byId.get(e.requestId); if (r) { r.end = Date.now(); r.bytes = e.encodedDataLength; } });
  cdp.on("Network.loadingFailed", (e) => { const r = byId.get(e.requestId); if (r) r.end = Date.now(); });
  const LONG_LIVED = /favicon|\/api\/(events|notifications\/stream|chat\/stream|presence|agents\/live|sync)|webpack-hmr/;
  async function waitQuiet(quietMs = 300, max = 20000) {
    const t0 = Date.now();
    let quietSince = Date.now();
    while (Date.now() - t0 < max) {
      if (ledger.some((r) => r.end === null && Date.now() - r.start < 8000 && !LONG_LIVED.test(r.url) && r.type !== "EventSource")) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return Date.now() - quietMs;
      await new Promise((r) => setTimeout(r, 25));
    }
    return Date.now();
  }

  if (STATE && fs.existsSync(STATE)) {
    await page.goto(`${BASE}/chat`);
  } else {
    await page.goto(`${BASE}/sign-in`);
    await page.waitForSelector('input[name="email"]:not([disabled])');
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/chat/, { timeout: 30000 });
    await page.evaluate(() => localStorage.setItem("juno:onboarded:v1", "1"));
    if (STATE) await context.storageState({ path: STATE });
  }
  const cookie = (await context.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");

  // Server time for the route itself, outside the browser: the RSC payload a
  // sidebar click fetches, and the full HTML document, each timed to last byte.
  async function timed(headers) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${url}`, { headers: { cookie, "accept-encoding": "gzip", ...headers } });
    const firstByte = performance.now() - t0;
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ttfbMs: r1(firstByte), totalMs: r1(performance.now() - t0), kb: r1(body.length / 1024) };
  }
  const server = { rsc: [], html: [] };
  for (let i = 0; i < RUNS + 1; i++) {
    const rsc = await timed({ RSC: "1", "Next-Router-State-Tree": encodeURIComponent(JSON.stringify(["", { children: ["__PAGE__", {}] }, null, null, true])) });
    const html = await timed({});
    if (i > 0) { server.rsc.push(rsc); server.html.push(html); } // first pair warms the route
  }

  const loads = [];
  for (let run = 0; run < RUNS; run++) {
    await page.goto("about:blank");
    await cdp.send("Network.clearBrowserCache");
    const mark = ledger.length;
    const start = Date.now();
    await page.goto(`${BASE}${url}`, { waitUntil: "commit" });
    await page.waitForSelector("[data-transcript-key]", { timeout: 60000 });
    const ready = Date.now() - start;
    const settledAt = await waitQuiet();
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return { serverMs: n.responseStart - n.requestStart, ttfb: n.responseStart, responseEnd: n.responseEnd, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd };
    });
    const reqs = ledger.slice(mark);
    const doc = reqs.find((r) => r.type === "Document");
    const lt = await page.evaluate(() => window.__perf.longTasks);
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const dom = await page.evaluate(() => ({ rows: document.querySelectorAll("[data-transcript-key]").length, elements: document.getElementsByTagName("*").length }));
    loads.push({
      run, readyMs: ready, settledMs: settledAt - start,
      ...Object.fromEntries(Object.entries(nav).map(([k, v]) => [k, r1(v)])),
      documentKb: r1((doc?.bytes ?? 0) / 1024), documentDecodedKb: r1((doc?.decoded ?? 0) / 1024),
      jsKb: r1(reqs.filter((r) => r.type === "Script").reduce((a, r) => a + r.bytes, 0) / 1024),
      totalKb: r1(reqs.reduce((a, r) => a + r.bytes, 0) / 1024),
      requests: reqs.length,
      historyRequests: reqs.filter((r) => /\/api\/conversations\/[^/]+\/messages/.test(r.url)).length,
      longTasks: lt.length, longTaskMs: r1(lt.reduce((a, t) => a + t.duration, 0)), maxLongTaskMs: r1(Math.max(0, ...lt.map((t) => t.duration))),
      heapMb: r1(m.JSHeapUsedSize / 1048576), scriptS: r1(m.ScriptDuration * 1000) / 1000,
      ...dom,
    });
  }

  // Scroll to the very top by wheel, as a reader would. Each time history
  // lands, the row that was at the top of the viewport must stay where it was.
  const scroller = page.locator('[aria-label="Conversation messages"]');
  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const scrollMark = ledger.length;
  const t0 = await page.evaluate(() => performance.now());
  const jumps = [];
  let reachedTop = false;
  for (let tick = 0; tick < 1500 && !reachedTop; tick++) {
    const before = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Conversation messages"]');
      const edge = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll("[data-transcript-key]")].find((r) => r.getBoundingClientRect().bottom > edge + 40);
      return row ? { key: row.dataset.transcriptKey, top: row.getBoundingClientRect().top, count: window.__alevrRowsLoaded?.() } : null;
    });
    const rowsBefore = await page.evaluate(() => document.querySelector('[role="log"]')?.dataset.historyLoaded);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(16);
    const after = await page.evaluate((key) => {
      const el = document.querySelector('[aria-label="Conversation messages"]');
      const row = key ? el.querySelector(`[data-transcript-key="${CSS.escape(key)}"]`) : null;
      return { top: row ? row.getBoundingClientRect().top : null, scrollTop: el.scrollTop, loaded: document.querySelector('[role="log"]')?.dataset.historyLoaded, hasOlder: document.querySelector('[role="log"]')?.dataset.historyOlder };
    }, before?.key);
    if (rowsBefore !== undefined && after.loaded !== rowsBefore && before && after.top !== null) {
      // A page of history landed during this tick: the wheel moved the view by
      // up to 600px; anything beyond that is the anchor slipping.
      jumps.push({ loaded: after.loaded, drift: r1(Math.abs(after.top - before.top - 600) < Math.abs(after.top - before.top) ? after.top - before.top - 600 : after.top - before.top) });
    }
    if (after.scrollTop <= 0 && after.hasOlder !== "true") reachedTop = true;
  }
  await waitQuiet();
  const scroll = await page.evaluate((from) => {
    const lt = window.__perf.longTasks.filter((t) => t.start >= from);
    return { longTasks: lt.length, longTaskMs: Math.round(lt.reduce((a, t) => a + t.duration, 0)), maxLongTaskMs: Math.round(Math.max(0, ...lt.map((t) => t.duration))), rowsLoaded: document.querySelector('[role="log"]')?.dataset.historyLoaded ?? null };
  }, t0);
  const scrollReqs = ledger.slice(scrollMark).filter((r) => /\/api\/conversations\/[^/]+\/messages/.test(r.url));
  const scrollResult = { reachedTop, ...scroll, historyRequests: scrollReqs.length, historyKb: r1(scrollReqs.reduce((a, r) => a + r.bytes, 0) / 1024), anchorDrift: jumps };

  // Find a phrase near the top, from a fresh load (nothing older loaded yet).
  await cdp.send("Network.clearBrowserCache");
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector("[data-transcript-key]");
  await waitQuiet();
  const findMark = ledger.length;
  const findStart = Date.now();
  await page.locator('[aria-label="Conversation messages"]').focus();
  await page.keyboard.press("ControlOrMeta+f");
  await page.waitForSelector('input[aria-label="Find in this conversation"]');
  await page.fill('input[aria-label="Find in this conversation"]', "perf-anchor-6");
  let find = { found: false };
  try {
    await page.waitForFunction(() => {
      const target = [...document.querySelectorAll("[data-message-id]")].find((el) => el.textContent?.includes("perf-anchor-6"));
      if (!target) return false;
      const scroller = document.querySelector('[aria-label="Conversation messages"]').getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      return Math.abs(rect.top + rect.height / 2 - (scroller.top + scroller.height / 2)) < Math.max(40, rect.height / 2);
    }, null, { timeout: 30000, polling: 50 });
    const status = await page.locator('[role="search"] [role="status"]').textContent();
    find = { found: true, ms: Date.now() - findStart, status, historyRequests: ledger.slice(findMark).filter((r) => /\/messages/.test(r.url)).length };
  } catch (error) {
    find = { found: false, error: String(error).slice(0, 200) };
  }

  // Deep link (?m=) to a message 1,993 rows above the newest one.
  let deepLink = null;
  if (anchor) {
    await cdp.send("Network.clearBrowserCache");
    const mark = ledger.length;
    const start = Date.now();
    await page.goto(`${BASE}${url}?m=${anchor.id}`, { waitUntil: "commit" });
    try {
      await page.waitForFunction((id) => {
        const target = document.querySelector(`[data-message-id="${id}"]`);
        if (!target) return false;
        const scroller = document.querySelector('[aria-label="Conversation messages"]').getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        return rect.bottom > scroller.top && rect.top < scroller.bottom;
      }, anchor.id, { timeout: 30000 });
      const doc = ledger.slice(mark).find((r) => r.type === "Document");
      deepLink = { visibleMs: Date.now() - start, documentKb: r1((doc?.bytes ?? 0) / 1024) };
    } catch (error) {
      deepLink = { error: String(error).slice(0, 200) };
    }
  }

  await browser.close();
  const summary = {
    label: LABEL, profile: PROFILE, base: BASE, conversation: KEY, messageCount, runs: RUNS, at: new Date().toISOString(),
    median: Object.fromEntries(["readyMs", "settledMs", "serverMs", "ttfb", "responseEnd", "domContentLoaded", "documentKb", "documentDecodedKb", "jsKb", "totalKb", "requests", "longTasks", "longTaskMs", "maxLongTaskMs", "heapMb", "elements", "rows"].map((k) => [k, median(loads.map((l) => l[k]))])),
    serverFetch: {
      rsc: { ttfbMs: median(server.rsc.map((x) => x.ttfbMs)), totalMs: median(server.rsc.map((x) => x.totalMs)), kb: median(server.rsc.map((x) => x.kb)) },
      html: { ttfbMs: median(server.html.map((x) => x.ttfbMs)), totalMs: median(server.html.map((x) => x.totalMs)), kb: median(server.html.map((x) => x.kb)) },
    },
    scroll: scrollResult, find, deepLink, loads, serverRaw: server,
  };
  console.log(JSON.stringify({ label: LABEL, median: summary.median, serverFetch: summary.serverFetch, scroll: { ...scrollResult, anchorDrift: scrollResult.anchorDrift.slice(0, 30) }, find, deepLink }, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
