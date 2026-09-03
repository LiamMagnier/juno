import { test, expect } from "@playwright/test";

// Authenticated through the shared storage state; asserts real routes and
// headings rather than "a nav exists somewhere".

test.describe("Projects, Work and Library", () => {
  test("signed-in navigation reaches Projects, Work and Library routes", async ({ page }) => {
    for (const [path, heading] of [
      ["/projects", /projects/i],
      ["/work", /work/i],
      ["/library", /files/i],
    ] as const) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(path));
      await expect(page.locator("h1").first()).toContainText(heading, {
        timeout: 15_000,
      });
    }
  });

  test("settings page exposes preferences", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.locator("h1").first()).toContainText(/Settings/i, {
      timeout: 15_000,
    });
  });
});