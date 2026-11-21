import { expect, test } from "@playwright/test";
import { AGENTS } from "../src/app/dev/pages/fixtures";

test("Settings applies a preset and shares a saved design code", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Browse designs" }).click();
  const designs = page.getByRole("dialog", { name: "Designs" });
  await designs.getByRole("button", { name: "Apply Paper" }).click();
  await expect(designs.getByRole("status")).toHaveText("Applied Paper.");
  await expect(page.locator("html")).toHaveAttribute("data-composer-shape", "compact");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "juniper");

  await designs.getByRole("radio", { name: "Rounder" }).click();
  await designs.getByLabel("Save your current look").fill("My reading room");
  await designs.getByRole("button", { name: "Save design" }).click();
  await designs.getByRole("button", { name: "Share My reading room" }).click();
  const code = JSON.parse(await designs.getByLabel("Design code").inputValue());
  expect(code).toMatchObject({ name: "My reading room", accent: "juniper", composerShape: "soft" });

  await designs.getByLabel("Design code").fill(JSON.stringify({ ...code, name: "Blue reading room", accent: "#2750bd" }));
  await designs.getByRole("button", { name: "Import design" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Browse designs" }).click();
  await designs.getByRole("button", { name: "Apply Blue reading room" }).click();
  await expect(designs.getByRole("status")).toHaveText("Applied Blue reading room.");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "#2750bd");
});

test("Orbit offers appearance and requires confirmation to remove an agent", async ({ page }) => {
  let roster = AGENTS;
  const agent = AGENTS[1];
  const agentActions = page.getByRole("button", { name: `More for ${agent.name}` });
  let removals = 0;
  await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: roster } }));
  await page.route(`**/api/agents/${agent.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    removals++;
    roster = roster.filter(({ id }) => id !== agent.id);
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/agents");
  await agentActions.click();
  await page.getByRole("menuitem", { name: "Personalize" }).click();
  const studio = page.getByRole("dialog", { name: "Make it yours" });
  await expect(studio).toBeVisible();
  await page.keyboard.press("Escape");

  await agentActions.click();
  await page.getByRole("menuitem", { name: /Remove agent/ }).click();
  const confirm = page.getByRole("alertdialog", { name: `Remove ${agent.name}?` });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(removals).toBe(0);

  await agentActions.click();
  await page.getByRole("menuitem", { name: /Remove agent/ }).click();
  await confirm.getByRole("button", { name: "Remove agent", exact: true }).click();
  await expect(agentActions).toHaveCount(0);
  expect(removals).toBe(1);
  await expect(page.getByRole("link", { name: /Connect your Mac/ })).toBeVisible();
});
