import { test, expect } from "@playwright/test";

// Authenticated through the shared storage state; asserts real routes and
// headings rather than "a nav exists somewhere".

test.describe("Projects, Automations and Library", () => {
  test("signed-in navigation reaches Projects, Automations and Library routes", async ({ page }) => {
    for (const [path, heading] of [
      ["/projects", /projects/i],
      // `/work` used to be here. Work is not a place any more
      // (docs/design/TWO_PRODUCTS.md §2); the destination that came out of it
      // and is testable without a delegated run in the account is Automations.
      ["/automations", /automations/i],
      ["/library", /files/i],
    ] as const) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(path));
      await expect(page.locator("h1").first()).toContainText(heading, {
        timeout: 15_000,
      });
    }
  });

  test("the retired Work URLs land somewhere real instead of 404ing", async ({ page }) => {
    // The whole point of the migration route: a bookmark, an emailed link and a
    // shipped macOS build all hold one of these, and a 404 on any of them reads
    // as "Juno lost your work". `/work/<sessionId>` is deliberately not here —
    // it resolves against a row this account may not have — but every static
    // shape is, and they are asserted as URLs rather than headings so the test
    // fails on the redirect rather than on a page's copy.
    for (const [from, to] of [
      ["/work", "/chat"],
      ["/work/skills", "/skills"],
      ["/work/skills/new", "/skills/new"],
      ["/work/schedules", "/automations"],
      ["/work/schedules/new", "/automations/new"],
      ["/work/permissions", "/permissions"],
      ["/work/hosts", "/permissions"],
    ] as const) {
      await page.goto(from);
      await expect(page).toHaveURL(new RegExp(`${to}$`), { timeout: 15_000 });
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
