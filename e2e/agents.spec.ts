import { test, expect } from "@playwright/test";

// Agents (docs/design/agents-rework/DIRECTION.md), authenticated through the
// shared storage state. There is no hiring step: Agents home is one sentence
// field. Nothing here submits it, because the first message goes to a model.

test.describe("Agents", () => {
  test("Agents home is a sentence field, not a form", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: /who should take care of it/i })).toBeVisible({ timeout: 15_000 });

    const field = page.getByLabel("Describe a job");
    const start = page.getByRole("button", { name: "Start" });
    await expect(start).toBeDisabled();

    // A suggestion fills the field; it never sends on its own.
    await page.getByRole("button", { name: /watch flights to tokyo/i }).click();
    await expect(field).toHaveValue(/Tokyo/);
    await expect(page).toHaveURL(/\/agents$/);
    await expect(start).toBeEnabled();
  });

  test("the old hire route lands on Agents home", async ({ page }) => {
    await page.goto("/agents/new?template=researcher&form=1");
    await expect(page).toHaveURL(/\/agents$/, { timeout: 15_000 });
  });
});
