import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { mountOnSignIn, p0Support, renderFixtures } from "./support";

/**
 * P2-web-foundations, browser acceptance (spec appendix, P2 "Playwright",
 * "Screenshots", "axe"). Runs on a production build through the P0 runner
 * (scripts/qa/run-prod-e2e.sh), never a dev server.
 *
 * The components are server-rendered in the test process and mounted on the
 * anonymous sign-in page, which ships the production stylesheet: no fixture
 * route is added to the product, and no seed can make a check pass vacuously.
 * Checks that need the live app (toasts above a real composer, the route
 * budget) visit real routes with the P0 matrix's signed-in storage state.
 */

const anonymous = { storageState: { cookies: [], origins: [] } };
const SHOTS = path.join(process.cwd(), "e2e", "wave2", "p2-foundations", "baselines");

let fixtures: Record<string, string>;
test.beforeAll(async () => {
  fixtures = await renderFixtures();
});

async function animationKeyframes(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) =>
    el.getAnimations().map((a) => ({
      name: (a as CSSAnimation).animationName ?? "",
      frames: ((a.effect as KeyframeEffect | null)?.getKeyframes() ?? []).map((k) => ({ opacity: String(k.opacity ?? ""), transform: String(k.transform ?? "") })),
    })),
  );
}

test.describe("fixtures on the production stylesheet", () => {
  test.use(anonymous);

  test("a11y.cvd-status-shapes: hand and circle-x stay distinguishable under deuteranopia and protanopia", async ({ page }, testInfo) => {
    const support = await p0Support();
    test.skip(!support, "P0's CVD harness (e2e/support/cvd.ts) is not on this branch");
    for (const theme of ["light", "dark"] as const) {
      await mountOnSignIn(page, `<style>.cvd-scale .alevr-status-mark{transform:scale(4.5);transform-origin:top left}</style>${fixtures.cvdPair}`, theme === "dark" ? { class: "dark" } : {});
      const hand = support!.decodePng(await page.locator("#cvd-hand").screenshot());
      const cross = support!.decodePng(await page.locator("#cvd-cross").screenshot());
      const results = support!.CVD_GATE_KINDS.map((kind) => ({ kind, ...support!.compareShapeMasks(support!.simulateCvd(hand, kind), support!.simulateCvd(cross, kind)) }));
      await support!.recordGate(testInfo, "a11y.cvd-status-shapes", {
        pass: results.every((r) => r.distinguishable),
        detail: results.map((r) => `${theme} ${r.kind}: ${r.detail}`).join("; "),
        context: { theme },
      });
    }
  });

  test("galaxy ink under forced colours equals the Highlight system colour", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "forced-colors emulation is Chromium-only");
    await page.emulateMedia({ forcedColors: "active" });
    await mountOnSignIn(page, `${fixtures.galaxy}<span id="probe" style="color:Highlight;forced-color-adjust:none">x</span>`);
    const [ink, highlight] = await page.evaluate(() => [
      getComputedStyle(document.querySelector("#galaxy-fixture .alevr-galaxy-still")!).color,
      getComputedStyle(document.getElementById("probe")!).color,
    ]);
    expect(ink).toBe(highlight);
    // The still frame is a mask over currentColor: no canvas while it is not animating.
    await expect(page.locator("#galaxy-fixture canvas")).toHaveCount(0);
  });

  for (const mode of ["os", "in-app"] as const) {
    test(`under ${mode} reduced motion, overlay entrances keep opacity and lose their transform`, async ({ page }) => {
      if (mode === "os") await page.emulateMedia({ reducedMotion: "reduce" });
      await mountOnSignIn(
        page,
        `<div id="frequent" class="ui-overlay-frequent" data-state="open">Menu</div>
         <div id="infrequent" class="ui-overlay-infrequent" data-state="open">Dialog</div>`,
        mode === "in-app" ? { "data-motion": "reduced" } : {},
      );
      for (const id of ["#frequent", "#infrequent"]) {
        const animations = await animationKeyframes(page, id);
        expect(animations.length, `${id} still animates`).toBeGreaterThan(0);
        const frames = animations.flatMap((a) => a.frames);
        expect(frames.some((f) => f.opacity === "0"), `${id} keeps its fade`).toBeTruthy();
        for (const f of frames) expect(["", "none", "scale(1)", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(f.transform);
      }
    });
  }

  test("with motion allowed, a frequent overlay grows from 0.97 and a keyboard-opened one only fades", async ({ page }) => {
    await mountOnSignIn(page, `<div id="frequent" class="ui-overlay-frequent" data-state="open">Menu</div>`);
    const frames = (await animationKeyframes(page, "#frequent")).flatMap((a) => a.frames);
    expect(frames.some((f) => /0\.97/.test(f.transform))).toBeTruthy();
    await mountOnSignIn(page, `<div id="kbd" class="ui-overlay-frequent" data-state="open">Menu</div>`, { "data-input-modality": "keyboard" });
    const kbd = (await animationKeyframes(page, "#kbd")).flatMap((a) => a.frames);
    expect(kbd.every((f) => f.transform === "" || f.transform === "none")).toBeTruthy();
  });

  test("toast offset expression: composer height plus 16, and 16 without a composer", async ({ page }) => {
    await mountOnSignIn(page, `<div id="t" style="position:fixed;bottom:calc(var(--composer-h, 0px) + 16px);height:10px;width:10px"></div>`);
    const gap = () => page.evaluate(() => window.innerHeight - document.getElementById("t")!.getBoundingClientRect().bottom);
    expect(await gap()).toBe(16);
    await page.evaluate(() => document.documentElement.style.setProperty("--composer-h", "96px"));
    expect(await gap()).toBe(112);
  });

  test("screenshots: status marks, empty state, skeleton, chips, quote, bubble and approval", async ({ page }, testInfo) => {
    const themes: Array<[string, Record<string, string>]> = [
      ["light", {}],
      ["dark", { class: "dark" }],
      ["contrast", { "data-contrast": "more" }],
    ];
    for (const [theme, attrs] of themes) {
      await mountOnSignIn(
        page,
        `<div style="display:grid;gap:24px;max-width:720px">
          ${fixtures.statusGrid}${fixtures.emptyState}${fixtures.skeleton}${fixtures.chips}${fixtures.quote}
          <div style="display:flex;justify-content:flex-end">${fixtures.bubble}</div>
          <div id="approval-host">${fixtures.approval}</div>
        </div>`,
        attrs,
      );
      // Let entrances finish so the capture is the end state.
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
      await page.locator("#p2-fixture").screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-${theme}-disarmed.png`), animations: "disabled" });
      // The armed approval (the arm itself is covered by the unit tests): the verb at full strength.
      await page.evaluate(() => {
        const verb = document.querySelector<HTMLElement>(".ui-approval-verb");
        verb?.classList.remove("opacity-60");
        verb?.removeAttribute("aria-disabled");
      });
      await page.locator("#approval-host").screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-${theme}-approval-armed.png`), animations: "disabled" });
    }
  });

  test("axe: no serious or critical violations on the fixture page", async ({ page }) => {
    const support = await p0Support();
    test.skip(!support?.runAxe, "P0's axe wrapper (e2e/support/axe.ts) is not on this branch");
    await mountOnSignIn(page, `${fixtures.statusGrid}${fixtures.emptyState}${fixtures.chips}${fixtures.quote}${fixtures.bubble}${fixtures.approval}`);
    const result = await support!.runAxe!(page, { include: "#p2-fixture" });
    const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});

/** A one-finger touch drag through CDP, `steps` samples `stepMs` apart, from (x0,y0) to (x1,y1). */
async function touchDrag(page: Page, from: [number, number], to: [number, number], { steps, stepMs }: { steps: number; stepMs: number }) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(...from) });
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
    await page.waitForTimeout(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test.describe("the phone drawer (a SheetContent) at 390", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "CDP touch input is Chromium-only");
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function openDrawer(page: Page) {
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.locator(".ui-sheet[data-drawer][data-state='open']");
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(300);
    return drawer;
  }

  test("a flick at 0.6px/ms dismisses", async ({ page }) => {
    const drawer = await openDrawer(page);
    const box = (await drawer.boundingBox())!;
    // 60px in 100ms toward the edge: 0.6px/ms.
    await touchDrag(page, [box.x + box.width - 40, box.y + 200], [box.x + box.width - 100, box.y + 200], { steps: 5, stepMs: 20 });
    await expect(page.locator(".ui-sheet[data-drawer]")).toHaveCount(0, { timeout: 2000 });
  });

  test("a 20% drag released slowly settles back without an instant jump", async ({ page }) => {
    const drawer = await openDrawer(page);
    const box = (await drawer.boundingBox())!;
    const travel = box.width * 0.2;
    await touchDrag(page, [box.x + box.width - 40, box.y + 200], [box.x + box.width - 40 - travel, box.y + 200], { steps: 20, stepMs: 40 });
    // Sample the panel's transform through the settle: it must pass through intermediate offsets.
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await drawer.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41));
      await page.waitForTimeout(25);
    }
    expect(samples[samples.length - 1]).toBeCloseTo(0, 0);
    const intermediate = samples.filter((x) => Math.abs(x) > 1 && Math.abs(x) < travel - 1);
    expect(intermediate.length, `settle samples ${samples.join(", ")}`).toBeGreaterThan(0);
    await expect(drawer).toHaveAttribute("data-state", "open");
  });

  // The drawer leaves on the exit rung (160, D21); a bottom sheet's 220 dismiss is the same Presence
  // mechanism with a longer keyframe (sheet.css, checked in tests/wave2-p2-components.test.ts).
  test("a programmatic dismiss keeps the drawer mounted until its exit has played", async ({ page }) => {
    await openDrawer(page);
    // Measured in the page, frame by frame, from the Escape to the unmount:
    // Radix keeps the content mounted until its exit has played.
    const mountedMs = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const panel = document.querySelector(".ui-sheet[data-drawer]")!;
          const t0 = performance.now();
          panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          const tick = () => (panel.isConnected ? requestAnimationFrame(tick) : resolve(performance.now() - t0));
          requestAnimationFrame(tick);
        }),
    );
    expect(mountedMs).toBeGreaterThanOrEqual(150);
  });
});

test.describe("on the live app", () => {
  test("motion.galaxy-cap: never more than 3 animating galaxies per window", async ({ page }, testInfo) => {
    const support = await p0Support();
    const samples: number[] = [];
    for (const route of ["/chat", "/code", "/library"]) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      for (let i = 0; i < 12; i++) {
        samples.push(await page.evaluate(() => document.querySelectorAll(".alevr-galaxy-mark[data-animating]").length));
        await page.waitForTimeout(250);
      }
    }
    expect(Math.max(...samples)).toBeLessThanOrEqual(3);
    if (support) await support.recordGate(testInfo, "motion.galaxy-cap", { samples, detail: `max ${Math.max(...samples)} over ${samples.length} samples` });
  });

  test("route click → shell visible stays inside the 100ms budget at p95", async ({ page }) => {
    await page.goto("/chat", { waitUntil: "load" });
    const gaps: number[] = [];
    for (let i = 0; i < 10; i++) {
      const target = i % 2 === 0 ? "/library" : "/chat";
      await page.evaluate(() => performance.clearMarks());
      await page.locator(`a[href="${target}"]`).first().click();
      await page.waitForURL(`**${target}`);
      const gap = await page.waitForFunction(() => {
        const click = performance.getEntriesByName("alevr:route-click").pop();
        const shell = performance.getEntriesByName("alevr:shell-visible").pop();
        return click && shell && shell.startTime >= click.startTime ? shell.startTime - click.startTime : null;
      });
      gaps.push((await gap.jsonValue()) as number);
    }
    gaps.sort((a, b) => a - b);
    const p95 = gaps[Math.min(gaps.length - 1, Math.ceil(gaps.length * 0.95) - 1)];
    expect(p95).toBeLessThanOrEqual(100);
  });
});
