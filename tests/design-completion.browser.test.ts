/** Local, real-component interaction checks. No model or external app access.
 * DESIGN_TEST_BASE_URL=http://127.0.0.1:3157 npx tsx --test tests/design-completion.browser.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.DESIGN_TEST_BASE_URL;
const executablePath = process.env.DESIGN_TEST_CHROMIUM;
const launchOptions = executablePath ? { executablePath, headless: true } : { channel: "chrome", headless: true };
function localBase() {
  const url = new URL(base!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  return url;
}

test("menu glyphs stay still while an opted-in toolbar gesture honors reduced motion", { skip: !base, timeout: 90_000 }, async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
    await page.goto(new URL("/dev/pages?page=library", localBase()).href);
    await page.getByRole("button", { name: /Demo Account/ }).click();
    await page.mouse.move(1300, 100);
    await page.keyboard.press("s");
    const settings = page.getByRole("menuitem", { name: "Settings", exact: true });
    await settings.waitFor({ state: "visible" });
    await page.waitForTimeout(450);
    const menuTransform = () => settings.locator('svg[data-glyph="Settings"] .gm').evaluate((node) => getComputedStyle(node).transform);
    assert.equal(await menuTransform(), "none", "keyboard highlight leaves the menu glyph still");
    await settings.hover();
    await page.waitForTimeout(450);
    assert.equal(await menuTransform(), "none", "the menu glyph stays still on pointer highlight too");
    await page.keyboard.press("Escape");
    const sidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
    const toolbarTransform = () => sidebar.locator("svg[data-m] .gm").evaluate((node) => getComputedStyle(node).transform);
    await sidebar.hover();
    await page.waitForTimeout(450);
    assert.notEqual(await toolbarTransform(), "none", "the toolbar glyph responds to a fine pointer");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(180);
    assert.equal(await toolbarTransform(), "none", "Reduce Motion keeps the toolbar glyph still");
  } finally {
    await browser.close();
  }
});

test("Search opens on phone and desktop after its lazy chunk and stays inside the viewport", { skip: !base, timeout: 90_000 }, async () => {
  const browser = await chromium.launch(launchOptions);
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
      await page.goto(new URL("/dev/pages?page=search", localBase()).href);
      const dialog = page.getByRole("dialog", { name: "Search everything" });
      await dialog.waitFor({ state: "visible" });
      assert.ok(await dialog.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight;
      }), `the ${width}px Search window stays reachable`);
      await page.getByRole("combobox", { name: "Search everything" }).fill("Atlas");
      await page.getByRole("group", { name: "Filter by type" }).waitFor({ state: "visible" });
      assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), "filters scroll within the window");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
