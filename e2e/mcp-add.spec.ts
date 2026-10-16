import { test, expect } from "@playwright/test";
test.skip(Boolean(process.env.E2E_BASE_URL), "Development-only Connections fixture");

// This public dev fixture runs the production dialog. Provider calls are
// intercepted; database migration/custody is exercised in the separate DB suite.
for (const width of [1440, 390]) {
  test.describe(`unified MCP add at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, storageState: { cookies: [], origins: [] }, contextOptions: { reducedMotion: "reduce" } });
    test("token servers use the common add flow without displaying the secret", async ({ page }) => {
      let saved: Record<string, unknown> | undefined;
      await page.route("**/api/mcp/servers", async (route) => {
        saved = route.request().postDataJSON();
        await route.fulfill({ json: { server: { id: "fixture", name: "My tools", status: "ok" } }, status: 201 });
      });
      await page.goto("/dev/connections");
      await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
      await page.getByRole("radio", { name: "Use a token or no sign-in" }).check();
      await expect(page.getByRole("radio", { name: "Sign in", exact: true })).not.toBeChecked();
      await page.getByLabel("Server name", { exact: true }).fill("My tools");
      const secret = page.getByLabel("Authorization header (optional)");
      await secret.fill("Bearer fixture-private-value");
      await expect(secret).toHaveAttribute("type", "password");
      await page.getByRole("textbox", { name: "Server address", exact: true }).fill("https://tools.example.com/mcp");
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText("Tokens are stored encrypted.", { exact: false })).toBeInViewport({ ratio: 1 });
      const bounds = await page.getByRole("dialog").boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `/tmp/alevr-mcp-add-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Save server", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      expect(saved).toEqual({ name: "My tools", url: "https://tools.example.com/mcp", authHeader: "Bearer fixture-private-value" });
      await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
      await page.getByRole("radio", { name: "Use a token or no sign-in" }).check();
      await expect(page.getByLabel("Authorization header (optional)")).toHaveValue("");
      await page.keyboard.press("Escape");
    });
    test("OAuth and error recovery stay in the same dialog", async ({ page }) => {
      let calls = 0;
      await page.route("**/api/connectors/custom/probe", async (route) => {
        calls++;
        await route.fulfill({ json: calls === 1 ? { ok: false, reason: "unreachable", message: "This server is unavailable. Try again." } : { ok: true, url: "https://tools.example.com/mcp", host: "tools.example.com", authHost: "auth.example.com", suggestedName: "My tools", existing: null } });
      });
      await page.goto("/dev/connections");
      await page.getByRole("button", { name: "Add MCP server", exact: true }).click();
      await expect(page.getByRole("radio", { name: "Sign in", exact: true })).toBeChecked();
      await page.getByRole("textbox", { name: "Server address", exact: true }).fill("https://tools.example.com/mcp");
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(page.getByText("This server is unavailable. Try again.")).toBeVisible();
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Found it", exact: true })).toBeVisible();
      await expect(page.getByText("auth.example.com", { exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
    });
  });
}
