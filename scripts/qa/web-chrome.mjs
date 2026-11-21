// Uses the local dev fixtures. No account, paid model, or production session.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { expect as playwrightExpect } from "@playwright/test";

const expect = playwrightExpect.configure({ timeout: 60_000 });
const base = new URL(process.argv[2] ?? "http://127.0.0.1:3000");
assert(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Use a local development server.");
const browser = await chromium.launch({ executablePath: process.env.ORBIT_CHROMIUM || undefined });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(90_000);
  const visit = (path) => page.goto(new URL(path, base).href, { waitUntil: "domcontentloaded", timeout: 120_000 });

  await visit("/dev/composer-landing?view=private");
  const toggle = page.locator("[data-incognito-toggle]");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const center = () => toggle.locator("svg").evaluate((glyph) => {
    const box = glyph.getBoundingClientRect();
    return { x: box.x + box.width / 2, inset: glyph.closest("header").getBoundingClientRect().right - box.right };
  });
  const active = await center();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const inactive = await center();
  assert(Math.abs(active.x - inactive.x) <= 1, "The Incognito glyph must not move when the label appears");
  assert(inactive.inset <= 17, "The glyph is aligned to the header's inline end");

  await visit("/dev/pages?page=projects");
  const heading = page.getByRole("heading", { name: "Projects", exact: true });
  await expect(heading).toBeVisible();
  const iconSizes = await page.locator(".sidebar-nav-glyph svg").evaluateAll((icons) => Object.fromEntries(
    icons.map((icon) => {
      const box = icon.getBoundingClientRect();
      return [icon.dataset.glyph, [Math.round(box.width), Math.round(box.height)]];
    }),
  ));
  for (const name of ["JunoActivity", "JunoProjects", "JunoLibrary"]) {
    assert.deepEqual(iconSizes[name], [18, 18], `${name} shares the navigation glyph box`);
  }
  const pageAction = page.locator(".app-section-heading-actions").getByRole("button", { name: "New project" });
  assert((await pageAction.boundingBox()).x > (await heading.boundingBox()).x, "Desktop actions sit beside the heading");
  await page.setViewportSize({ width: 390, height: 844 });
  assert((await pageAction.boundingBox()).y > (await heading.boundingBox()).y, "Phone actions clear the heading");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "The phone page has no sideways overflow");

  await visit("/dev/pages/project/p-atlas?sources=invalid");
  await expect(page.locator("[data-page-root] #juno-main")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Atlas launch", exact: true })).toBeVisible();

  await visit("/dev/live-ui");
  await expect(page.locator(".live-card").first()).toBeVisible();
  assert(await page.locator(".live-card").first().evaluate((card) => card.scrollWidth <= card.clientWidth + 1), "Live UI controls stay within the phone card");
  assert.deepEqual(errors, [], "No client errors in the fixtures");
  console.log("Web chrome: Incognito alignment, navigation icons, responsive headers, malformed project sources, and mobile Live UI passed.");
} finally {
  await browser.close();
}
