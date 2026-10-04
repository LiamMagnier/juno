#!/usr/bin/env node
/**
 * Navigation + long-transcript benchmark against a PRODUCTION build.
 *
 *   next build && next start -p 3201          (DATABASE_URL = a throwaway DB)
 *   npx tsx scripts/seed-e2e-user.ts && npx tsx scripts/perf/seed-perf-data.ts
 *   node scripts/perf/measure-navigation.mjs --base http://localhost:3201 \
 *        --label before --out docs/rework/program/perf/baseline-before.json
 *
 * What it measures, per transition of Chat → Project → Library → Customize →
 * Orbit → agent → another agent → Chat (clicked through the real sidebar):
 *   - click→URL, click→destination content ("ready"), click→network quiet ("settled")
 *   - every request in the window (RSC payloads, API fetches, scripts), duplicates
 *     and sequential depth (a request that only starts after another finished)
 *   - JS transferred (CDP encodedDataLength of Script resources)
 *   - long tasks (PerformanceObserver "longtask"), layout shift (CLS sum)
 *   - shell remounts: identity of the sidebar <aside> and the <main> element
 *   - JS heap after the step (CDP Performance.getMetrics)
 * Then the 1,000-message conversation: hard load, mounted rows / DOM size,
 * scroll frame times + long tasks, and a 300-delta stream (fetch is stubbed
 * in-page so the real client parser/renderer runs without a model) with frame
 * times, long tasks and DOM mutations OUTSIDE the streaming row.
 *
 * Pass 1 is cold (empty HTTP cache, fresh context); passes 2..N reuse the
 * context, so later passes show the warm, chunk-cached experience.
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://localhost:3201";
const RUNS = Number(args.runs ?? 3);
const LABEL = args.label ?? "run";
const OUT = args.out;
const EMAIL = process.env.E2E_EMAIL ?? "e2e@juno.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "E2E-Test-Password-2026!";
const HOVER_DWELL_MS = Number(args.dwell ?? 120);
const STATE = args.state; // reuse a signed-in storage state (the sign-in limiter allows 10 per 15 min)
// "local": loopback, unthrottled. "remote": 60 ms RTT, 20 Mbit/s down, CPU 2× —
// a laptop talking to a hosted server, which is where waterfalls and bytes show.
const PROFILE = args.profile ?? "local";

const prisma = new PrismaClient();
async function ids() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const conv = (key) => prisma.conversation.findUniqueOrThrow({ where: { userId_clientRequestId: { userId: user.id, clientRequestId: key } } });
  const project = await prisma.project.findUniqueOrThrow({ where: { userId_importSourceId: { userId: user.id, importSourceId: "perf-project" } } });
  return {
    projectId: project.id,
    longId: (await conv("perf-long-1000")).id,
    agentThreads: [(await conv("perf-agent-0")).id, (await conv("perf-agent-1")).id],
  };
}

const INIT = () => {
  window.__perf = { longTasks: [], shifts: [], frames: [], mutationsOutside: 0, mutationsInside: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__perf.shifts.push({ start: e.startTime, value: e.value });
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  // Streaming stub: only active when a test arms it. Everything after the
  // Response is the product's own parser and renderer.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const stub = window.__perfStream;
    if (stub && /\/api\/chat\/clarify$/.test(new URL(url, location.href).pathname)) {
      return Promise.resolve(new Response(JSON.stringify({ needsClarification: false }), { headers: { "content-type": "application/json" } }));
    }
    if (stub && new URL(url, location.href).pathname === "/api/chat" && init?.method === "POST") {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          const send = (o) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({ type: "meta", conversationId: stub.conversationId, resumable: false });
          let n = 0;
          const tick = () => {
            if (n >= stub.deltas) { stub.finished = performance.now(); return; }
            n++;
            send({ type: "delta", text: n % 40 === 0 ? "\n\n" : `word${n} ` + (n % 9 === 0 ? "**bold** " : "") });
            setTimeout(tick, stub.intervalMs);
          };
          stub.started = performance.now();
          setTimeout(tick, stub.intervalMs);
        },
      });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    }
    return realFetch(input, init);
  };
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const r1 = (n) => (n == null ? n : Math.round(n * 10) / 10);

async function main() {
  const { projectId, longId, agentThreads } = await ids();
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

  // Request ledger (wall-clock ms via Date.now in Node for windowing).
  const requests = new Map();
  const ledger = [];
  cdp.on("Network.requestWillBeSent", (e) => {
    const rec = { id: e.requestId, url: e.request.url, method: e.request.method, type: e.type, start: Date.now(), end: null, bytes: 0, status: null };
    requests.set(e.requestId, rec);
    ledger.push(rec);
  });
  cdp.on("Network.responseReceived", (e) => { const r = requests.get(e.requestId); if (r) { r.status = e.response.status; r.type = e.type ?? r.type; } });
  cdp.on("Network.loadingFinished", (e) => { const r = requests.get(e.requestId); if (r) { r.end = Date.now(); r.bytes = e.encodedDataLength; } });
  cdp.on("Network.loadingFailed", (e) => { const r = requests.get(e.requestId); if (r) { r.end = Date.now(); r.failed = true; } });

  const LONG_LIVED = /\/icon\.svg|favicon|\/api\/(events|notifications\/stream|chat\/stream|presence|agents\/live)|\/_next\/webpack-hmr/;
  // A request open for more than 8 s is a stream or one CDP lost track of
  // (under network emulation an aborted prefetch sometimes never reports
  // loadingFailed); either way it is not part of a navigation settling.
  const inflight = () => ledger.filter((r) => r.end === null && Date.now() - r.start < 8000 && !LONG_LIVED.test(r.url) && r.type !== "EventSource" && r.type !== "WebSocket");
  async function waitQuiet(quietMs = 300, max = 15000) {
    const t0 = Date.now();
    let quietSince = Date.now();
    while (Date.now() - t0 < max) {
      if (inflight().length) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return Date.now() - quietMs;
      await new Promise((r) => setTimeout(r, 25));
    }
    process.stderr.write(`[${LABEL}] never quiet: ${inflight().map((r) => `${r.type} ${r.url.replace(BASE, "")}`).join(", ")}\n`);
    return Date.now();
  }
  const heap = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { heapMb: r1(m.JSHeapUsedSize / 1048576), nodes: m.Nodes, scriptS: m.ScriptDuration, layoutS: m.LayoutDuration, recalcS: m.RecalcStyleDuration };
  };

  // ---- sign in ----
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

  async function hardLoad(url, readySelector) {
    await cdp.send("Network.clearBrowserCache");
    const start = Date.now();
    const mark = ledger.length;
    await page.goto(`${BASE}${url}`, { waitUntil: "commit" });
    await page.waitForSelector(readySelector, { timeout: 30000 });
    const ready = Date.now() - start;
    const settledAt = await waitQuiet();
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return { ttfb: n.responseStart, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd };
    });
    const reqs = ledger.slice(mark);
    const lt = await page.evaluate(() => window.__perf.longTasks);
    return {
      url, readyMs: ready, settledMs: settledAt - start, ...Object.fromEntries(Object.entries(nav).map(([k, v]) => [k, r1(v)])),
      jsKb: r1(reqs.filter((r) => r.type === "Script").reduce((a, r) => a + r.bytes, 0) / 1024),
      totalKb: r1(reqs.reduce((a, r) => a + r.bytes, 0) / 1024),
      requests: reqs.length,
      longTasks: lt.length, longTaskMs: r1(lt.reduce((a, t) => a + t.duration, 0)), maxLongTaskMs: r1(Math.max(0, ...lt.map((t) => t.duration))),
      ...(await heap()),
    };
  }

  /**
   * One client-side transition by clicking a real link. "ready" is measured
   * IN the page: the first animation frame after the click in which the
   * destination's content is in the viewport and not transparent (an
   * entrance at opacity 0 does not count as shown).
   */
  async function step(name, linkSelector, ready, expectUrl) {
    const link = page.locator(linkSelector).first();
    await link.waitFor({ state: "visible", timeout: 15000 });
    await page.evaluate(() => {
      window.__perfShell = { aside: document.querySelector("aside"), main: document.querySelector("main") };
    });
    await link.hover();
    await page.waitForTimeout(HOVER_DWELL_MS);
    const mark = ledger.length;
    const pageT0 = await page.evaluate(({ css, text }) => {
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= innerHeight) return false;
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.1) return false;
        }
        return true;
      };
      window.__perfReady = null; window.__perfUrlAt = null;
      const from = location.pathname;
      const armed = performance.now();
      const loop = () => {
        const now = performance.now();
        if (window.__perfClickAt != null) {
          if (window.__perfUrlAt == null && location.pathname !== from) window.__perfUrlAt = now - window.__perfClickAt;
          const els = [...document.querySelectorAll(css)].filter((el) => !text || el.textContent.includes(text));
          if (window.__perfUrlAt != null && els.some(shown)) { window.__perfReady = now - window.__perfClickAt; return; }
        }
        if (now - armed < 20000) requestAnimationFrame(loop);
      };
      window.__perfClickAt = null;
      addEventListener("pointerdown", () => { window.__perfClickAt = performance.now(); }, { once: true, capture: true });
      requestAnimationFrame(loop);
      return performance.now();
    }, ready);
    const start = Date.now();
    await link.click();
    await page.waitForURL(expectUrl, { timeout: 20000 });
    await page.waitForFunction(() => window.__perfReady != null, null, { timeout: 20000, polling: 50 });
    const { urlMs, readyMs } = await page.evaluate(() => ({ urlMs: Math.round(window.__perfUrlAt), readyMs: Math.round(window.__perfReady) }));
    const settledAt = await waitQuiet();
    const settledMs = settledAt - start;
    const inPage = await page.evaluate((t0) => ({
      longTasks: window.__perf.longTasks.filter((t) => t.start >= t0),
      cls: window.__perf.shifts.filter((s) => s.start >= t0).reduce((a, s) => a + s.value, 0),
      asideKept: !!window.__perfShell.aside && window.__perfShell.aside === document.querySelector("aside") && document.contains(window.__perfShell.aside),
      mainKept: !!window.__perfShell.main && window.__perfShell.main === document.querySelector("main") && document.contains(window.__perfShell.main),
    }), pageT0);
    // Hover-dwell prefetches belong to this transition: include requests from
    // the hover onwards.
    const hoverStart = start - HOVER_DWELL_MS - 50;
    const reqs = ledger.filter((r, i) => i >= mark || r.start >= hoverStart).filter((r) => r.start <= settledAt + 50);
    const rel = (t) => (t == null ? null : t - start);
    const shown = reqs.filter((r) => r.type !== "Image" && r.type !== "Font" && !LONG_LIVED.test(r.url));
    const keyOf = (r) => `${r.method} ${r.url.replace(BASE, "").replace(/([?&])_rsc=[^&]*/, "$1_rsc")}`;
    const counts = new Map();
    for (const r of shown) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1);
    const api = shown.filter((r) => /\/api\//.test(r.url));
    // Sequential depth: longest chain of API/RSC requests where each starts
    // after the previous one finished.
    const chainable = shown.filter((r) => /\/api\/|_rsc=/.test(r.url) && r.end);
    const sorted = [...chainable].sort((a, b) => a.start - b.start);
    const depth = new Map();
    for (const r of sorted) {
      let d = 1;
      for (const p of sorted) if (p !== r && p.end && p.end <= r.start + 2) d = Math.max(d, (depth.get(p) ?? 1) + 1);
      depth.set(r, d);
    }
    return {
      name, urlMs, readyMs, settledMs,
      jsKb: r1(shown.filter((r) => r.type === "Script").reduce((a, r) => a + r.bytes, 0) / 1024),
      rscRequests: shown.filter((r) => /_rsc=/.test(r.url)).length,
      apiRequests: api.length,
      duplicateRequests: [...counts.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`),
      sequentialDepth: Math.max(0, ...depth.values()),
      longTasks: inPage.longTasks.length, longTaskMs: r1(inPage.longTasks.reduce((a, t) => a + t.duration, 0)), maxLongTaskMs: r1(Math.max(0, ...inPage.longTasks.map((t) => t.duration))),
      cls: Math.round(inPage.cls * 10000) / 10000,
      shellKept: inPage.asideKept, mainKept: inPage.mainKept,
      ...(await heap()),
      requests: shown.map((r) => ({ path: r.url.replace(BASE, "").slice(0, 140), type: r.type, start: rel(r.start), end: rel(r.end), kb: r1(r.bytes / 1024), status: r.status })),
    };
  }

  const project = `a[href="/projects/${projectId}"]`;
  const agentA = `a[href="/chat/${agentThreads[0]}"]`;
  const agentB = `a[href="/chat/${agentThreads[1]}"]`;
  const rows = { css: '[aria-label="Conversation transcript"] [data-message-id]' };
  const sequence = [
    ["Chat → Projects", 'aside a[href="/projects"]', { css: `main ${project}` }, /\/projects$/],
    ["Projects → Project", `main ${project}`, { css: "main a", text: "Perf project chat" }, new RegExp(`/projects/${projectId}$`)],
    ["Project → Library", 'aside a[href="/library"]', { css: "main h1" }, /\/library$/],
    ["Library → Customize", 'aside a[href="/customize"]', { css: "main h1" }, /\/customize$/],
    ["Customize → Orbit", 'aside a[href="/agents"]', { css: `main ${agentA}` }, /\/agents$/],
    ["Orbit → agent", `main ${agentA}`, rows, new RegExp(`/chat/${agentThreads[0]}$`)],
    ["agent → another agent", `aside ${agentB}`, rows, new RegExp(`/chat/${agentThreads[1]}$`)],
    ["agent → Chat", 'aside a[href="/chat"]', { css: "#juno-composer-textarea" }, /\/chat$/],
  ];

  const result = { label: LABEL, profile: PROFILE, base: BASE, date: new Date().toISOString(), hoverDwellMs: HOVER_DWELL_MS, viewport: "1440x900@1x", browser: `chrome ${browser.version()}`, passes: [], hardLoads: [], longConversation: {} };

  result.hardLoads.push(await hardLoad("/chat", "#juno-composer-textarea, textarea"));
  for (let run = 0; run < RUNS; run++) {
    if (run > 0) { await page.goto(`${BASE}/chat`); await page.waitForSelector("#juno-composer-textarea, textarea"); await waitQuiet(); }
    const steps = [];
    for (const [name, link, ready, url] of sequence) {
      try { steps.push(await step(name, link, ready, url)); }
      catch (error) { steps.push({ name, error: String(error).slice(0, 300) }); await page.goto(`${BASE}${String(url).includes("projects") ? `/projects/${projectId}` : "/chat"}`).catch(() => {}); }
      process.stderr.write(`[${LABEL}] pass ${run + 1} ${name}: ${steps.at(-1).readyMs ?? "ERR"} ms ready / ${steps.at(-1).settledMs ?? "-"} ms settled\n`);
    }
    result.passes.push({ pass: run + 1, cold: run === 0, steps });
  }

  // ---- 1,000-message conversation ----
  const rowSel = '[aria-label="Conversation transcript"] [data-message-id]';
  result.longConversation.hardLoad = await hardLoad(`/chat/${longId}`, rowSel);
  result.longConversation.dom = await page.evaluate(() => ({
    mountedRows: document.querySelectorAll('[aria-label="Conversation transcript"] [data-message-id]').length,
    domElements: document.querySelectorAll("*").length,
  }));

  const scroller = page.locator('[aria-label="Conversation messages"]');
  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  async function frameProbe(run) {
    await page.evaluate(() => {
      window.__perf.frames = [];
      window.__perf.probeT0 = performance.now();
      let last = performance.now();
      window.__perf.probing = true;
      const loop = (t) => { window.__perf.frames.push(t - last); last = t; if (window.__perf.probing) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    await run();
    return page.evaluate(() => {
      window.__perf.probing = false;
      const f = window.__perf.frames.slice(1);
      const t0 = window.__perf.probeT0;
      const lt = window.__perf.longTasks.filter((t) => t.start >= t0);
      return { f, lt };
    });
  }
  const summarize = ({ f, lt }) => ({
    frames: f.length,
    p50FrameMs: r1(median(f)), p95FrameMs: r1(pct(f, 0.95)), maxFrameMs: r1(Math.max(0, ...f)),
    framesOver50ms: f.filter((x) => x > 50).length,
    droppedFrameRatio: f.length ? Math.round((f.filter((x) => x > 25).length / f.length) * 1000) / 1000 : null,
    longTasks: lt.length, longTaskMs: r1(lt.reduce((a, t) => a + t.duration, 0)), maxLongTaskMs: r1(Math.max(0, ...lt.map((t) => t.duration))),
  });

  // Scroll up through history: 120 wheel ticks of 600px, one per ~16 ms.
  const before = await heap();
  const scrollUp = await frameProbe(async () => {
    for (let i = 0; i < 120; i++) { await page.mouse.wheel(0, -600); await page.waitForTimeout(16); }
    await page.waitForTimeout(300);
  });
  result.longConversation.scrollUp = { ...summarize(scrollUp), mountedRowsAfter: await page.locator(rowSel).count(), scrollTop: await scroller.evaluate((el) => Math.round(el.scrollTop)) };
  const homeEnd = await frameProbe(async () => {
    await scroller.focus();
    await scroller.press("Home");
    await page.waitForTimeout(400);
    await scroller.press("End");
    await page.waitForTimeout(400);
  });
  result.longConversation.homeEnd = summarize(homeEnd);
  result.longConversation.heapAfterScroll = { before, after: await heap() };

  // Stream 300 deltas into the 1,000-message conversation.
  const DELTAS = 300;
  await page.evaluate(({ id, deltas }) => { window.__perfStream = { conversationId: id, deltas, intervalMs: 25 }; }, { id: longId, deltas: DELTAS });
  await page.evaluate(() => {
    const log = document.querySelector('[aria-label="Conversation transcript"]');
    window.__perf.mutationsOutside = 0; window.__perf.mutationsInside = 0;
    window.__perfMO = new MutationObserver((records) => {
      const rows = log.querySelectorAll("[data-message-id]");
      const lastRow = rows[rows.length - 1];
      for (const rec of records) {
        const row = (rec.target.nodeType === 1 ? rec.target : rec.target.parentElement)?.closest?.("[data-message-id]");
        if (row && row === lastRow) window.__perf.mutationsInside++;
        else if (row) window.__perf.mutationsOutside++;
      }
    });
    window.__perfMO.observe(log, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const cdpBefore = await heap();
  const stream = await frameProbe(async () => {
    const box2 = page.locator("#juno-composer-textarea, textarea").first();
    await box2.fill("Stream a long answer for the benchmark.");
    await box2.press("Enter");
    await page.waitForFunction(() => window.__perfStream?.finished, null, { timeout: 60000 });
    await page.waitForTimeout(300);
  });
  const cdpAfter = await heap();
  const mo = await page.evaluate(() => { window.__perfMO.disconnect(); return { inside: window.__perf.mutationsInside, outside: window.__perf.mutationsOutside, ms: window.__perfStream.finished - window.__perfStream.started }; });
  result.longConversation.stream = {
    deltas: DELTAS, intervalMs: 25, streamMs: r1(mo.ms), ...summarize(stream),
    scriptSeconds: r1(cdpAfter.scriptS - cdpBefore.scriptS), layoutSeconds: r1(cdpAfter.layoutS - cdpBefore.layoutS), styleSeconds: r1(cdpAfter.recalcS - cdpBefore.recalcS),
    domMutationsInStreamingRow: mo.inside, domMutationsInSettledRows: mo.outside,
    mountedRowsAfter: await page.locator(rowSel).count(),
  };

  // Summary: median of warm passes, pass 1 separately.
  const byName = {};
  for (const p of result.passes) for (const s of p.steps) (byName[s.name] ??= { cold: null, warm: [] })[p.cold ? "cold" : "warm"] = p.cold ? s : [...(byName[s.name]?.warm ?? []), s];
  result.summary = Object.fromEntries(Object.entries(byName).map(([n, v]) => [n, {
    coldReadyMs: v.cold?.readyMs ?? null, coldSettledMs: v.cold?.settledMs ?? null, coldJsKb: v.cold?.jsKb ?? null,
    warmReadyMsMedian: median(v.warm.map((s) => s.readyMs).filter((x) => x != null)),
    warmSettledMsMedian: median(v.warm.map((s) => s.settledMs).filter((x) => x != null)),
    rscRequests: v.cold?.rscRequests, apiRequests: v.cold?.apiRequests, sequentialDepth: v.cold?.sequentialDepth,
    duplicates: v.cold?.duplicateRequests?.length ?? 0,
    shellKept: [v.cold, ...v.warm].every((s) => s?.shellKept !== false),
    longTaskMs: v.cold?.longTaskMs, cls: v.cold?.cls,
  }]));
  await browser.close();
  await prisma.$disconnect();
  const json = JSON.stringify(result, null, 2);
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, json); }
  console.log(JSON.stringify({ summary: result.summary, hardLoads: result.hardLoads, longConversation: { ...result.longConversation } }, null, 2));
}

main().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
