import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { formatAxe, runAxe } from "../../support/axe";
import { applyCvdFilter, compareShapeMasks, CVD_GATE_KINDS, simulateCvd } from "../../support/cvd";
import { matrixRoutes, readQaFixtures } from "../../support/fixtures";
import { recordGate } from "../../support/gate-recorder";
import { formatBytes, heapRatio, measureHeapAfterGc, readHeapBaseline, writeHeapBaseline } from "../../support/heap";
import { installLayoutShiftRecorder, readLayoutShifts } from "../../support/layout-shift";
import { evaluateParity, measureWebGeometry, readNativeGeometry, writeGeometryRecord, type GeometryRecord } from "../../support/parity";
import { decodePng } from "../../support/png";
import { captureMatrixShot, describeMatrix, settleAnimations } from "../../support/screenshot-matrix";

/*
 * P0's cross-cutting gates (spec appendix P0 (5)). Every one runs report-only
 * until a package lists its id in its own e2e/wave2/<pkg>/gates.ts:
 *
 * - shell.sidebar-cls            sidebar layout shift on a hard load of /chat
 * - web.js-heap                  JS heap after GC on the seeded 1,000-message thread vs a recorded baseline
 * - a11y.axe                     serious or critical axe violations on shell, chat, Code, Library, Settings, sign-in
 * - design.bubble-composer-parity bubble 12/12/12/8 + user-bubble fill, composer 22, disc 12 (web + native exports)
 * - visual.route-matrix          the route matrix at 1440×900 and 390×844, light/dark/high contrast, motion on/off
 *
 * Tags: @gates for the measured gates, @matrix for the screenshot matrix
 * (`--grep-invert @matrix` skips the 180 captures on a quick local run).
 */

const ROOT = process.cwd();
const BASELINES = path.join(ROOT, "e2e", "wave2", "p0-harness", "baselines");
const NATIVE_GEOMETRY_DIR = path.join(ROOT, "test-results", "native-geometry");
// Web records also go here, so CI's summary job can combine them with the
// native job's exports (scripts/qa/gates.ts parity).
const WEB_GEOMETRY_DIR = process.env.ALEVR_QA_REPORT_DIR
  ? path.join(path.dirname(process.env.ALEVR_QA_REPORT_DIR), "web-geometry")
  : path.join(ROOT, "test-results", "web-geometry");
const fixtures = readQaFixtures();
const anonymous = { storageState: { cookies: [], origins: [] } };

async function openAndSettle(page: Page, route: string): Promise<number> {
  const response = await page.goto(route, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load");
  // Bounded: chat pages keep a live connection open, so the network is never idle for long.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await settleAnimations(page);
  return response?.status() ?? 0;
}

test.describe("cross-cutting gates @gates", () => {
  test("sidebar CLS on a hard load", async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== "chromium", "layout-shift entries are Chromium-only");
    test.skip(testInfo.project.name !== "chromium-1440", "the docked sidebar exists at 1024px and wider");
    await installLayoutShiftRecorder(page);
    await openAndSettle(page, "/chat");
    // Late shifts (fonts, hydration) land within a few frames of settling.
    await page.waitForTimeout(750);
    const shifts = await readLayoutShifts(page);
    test.skip(!shifts.supported, "this browser reports no layout-shift entries");
    await recordGate(testInfo, "shell.sidebar-cls", {
      value: Math.round(shifts.region * 10_000) / 10_000,
      detail: `whole-page CLS ${shifts.total.toFixed(4)} over ${shifts.entries.length} shift(s)`,
      context: { route: "/chat" },
    });
  });

  test("JS heap after GC on the 1,000-message thread", async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== "chromium" || testInfo.project.name !== "chromium-1440", "CDP heap reads are Chromium-only; measured once, at 1440");
    test.skip(!fixtures.qaThreadId, "no seeded 1,000-message thread (run without --no-seed)");
    await openAndSettle(page, `/chat/${fixtures.qaThreadId}`);
    await expect(page.locator("#juno-composer-textarea, textarea").first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    const reading = await measureHeapAfterGc(page);
    const file = path.join(BASELINES, "heap.json");
    if (process.env.ALEVR_QA_UPDATE_BASELINES === "1") {
      writeHeapBaseline(file, reading, { note: "1,000-message QA thread at 1440×900, chromium" });
      testInfo.annotations.push({ type: "baseline", description: `heap baseline recorded: ${formatBytes(reading.usedBytes)}` });
      return;
    }
    const baseline = readHeapBaseline(file);
    if (!baseline) {
      testInfo.annotations.push({
        type: "gate-unmeasured",
        description: `web.js-heap: ${formatBytes(reading.usedBytes)} measured, but there is no baseline yet. Record one on a known-good build with --update-baselines.`,
      });
      return;
    }
    await recordGate(testInfo, "web.js-heap", {
      value: Math.round(heapRatio(reading, baseline) * 1000) / 1000,
      detail: `${formatBytes(reading.usedBytes)} after GC vs baseline ${formatBytes(baseline.usedBytes)}`,
      context: { route: "/chat/[qa thread]" },
    });
  });

  test.describe("axe", () => {
    test.use({ bypassCSP: true });
    const routes = [
      { name: "shell", path: "/chat" as string | null },
      { name: "chat", path: fixtures.qaThreadId ? `/chat/${fixtures.qaThreadId}` : null },
      { name: "code", path: "/code" },
      { name: "library", path: "/library" },
      { name: "settings", path: "/settings" },
    ];
    for (const route of routes) {
      test(`axe: ${route.name}`, async ({ page }, testInfo) => {
        test.skip(!route.path, "no seeded fixture for this route");
        await openAndSettle(page, route.path!);
        const report = await runAxe(page);
        await recordGate(testInfo, "a11y.axe", { value: report.blocking.length, detail: formatAxe(report), context: { route: route.path } });
      });
    }
    test.describe("anonymous", () => {
      test.use(anonymous);
      test("axe: sign-in", async ({ page }, testInfo) => {
        await openAndSettle(page, "/sign-in");
        const report = await runAxe(page);
        await recordGate(testInfo, "a11y.axe", { value: report.blocking.length, detail: formatAxe(report), context: { route: "/sign-in" } });
      });
    });
  });

  test("bubble and composer geometry parity", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-1440", "geometry is measured once, at 1440");
    const records: GeometryRecord[] = [];
    if (fixtures.qaThreadId) {
      await openAndSettle(page, `/chat/${fixtures.qaThreadId}`);
      records.push(await measureWebGeometry(page, "web-chat"));
    }
    if (fixtures.qaCodeSessionId) {
      await openAndSettle(page, `/code/${fixtures.qaCodeSessionId}`);
      records.push(await measureWebGeometry(page, "web-code"));
    }
    for (const record of records) writeGeometryRecord(WEB_GEOMETRY_DIR, record);
    records.push(...readNativeGeometry(NATIVE_GEOMETRY_DIR));
    test.skip(records.length === 0, "no context to measure (no seeded fixtures and no native exports)");
    const parity = evaluateParity(records);
    await testInfo.attach("geometry.json", { body: JSON.stringify(records, null, 2), contentType: "application/json" });
    await recordGate(testInfo, "design.bubble-composer-parity", {
      pass: parity.pass,
      detail: parity.pass ? `${parity.contexts.length} contexts conform` : parity.mismatches.join("; "),
      context: { contexts: parity.contexts.join(", ") },
    });
  });

  test("CVD harness self-test: filters and shape masks in a real browser", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-1440", "a harness check, run once");
    // A hand and a circle-x drawn in the spec's light signal and destructive
    // inks. This checks the harness, not StatusMark: P2's status fixture is
    // what a11y.cvd-status-shapes measures.
    await page.setContent(`<!doctype html><body style="margin:0;background:#fff">
      <div style="display:flex;gap:16px;padding:16px;background:#fff">
        <svg id="hand" width="64" height="64" viewBox="0 0 24 24"><g fill="#D36317">
          <rect x="6" y="10" width="11" height="11" rx="3"/><rect x="6" y="4" width="2.4" height="9" rx="1.2"/>
          <rect x="9.2" y="2.5" width="2.4" height="10" rx="1.2"/><rect x="12.4" y="3" width="2.4" height="10" rx="1.2"/>
          <rect x="15.6" y="5" width="2.4" height="8" rx="1.2"/><rect x="3" y="12" width="5" height="2.4" rx="1.2" transform="rotate(35 5.5 13.2)"/></g></svg>
        <svg id="x" width="64" height="64" viewBox="0 0 24 24"><g fill="none" stroke="#B81E28" stroke-width="2.2" stroke-linecap="round">
          <circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></g></svg>
      </div></body>`);
    const hand = decodePng(await page.locator("#hand").screenshot());
    const cross = decodePng(await page.locator("#x").screenshot());
    for (const kind of CVD_GATE_KINDS) {
      const comparison = compareShapeMasks(simulateCvd(hand, kind), simulateCvd(cross, kind));
      expect(comparison.distinguishable, `${kind}: ${comparison.detail}`).toBe(true);
    }
    // The in-page SVG filter and the Node simulation agree on the hand's ink.
    await applyCvdFilter(page, "deuteranopia");
    const filtered = decodePng(await page.locator("#hand").screenshot());
    const simulated = simulateCvd(hand, "deuteranopia");
    const centre = (bitmap: typeof hand) => {
      const o = (Math.floor(bitmap.height * 0.65) * bitmap.width + Math.floor(bitmap.width * 0.48)) * 4;
      return [bitmap.data[o], bitmap.data[o + 1], bitmap.data[o + 2]];
    };
    const [a, b] = [centre(filtered), centre(simulated)];
    expect(Math.max(...a.map((v, i) => Math.abs(v - b[i]))), `filter ${a} vs simulation ${b}`).toBeLessThanOrEqual(12);
  });
});

describeMatrix("visual matrix @matrix", (variant) => {
  for (const route of matrixRoutes(fixtures)) {
    test.describe(route.name, () => {
      if (route.anonymous) test.use(anonymous);
      test(`route ${route.name}`, async ({ page }, testInfo) => {
        test.skip(!route.path, route.reason ?? "no path");
        const status = await openAndSettle(page, route.path!);
        const shot = await captureMatrixShot(page, testInfo, { name: `route-${route.name}`, variant, baselineDir: path.join(BASELINES, "visual") });
        const detail =
          shot.status === "changed" && shot.diff
            ? `${shot.diff.differing} of ${shot.diff.total} pixels changed (${(shot.diff.ratio * 100).toFixed(2)}%)`
            : shot.status === "captured"
              ? "captured; no baseline to compare yet"
              : shot.status;
        await recordGate(testInfo, "visual.route-matrix", {
          pass: shot.status !== "changed",
          detail,
          context: { route: route.path, variant: variant.key, status: shot.status, http: status },
        });
      });
    });
  }
});
