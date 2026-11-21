import { expect, test } from "@playwright/test";
import { AGENTS } from "../src/app/dev/pages/fixtures";

test("Settings applies a preset and shares a saved design code", async ({ page }) => {
  await page.goto("/settings");
  const browse = page.getByRole("button", { name: "Browse designs" });
  await browse.click();
  const designs = page.getByRole("region", { name: "Design options" });
  await expect(page.locator("#settings-general")).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Designs" })).toHaveCount(0);
  await designs.getByRole("button", { name: "Apply Paper" }).click();
  await expect(designs.getByRole("status")).toHaveText("Applied Paper.");
  await expect(designs.getByRole("button", { name: "Apply Paper" })).toHaveAttribute("aria-pressed", "true");
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
  await page.getByRole("button", { name: "Back to General" }).click();
  await expect(browse).toBeFocused();
  await page.reload();
  await browse.click();
  await designs.getByRole("button", { name: "Apply Blue reading room" }).click();
  await expect(designs.getByRole("status")).toHaveText("Applied Blue reading room.");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "#2750bd");
  await page.goto("/chat");
  await expect(page.locator(".composer-surface:visible").first()).toHaveCSS("border-top-left-radius", "36px");
  await page.getByRole("button", { name: /^Add files and more/ }).click();
  const menu = page.getByRole("menu", { name: /^Add files and more/ });
  await expect(menu).toHaveCSS("animation-duration", "0.12s");
  await expect(menu.getByRole("menuitem", { name: "From Library" })).toBeVisible();
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
  const task = page.getByRole("textbox", { name: "What should a new agent take care of?" });
  const rosterHeading = page.getByRole("heading", { name: "Your agents", exact: true });
  await expect(task).toBeInViewport();
  expect((await task.boundingBox())!.y).toBeLessThan((await rosterHeading.boundingBox())!.y);
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(task).toBeFocused();
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

test.describe("narrow workspace", () => {
  test.use({ viewport: { width: 320, height: 675 }, hasTouch: true });

  test("shows the Orbit composer and first agent before the computer list", async ({ page }) => {
    await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: AGENTS } }));
    await page.goto("/agents");
    const heading = page.getByRole("heading", { name: "Orbit", exact: true });
    const create = page.getByRole("button", { name: "New agent", exact: true });
    await expect(heading).toBeVisible();
    await expect(create).toBeVisible();
    const titleY = (await heading.boundingBox())!.y;
    expect(Math.abs((await create.boundingBox())!.y - titleY)).toBeLessThan(12);
    await expect(page.getByRole("textbox", { name: "What should a new agent take care of?" })).toBeInViewport();
    await expect(page.getByRole("button", { name: `More for ${AGENTS[0].name}` })).toBeInViewport();
    await expect(page.getByRole("heading", { name: "Computers", exact: true })).not.toBeInViewport();
  });

  test("shows a viewport-width Add sheet and returns focus on dismissal", async ({ page }) => {
    await page.goto("/chat");
    const trigger = page.getByRole("button", { name: /^Add files and more/ });
    await trigger.tap();
    const menu = page.getByRole("menu", { name: /^Add files and more/ });
    await expect(menu.getByRole("menuitem", { name: "From Library" })).toBeVisible();
    await expect.poll(async () => {
      const bounds = await menu.boundingBox();
      return bounds && [Math.round(bounds.x), Math.round(bounds.width), Math.round(bounds.y + bounds.height)];
    }).toEqual([8, 304, 667]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
