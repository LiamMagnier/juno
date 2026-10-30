import { test, expect } from "@playwright/test";
import { AGENT_JOB_EXAMPLES } from "../src/lib/agents/new-agent";

// Agents (docs/design/agents-rework/DIRECTION.md), authenticated through the
// shared storage state. Agents home is one sentence field; the full hire form
// is still there for anyone who asks for it (`?form=1`), on a plan that
// includes agents (src/app/(app)/agents/new/page.tsx). Nothing here submits
// either, because a new agent's first message goes to a model. The journey
// that does hire and run one is e2e/agents-journey.spec.ts.

test.describe("Agents", () => {
  test("Agents home is a sentence field, not a form", async ({ page }) => {
    await page.goto("/agents");
    // An account with no agent yet gets the first-agent field under a
    // question; one that keeps agents gets the same field under its crew.
    const field = page.getByLabel(/^(Describe a job for your first agent|What should a new agent take care of\?)$/);
    await expect(field).toBeVisible({ timeout: 30_000 });
    const create = page.locator("form").filter({ has: field }).getByRole("button", { name: "Create agent" });
    await expect(create).toBeDisabled();

    // An example fills the field; it never sends on its own.
    await field.focus();
    await field.press("Tab");
    await expect(field).toHaveValue(AGENT_JOB_EXAMPLES[0]);
    await expect(page).toHaveURL(/\/agents$/);
    await expect(create).toBeEnabled();
  });

  test("the full hire form is still there when asked for", async ({ page }) => {
    await page.goto("/agents/new?template=researcher&form=1");
    await expect(page).toHaveURL(/\/agents\/new\?template=researcher&form=1$/);
    await expect(page.getByRole("heading", { name: "Create agent" })).toBeVisible({ timeout: 30_000 });
    // The template asked for is the starting point, and its defaults fill the form.
    await expect(page.getByRole("radio", { name: /^Researcher/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Scout");
    await expect(page.getByRole("button", { name: "Create Scout" })).toBeEnabled();
  });

  test("without ?form=1, New agent is the team page with its field", async ({ page }) => {
    await page.goto("/agents/new?template=researcher");
    await expect(page).toHaveURL(/\/agents\/new\?template=researcher$/);
    await expect(page.getByLabel(/^(Describe a job for your first agent|What should a new agent take care of\?)$/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Create agent" })).toHaveCount(0);
  });
});
