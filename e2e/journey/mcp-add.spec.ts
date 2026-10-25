import { expect, test, type Page } from "@playwright/test";

/*
 * Adding an MCP server, end to end, on the real Connections page (ledger
 * P1-5). The older e2e/mcp-add.spec.ts drives a dev-only gallery page
 * (/dev/connections, a 404 on production builds) and a dialog the app no
 * longer mounts; this one goes through what a user sees: /connections →
 * "Add an MCP server" → the dialog → the real POST /api/mcp/servers → the
 * database → the list.
 *
 * The address is on the reserved .invalid TLD (RFC 2606), so it passes the
 * URL rules (https, public-looking host) but can never resolve: the server's
 * reachability probe fails fast and honestly, and nothing leaves the runner.
 */

const UNREACHABLE = "https://journey-tools.invalid/mcp";

/** The directory's "Add an MCP server" tile, or the header's Add button when the tile is filtered out. */
async function openAddDialog(page: Page): Promise<void> {
  const add = page
    .getByRole("button", { name: /^Add an MCP server/ })
    .or(page.getByRole("button", { name: "Add", exact: true }))
    .first();
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Add an MCP server" })).toBeVisible({ timeout: 15_000 });
}
const SECRET = "Bearer journey-fixture-not-a-real-token";

test.describe("MCP add", () => {
  test("a token server is saved through the real API, never echoes its secret, and stays listed", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    // Unique per attempt: names are unique per account, and a retry reuses it.
    const name = `Journey tools ${testInfo.retry}-${Date.now().toString(36)}`;

    await page.goto("/connections");
    await openAddDialog(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Use a token or no sign-in" }).check();
    await dialog.getByLabel("Server name", { exact: true }).fill(name);
    const secret = dialog.getByLabel("Authorization header (optional)");
    await secret.fill(SECRET);
    await expect(secret).toHaveAttribute("type", "password");
    await dialog.getByRole("textbox", { name: "Server address" }).fill(UNREACHABLE);

    const created = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/mcp/servers",
      { timeout: 45_000 }
    );
    await dialog.getByRole("button", { name: "Save server", exact: true }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({ name, url: UNREACHABLE, authHeader: SECRET });
    const { server } = (await response.json()) as { server: Record<string, unknown> };
    expect(server).toMatchObject({ name, url: UNREACHABLE, hasAuthHeader: true });
    // Stored encrypted and never sent back.
    expect(JSON.stringify(server)).not.toContain("journey-fixture-not-a-real-token");
    // The probe could not reach it, and the row says so instead of "ok".
    expect(server.status).toBe("error");

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  });

  test("an unreachable sign-in server is refused in words and nothing is saved", async ({ page }) => {
    test.setTimeout(90_000);
    let saves = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/mcp/servers") saves += 1;
    });

    await page.goto("/connections");
    await openAddDialog(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: "Sign in", exact: true })).toBeChecked();
    await dialog.getByRole("textbox", { name: "Server address" }).fill(UNREACHABLE);

    const probed = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/connectors/custom/probe",
      { timeout: 45_000 }
    );
    await dialog.getByRole("button", { name: "Check", exact: true }).click();
    const probe = await probed;
    const verdict = (await probe.json()) as { ok?: boolean; message?: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.message, "the refusal is explained").toBeTruthy();

    // The same dialog says why, and offers no way forward to a broken server.
    await expect(dialog.getByText(verdict.message!, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("heading", { name: "Found it" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
    expect(saves, "nothing is saved for a server that cannot be reached").toBe(0);
  });
});
