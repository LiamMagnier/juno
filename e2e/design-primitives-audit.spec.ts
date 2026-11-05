import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settleAnimations, variantUse } from "./support/screenshot-matrix";

/**
 * Real production surfaces, using only the runner's disposable QA account.
 * No gallery route, model request, connector probe or account-setting write.
 * Attachments show resting UI; assertions cover responsive bounds, keyboard
 * focus, shared fields, and the reduced-motion preference actually in force.
 */
const profiles = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light", reducedMotion: "no-preference", mobile: false },
  { name: "desktop-light-reduced", width: 1440, height: 900, theme: "light", reducedMotion: "reduce", mobile: false },
  { name: "phone-dark", width: 390, height: 844, theme: "dark", reducedMotion: "no-preference", mobile: true },
  { name: "phone-dark-reduced", width: 390, height: 844, theme: "dark", reducedMotion: "reduce", mobile: true },
] as const;

async function captureAuditShot(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

async function expectWithinViewport(surface: Locator, page: Page) {
  const box = await surface.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

for (const profile of profiles) {
  test.describe(profile.name, () => {
    const variant = variantUse({ theme: profile.theme, motion: profile.reducedMotion === "reduce" ? "reduced" : "full" });
    test.use({
      ...variant,
      viewport: { width: profile.width, height: profile.height },
      isMobile: profile.mobile,
      hasTouch: profile.mobile,
      deviceScaleFactor: 1,
    });

    test("fields, menus and dialogs remain readable and reachable", async ({ page }, testInfo) => {
      await page.addInitScript((theme) => {
        localStorage.setItem("theme", theme);
        localStorage.setItem("juno:onboarded:v1", "1");
        localStorage.setItem("alevr:ui-prefs:v1", JSON.stringify({ motion: "system" }));
      }, profile.theme);

      await page.goto("/settings?section=personalization");
      expect(await page.evaluate(() => ({
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        contrast: matchMedia("(prefers-contrast: more)").matches,
        forced: matchMedia("(forced-colors: active)").matches,
      }))).toEqual({ dark: profile.theme === "dark", reduced: profile.reducedMotion === "reduce", contrast: false, forced: false });
      const name = page.getByRole("textbox", { name: /What .* calls you/ });
      const instructions = page.getByRole("textbox", { name: "Custom instructions", exact: true });
      await expect(name).toBeVisible({ timeout: 30_000 });
      await name.focus();
      await page.keyboard.press("Tab");
      await expect(instructions).toBeFocused();
      await settleAnimations(page);
      await expectWithinViewport(instructions, page);
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${profile.theme}\\b`));
      if (profile.mobile) {
        const bounds = await name.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        // Touch typography must not shrink this page's intentionally larger
        // writing area below its desktop minimum.
        const instructionsBounds = await instructions.boundingBox();
        expect(instructionsBounds!.height).toBeGreaterThanOrEqual(128);
        await expect(instructions).toHaveCSS("font-size", "16px");
      }
      await captureAuditShot(page, testInfo, `${profile.name}-settings-fields`);
      if (profile.name === "desktop-light") {
        // A forced-colors keyboard user needs the field boundary even when
        // the browser replaces the normal background and border palette.
        await page.emulateMedia(variantUse({ theme: "high-contrast", motion: "full" }).contextOptions);
        expect(await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches)).toBe(true);
        await page.emulateMedia(variantUse({ theme: "forced-colors", motion: "full" }).contextOptions);
        expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
        await instructions.press("Shift+Tab");
        await expect(name).toBeFocused();
        await expect(name).toHaveCSS("outline-style", "solid");
        await expect(name).toHaveCSS("outline-width", "2px");
        await expect(name).toHaveCSS("outline-offset", "2px");
        await page.emulateMedia(variant.contextOptions);
      }

      const language = page.getByRole("combobox", { name: "Response language", exact: true });
      await language.scrollIntoViewIfNeeded();
      await language.focus();
      await page.keyboard.press("Space");
      const options = page.getByRole("listbox");
      await expect(options).toBeVisible();
      await settleAnimations(page);
      await expectWithinViewport(options, page);
      await page.keyboard.press("End");
      await expect(page.getByRole("option", { name: "Arabic", exact: true })).toBeFocused();
      await expect(page.getByRole("option", { name: "Arabic", exact: true })).toBeInViewport();
      await captureAuditShot(page, testInfo, `${profile.name}-settings-select`);
      await page.keyboard.press("Escape");
      await expect(options).toHaveCount(0);
      await expect(language).toBeFocused();

      await page.goto("/connections");
      const add = page.getByRole("button", { name: /^Add an MCP server/ })
        .or(page.getByRole("button", { name: "Add", exact: true })).first();
      await expect(add).toBeVisible({ timeout: 30_000 });
      await add.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Add an MCP server", exact: true })).toBeVisible();
      await dialog.getByRole("radio", { name: "Use a token or no sign-in", exact: true }).check();
      await expect(dialog.getByRole("button", { name: "Save server", exact: true })).toBeDisabled();
      await dialog.getByRole("textbox", { name: "Server name", exact: true }).fill("Audit example");
      const address = dialog.getByRole("textbox", { name: "Server address", exact: true });
      await address.fill("https://audit-example.invalid/mcp");
      await expect(dialog.getByRole("button", { name: "Save server", exact: true })).toBeEnabled();
      await address.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(address).toBeFocused();
      await settleAnimations(page);
      await expectWithinViewport(dialog, page);
      await expect(page.locator("[data-swipe-scrim]")).toHaveCSS("backdrop-filter", "none");
      if (profile.mobile) {
        // A growing field in a column must retain the same touch height as
        // its siblings; flex: 1 is only appropriate in the desktop row.
        const addressBounds = await address.boundingBox();
        expect(addressBounds!.height).toBeGreaterThanOrEqual(44);
        await expect(dialog).toHaveCSS("border-bottom-left-radius", "0px");
        await expect(dialog).toHaveCSS("border-bottom-right-radius", "0px");
      }
      if (profile.reducedMotion === "reduce") {
        expect(await dialog.evaluate((element) => getComputedStyle(element).getPropertyValue("--motion-shift").trim())).toBe("0");
      }
      await captureAuditShot(page, testInfo, `${profile.name}-connector-dialog`);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(add).toBeFocused();
    });
  });
}
