/** Real canvas lifecycle, without sign-in, model calls or application data.
 * DESIGN_TEST_BASE_URL=http://127.0.0.1:3157 npx tsx --test tests/galaxy-motion.browser.test.ts
 * Run against a local development server; production excludes the gallery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.DESIGN_TEST_BASE_URL;

test("mobile settings keeps Back to app above the app's phone navigation", { skip: !base, timeout: 90_000 }, async () => {
  const url = new URL(base!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await page.goto(new URL("/dev/pages?page=settings", url).href);
    const back = page.getByRole("button", { name: "Back to app", exact: true });
    await back.waitFor({ state: "visible" });
    assert.ok(await back.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return [0.25, 0.5, 0.75].every((fraction) => button.contains(document.elementFromPoint(box.x + box.width * fraction, box.y + box.height / 2)));
    }), "the app's menu and title must not cover the settings back control");
  } finally {
    await browser.close();
  }
});

test("the working galaxy follows the app motion preference live and on reload, as well as the OS", { skip: !base, timeout: 90_000 }, async () => {
  const url = new URL(base!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "this fixture runs only on loopback");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await page.goto(new URL("/dev/brand#galaxy", url).href);
    const canvas = page.getByTestId("galaxy-light-24").locator("canvas");
    await canvas.scrollIntoViewIfNeeded();
    const pixels = () => canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
    const pause = () => page.waitForTimeout(240);
    // Let hydration and the real entrance finish before comparing settled pixels.
    await page.waitForTimeout(650);
    const moving = await pixels();
    await pause();
    assert.notEqual(await pixels(), moving, "real work moves when motion is allowed");

    await page.evaluate(() => document.documentElement.setAttribute("data-motion", "reduced"));
    await pause();
    const reduced = await pixels();
    await pause();
    assert.ok(await pixels() === reduced, "the in-app Reduced choice must stop canvas frames immediately");

    await page.evaluate(() => document.documentElement.removeAttribute("data-motion"));
    await pause();
    const resumed = await pixels();
    await pause();
    assert.notEqual(await pixels(), resumed, "returning to System resumes real work");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await pause();
    const osReduced = await pixels();
    await pause();
    assert.ok(await pixels() === osReduced, "OS Reduce Motion holds the same still frame");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => localStorage.setItem("alevr:ui-prefs:v1", JSON.stringify({ motion: "reduced" })));
    await page.reload();
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(650);
    const restored = await pixels();
    await pause();
    assert.ok(await pixels() === restored, "the saved app choice applies before and after hydration");
  } finally {
    await browser.close();
  }
});
