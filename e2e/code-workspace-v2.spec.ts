import { expect, test } from "@playwright/test";

test("Code configures a delegated team and keeps the draft if the team cannot be saved", async ({ page }, testInfo) => {
  await page.route("**/api/code/workspaces", (route) => route.fulfill({
    json: { workspaces: [{ id: "qa-workspace", name: "Storefront", path: "/qa/storefront", lastOpenedAt: "2026-11-22T00:00:00.000Z" }] },
  }));
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({ status: 201, json: { conversation: { id: "qa-team-session" } } });
  });
  let routing: unknown;
  let cleaned = false;
  await page.route("**/api/code/routing/qa-team-session", (route) => {
    routing = route.request().postDataJSON().routing;
    return route.fulfill({ status: 400, json: { error: "This routing can't run." } });
  });
  await page.route("**/api/conversations/qa-team-session", (route) => {
    cleaned = route.request().method() === "DELETE";
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/code");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Make the checkout summary easier to scan.");
  await page.getByRole("button", { name: /No project picked yet/ }).click();
  await page.getByRole("option", { name: /Storefront/ }).click();
  const orchestrator = page.getByRole("button", { name: "Orchestrator", exact: true });
  await orchestrator.click();
  const picker = page.getByRole("dialog", { name: "Orchestrator" });
  const delegated = picker.getByRole("button", { name: /Lead \+ workers/ });
  await delegated.click();
  await expect(delegated).toHaveAttribute("aria-pressed", "true");
  await expect(picker.getByRole("button", { name: /Architect/ })).toHaveCount(0);
  await picker.getByRole("button", { name: "More workers" }).click();
  await expect(picker.getByRole("group", { name: "Workers" })).toContainText("×4");
  await page.screenshot({ path: testInfo.outputPath("code-orchestrator.png"), animations: "disabled" });
  await picker.getByRole("button", { name: "Close orchestrator" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Couldn’t save the orchestrator. Check the team models or try again.")).toBeVisible();
  await expect(draft).toHaveValue("Make the checkout summary easier to scan.");
  await expect(page).toHaveURL(/\/code$/);
  await expect.poll(() => cleaned).toBe(true);
  expect(routing).toMatchObject({ preset: "lead-workers", workers: { length: 4 } });
});

test("Code opens Agents directly and keeps the composer usable at narrow widths", async ({ page, isMobile }, testInfo) => {
  await page.goto("/code");
  const home = page.getByRole("heading", { name: "What will you build?" });
  await expect(home).toBeVisible();
  await expect(page.getByRole("link", { name: "Pull requests", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("code-landing.png"), animations: "disabled" });
  const recent = page.getByRole("region", { name: "Recent sessions" });
  await recent.getByRole("link", { name: /QA · Code session/ }).click();
  if (isMobile) {
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Sessions", exact: true })).toBeVisible();
  }
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  await agents.click();
  const pane = page.getByRole("tabpanel", { name: "Agents" });
  await expect(pane.getByRole("heading", { name: "No subagents in this run" })).toBeVisible();
  if (isMobile) {
    await expect(page.getByRole("dialog", { name: "Workspace panel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close the panel" })).toBeFocused();
  }
  await page.screenshot({ path: testInfo.outputPath("code-agents.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Close the panel" }).click();
  await expect(pane).toBeHidden();
  if (isMobile) await expect(agents).toBeFocused();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(draft).toBeVisible();
  expect(await page.locator(".cv2-cfoot").evaluate((bar) => bar.scrollWidth - bar.clientWidth)).toBeLessThanOrEqual(1);
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.locator(".cv2-cfoot").evaluate((bar) => bar.scrollWidth - bar.clientWidth)).toBeLessThanOrEqual(1);
  }
});
