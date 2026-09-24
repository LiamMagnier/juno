import { test, expect } from "@playwright/test";

// Agents (docs/design/AGENTS.md), authenticated through the shared storage
// state. Hires from a starting point and follows the agent to its page and its
// thread, asserting the things a person reads — the name, the state sentence,
// the greeting in the agent's own voice — rather than markup. Nothing here
// needs a model: hiring, the page and an empty thread are all served without
// one, which is what keeps this runnable against a seeded local database.

test.describe("Agents", () => {
  test("hire an agent from a starting point, open its page and its thread", async ({ page }) => {
    const name = `Scout ${Date.now().toString(36).slice(-4)}`;

    await page.goto("/agents/new?template=researcher");
    await expect(page.locator("h1").first()).toContainText(/new agent/i, { timeout: 15_000 });
    await expect(page.getByRole("radio", { name: /researcher/i })).toHaveAttribute("aria-checked", "true");

    const nameField = page.getByLabel("Name", { exact: true });
    await nameField.fill(name);
    await page.getByRole("button", { name: new RegExp(`^Hire ${name}`) }).click();

    await expect(page).toHaveURL(/\/agents\/[^/?]+\?hired=1/, { timeout: 30_000 });
    await expect(page.locator("h1").first()).toHaveText(name);
    await expect(page.getByText(`${name} is here.`)).toBeVisible();
    // The face says its state in words beside it, never only in its eyes.
    await expect(page.getByRole("img", { name: new RegExp(`^${name}, `) }).first()).toBeVisible();
    await expect(page.getByText("Ready for something new")).toBeVisible();

    // The first goal the starting point offered was hired with it.
    await page.getByRole("radio", { name: /^Goals/ }).click();
    await expect(page.getByText("Keep me current on the topics I care about")).toBeVisible();

    await page.getByRole("button", { name: "Message", exact: true }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: new RegExp(`Hi, I.m ${name}`) })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder(`Message ${name}…`)).toBeVisible();

    // And it is in the sidebar's Agents fold, a live face and a name.
    await expect(page.getByRole("link", { name: new RegExp(`^${name}\\.`) }).first()).toBeVisible();
  });

  test("the roster lists agents and offers a new one", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.locator("h1").first()).toContainText(/agents/i, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: /new agent|chief of staff/i }).first()).toBeVisible();
  });
});
