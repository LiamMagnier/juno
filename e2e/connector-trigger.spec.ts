import { test, expect } from "@playwright/test";
test.skip(Boolean(process.env.E2E_BASE_URL), "Development-only trigger fixture");

for (const width of [1440, 390]) {
  test.describe(`connector stream at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, storageState: { cookies: [], origins: [] }, contextOptions: { reducedMotion: "reduce" } });
    test("Slack requires a channel and saves it without losing resource filters", async ({ page }) => {
      await page.goto("/dev/connector-triggers");
      const channel = page.getByLabel("Slack channel ID", { exact: true });
      await expect(channel).toBeVisible();
      await expect(channel).toHaveAttribute("required", "");
      await page.getByRole("button", { name: "Save trigger" }).click();
      await expect(page.getByLabel("Saved trigger", { exact: true })).toHaveText("");
      await channel.fill("C123456");
      await page.getByRole("button", { name: "Save trigger" }).click();
      const saved = JSON.parse((await page.getByLabel("Saved trigger", { exact: true }).textContent())!);
      expect(saved[0].config.attributes).toEqual({ resourceId: "keep-filter", stream: "C123456" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
    test("Calendar can select a stream or retain the primary-calendar default", async ({ page }) => {
      await page.goto("/dev/connector-triggers");
      await page.getByLabel("Connector", { exact: true }).fill("google-calendar");
      const calendar = page.getByLabel("Calendar ID (optional)", { exact: true });
      await expect(calendar).toBeVisible();
      await expect(page.getByLabel("Slack channel ID", { exact: true })).toHaveCount(0);
      await calendar.fill("team@example.com");
      await page.getByRole("button", { name: "Save trigger" }).click();
      let saved = JSON.parse((await page.getByLabel("Saved trigger", { exact: true }).textContent())!);
      expect(saved[0].config.attributes).toEqual({ resourceId: "keep-filter", stream: "team@example.com" });
      await calendar.clear();
      await page.getByRole("button", { name: "Save trigger" }).click();
      saved = JSON.parse((await page.getByLabel("Saved trigger", { exact: true }).textContent())!);
      expect(saved[0].config.attributes).toEqual({ resourceId: "keep-filter" });
      await page.getByLabel("Connector", { exact: true }).fill("gmail");
      await expect(calendar).toHaveCount(0);
      await expect(page.getByLabel("Connector", { exact: true })).toHaveAttribute("placeholder", "gmail");
    });
  });
}
