import { expect, test } from "@playwright/test";
import { captureMatrixShot, describeMatrix } from "../../support/screenshot-matrix";

/*
 * P0 acceptance smoke (spec appendix P0, "Smoke run"): /chat renders on a
 * production build at 1440×900 and 390×844 (the chromium-1440, chromium-390
 * and webkit-390 projects), in light and dark. The runner's teardown then
 * proves nothing from the run is left alive.
 *
 * It asserts only what any version of /chat must show: a 2xx document, the
 * composer, no uncaught page error, and an end-state screenshot.
 */

describeMatrix(
  "p0 smoke: /chat",
  (variant) => {
    test("renders the chat home", async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      const response = await page.goto("/chat", { waitUntil: "domcontentloaded" });
      expect(response?.status(), "the /chat document").toBeLessThan(400);
      await expect(page).toHaveURL(/\/chat/);

      const composer = page.locator("#juno-composer-textarea, textarea").first();
      await expect(composer).toBeVisible({ timeout: 30_000 });

      const scheme = await page.evaluate(() => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
      expect(scheme).toBe(variant.theme === "dark" ? "dark" : "light");

      const viewport = page.viewportSize();
      expect(viewport?.width === 1440 || viewport?.width === 390, `viewport ${viewport?.width}×${viewport?.height}`).toBe(true);

      const shot = await captureMatrixShot(page, testInfo, { name: "p0-smoke-chat", variant });
      testInfo.annotations.push({ type: "screenshot", description: shot.file });
      expect(errors, "uncaught page errors").toEqual([]);
    });
  },
  { themes: ["light", "dark"], motions: ["full"] }
);
