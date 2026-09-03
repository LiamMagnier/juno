import { test, expect, type Page } from "@playwright/test";
import { composer } from "./helpers";

// Regenerate with a switched model, end to end through the real chat route:
// send a turn, open Regenerate ▾ → Switch model, pick a model that is not the
// current one, and prove the retry went out with the override (request body)
// and landed as a second version (pager). Runs against the deterministic
// smoke provider, so the reply text is controlled and no quota is spent.
const TOKEN = "JUNO_REGEN_PROBE_OK";

async function sendTurn(page: Page, prompt: string) {
  await page.goto("/chat");
  const input = composer(page);
  await input.fill(prompt);
  const send = page.locator(".composer-primary-action");
  await expect(send).toBeEnabled({ timeout: 5_000 });
  const firstResponse = page.waitForResponse(
    (response) => {
      const request = response.request();
      return request.method() === "POST" && new URL(response.url()).pathname === "/api/chat";
    },
    { timeout: 30_000 },
  );
  await send.click();
  const response = await firstResponse;
  expect(response.ok()).toBeTruthy();
  await expect(page.locator(".prose-juno").last()).toContainText(TOKEN, { timeout: 90_000 });
  const body = response.request().postDataJSON() as { model?: string };
  return body.model ?? null;
}

test.describe("Regenerate with a switched model", () => {
  test("switch-model retry sends the override and keeps both versions", async ({ page }) => {
    const firstModel = await sendTurn(page, `Regen probe: reply with the exact token ${TOKEN}.`);

    // The actions row reveals on hover; the Regenerate ▾ trigger is only on
    // the last assistant message while idle.
    const lastAssistant = page.locator(".prose-juno").last();
    await lastAssistant.hover();
    await page.getByRole("button", { name: "Regenerate" }).click();
    // Click the sub-trigger: a bare hover raced Radix's submenu mount, and the
    // menu-item scan below then only ever saw the outer menu (where every
    // entry carries an icon) and skipped switching entirely.
    await page.getByRole("menuitem", { name: "Switch model" }).click();

    // Radix portals each open menu into its own container in open order: the
    // outer Regenerate menu first, the model submenu second. Scoping to the
    // second keeps the outer entries (Try again / More concise / …, all with
    // icons) out of the scan; inside the submenu only the current model's row
    // carries the check-mark svg.
    const menus = page.locator('[role="menu"]');
    await expect(menus).toHaveCount(2, { timeout: 10_000 });
    const options = menus.nth(1).getByRole("menuitem");
    const count = await options.count();
    expect(count).toBeGreaterThan(1);
    let switched = false;
    for (let i = 0; i < count; i++) {
      const option = options.nth(i);
      if ((await option.locator("svg").count()) > 0) continue;
      const retryResponse = page.waitForResponse(
        (response) => {
          const request = response.request();
          return request.method() === "POST" && new URL(response.url()).pathname === "/api/chat";
        },
        { timeout: 30_000 },
      );
      await option.click();
      const response = await retryResponse;
      expect(response.ok()).toBeTruthy();
      const body = response.request().postDataJSON() as { model?: string; regenerate?: boolean };
      expect(body.regenerate).toBe(true);
      if (firstModel != null) expect(body.model).not.toBe(firstModel);
      switched = true;
      break;
    }
    expect(switched).toBe(true);

    // Both versions survive: the pager reads 2/2 on the regenerated answer.
    await expect(page.getByText("2/2").first()).toBeVisible({ timeout: 90_000 });
  });
});
