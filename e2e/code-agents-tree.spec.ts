import { expect, test, type Page } from "@playwright/test";

/**
 * The Code v2 Agents tree (REA backlog 10) over the dev gallery's fixtures
 * (`/dev/code-v2?state=subagents`): an ARIA tree a keyboard can walk, a
 * selected node's controls, and a pane that fits a phone. The gallery is a
 * development page (page.dev.tsx), so against a production build this skips
 * instead of measuring a 404.
 */

test.use({ storageState: { cookies: [], origins: [] } });

async function openGallery(page: Page, query = "state=subagents&bare=1", { phone = false } = {}) {
  const response = await page.goto(`/dev/code-v2?${query}`);
  test.skip(!response || response.status() === 404, "the dev gallery is not served by this build");
  if (phone) {
    // Below 1024 the panel is a sheet the reader opens.
    await page.getByRole("button", { name: "Changes and panel" }).click({ timeout: 30_000 });
    const agentsTab = page.getByRole("tab", { name: /Agents/ });
    if (await agentsTab.count()) await agentsTab.first().click();
  }
  await expect(page.getByRole("tree", { name: "Agents in this run" })).toBeVisible({ timeout: 30_000 });
}

/** A row's own line (a treeitem's box also holds its children). */
const rowLine = (page: Page, name: string) => page.locator(`[role="treeitem"][aria-label^="${name},"] > .cv2-anode`);

test("the tree walks by keyboard and selecting a node shows its controls", async ({ page }) => {
  await openGallery(page);
  const tree = page.getByRole("tree", { name: "Agents in this run" });
  const items = tree.getByRole("treeitem");
  await expect(items).toHaveCount(6);

  // One row is in the tab order; arrows move it.
  const lead = items.first();
  await lead.focus();
  await expect(lead).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(lead).toBeFocused();

  // Worker 2 holds a nested helper: Left folds it, Right opens it again.
  const worker2 = tree.getByRole("treeitem", { name: /^Worker 2,/ });
  await worker2.focus();
  await expect(worker2).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(worker2).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("treeitem", { name: /^Hook audit,/ })).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { name: /^Hook audit,/ })).toHaveCount(1);

  // Enter selects: the detail follows, with its controls and the steer box.
  await page.keyboard.press("Enter");
  await expect(worker2).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Worker 2" })).toBeVisible();
  const controls = page.getByRole("toolbar", { name: "Agent controls" });
  await expect(controls.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(controls.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Steer Worker 2" })).toBeVisible();

  // A press is answered in the polite status line.
  await controls.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pauses after its current step." })).toBeVisible();

  // The paused helper offers Resume, never Pause.
  await rowLine(page, "Hook audit").click();
  await expect(page.getByRole("toolbar", { name: "Agent controls" }).getByRole("button", { name: "Resume" })).toBeVisible();
});

test("the lead's Stop run asks once more before it stops", async ({ page }) => {
  await openGallery(page);
  await rowLine(page, "Lead").click();
  const run = page.getByRole("toolbar", { name: "Run controls" });
  await run.getByRole("button", { name: "Stop run" }).click();
  await expect(run.getByRole("button", { name: "Confirm stop" })).toBeVisible();
  await expect(page.getByText("Every agent stops and keeps its work so far.")).toBeVisible();
});

test("at phone width the pane fits without a sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGallery(page, "state=subagents&bare=1", { phone: true });
  const overflow = await page.evaluate(() => {
    const pane = document.querySelector(".cv2-agents");
    return pane ? pane.scrollWidth - pane.clientWidth : -1;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole("tree", { name: "Agents in this run" })).toBeVisible();
});
