import { expect, test, type Page } from "@playwright/test";

/*
 * Reviewing a repository's project hooks for cloud runs, on the real
 * /code/customize page. The page's own fetches to /api/code/hooks are answered
 * here, because the server side of review reads GitHub with the account's
 * connection, which a QA run does not have; the route itself (hashing,
 * re-reading at approval, ownership) is covered by tests/code-hook-trust.test.ts.
 */

const HASH = "3f".repeat(32);
const HOOKS = [
  { event: "PreToolUse", command: "npm run check-policy", matcher: ["write_file", "edit_file"], timeoutMs: 10000 },
  { event: "Stop", command: "npm run verify", matcher: null, timeoutMs: 60000 },
];

async function stubHooksApi(page: Page) {
  const state = { approved: false, posted: undefined as unknown };
  await page.route("**/api/code/hooks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      state.posted = request.postDataJSON();
      state.approved = true;
      await route.fulfill({
        status: 201,
        json: { approval: { id: "a1", repo: "acme/widgets", hash: HASH, ref: null, createdAt: new Date().toISOString(), hooks: HOOKS } },
      });
      return;
    }
    const approvals = state.approved
      ? [{ id: "a1", repo: "acme/widgets", hash: HASH, ref: null, createdAt: new Date().toISOString(), hooks: HOOKS }]
      : [];
    if (!url.searchParams.get("repo")) {
      await route.fulfill({ json: { approvals } });
      return;
    }
    await route.fulfill({
      json: {
        repo: "acme/widgets",
        ref: null,
        file: { present: true, hash: HASH, valid: true, hooks: HOOKS, text: "{}", approved: state.approved },
        approvals,
      },
    });
  });
  return state;
}

for (const width of [1440, 390]) {
  test.describe(`project hooks review at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, contextOptions: { reducedMotion: "reduce" } });

    test("a reviewed file lists its commands and is approved only after confirming", async ({ page }) => {
      const state = await stubHooksApi(page);
      await page.goto("/code/customize");

      const section = page.getByRole("heading", { name: "Project hooks" });
      await expect(section).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("No hooks are approved yet", { exact: false })).toBeVisible();

      await page.getByRole("combobox", { name: "Repository" }).fill("acme/widgets");
      await page.getByRole("button", { name: "Review hooks" }).click();
      await expect(page.getByText("npm run check-policy")).toBeVisible();
      await expect(page.getByText("npm run verify")).toBeVisible();
      await expect(page.getByText(HASH)).toBeVisible();

      await page.getByRole("button", { name: "Approve for cloud runs" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      expect(state.posted).toBeUndefined();
      await dialog.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(state.posted).toEqual({ repo: "acme/widgets", ref: null, hash: HASH });
      await expect(page.getByText("Approved for cloud runs")).toBeVisible();
      await expect(page.getByRole("button", { name: /Remove the approval for acme\/widgets/ })).toBeVisible();

      // No sideways scroll at phone width: long commands and the hash wrap or scroll inside their own box.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/code-project-hooks-${width}.png`, fullPage: true });
    });
  });
}
