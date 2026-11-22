import { expect, test } from "@playwright/test";

test("Code keeps its sidebar across shared destinations and Library owns artifacts", async ({ page, isMobile }, testInfo) => {
  const primary = page.getByRole("navigation", { name: "Primary" });
  const openMenu = async () => {
    if (isMobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  };

  await page.goto("/chat");
  await openMenu();
  await expect(primary.getByRole("link", { name: "Library", exact: true })).toBeVisible();
  for (const name of ["Apps & plugins", "Skills", "Artifacts"]) {
    await expect(primary.getByRole("link", { name, exact: true })).toHaveCount(0);
  }

  await page.goto("/code");
  await openMenu();
  await primary.getByRole("link", { name: "Apps & plugins" }).click();
  await expect(page).toHaveURL(/\/connections\?surface=code/);
  await openMenu();
  await expect(primary.getByRole("link", { name: "Skills", exact: true })).toBeVisible();
  await primary.getByRole("link", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\?surface=code/);
  await openMenu();
  await primary.getByRole("link", { name: "Library", exact: true }).click();
  const sections = page.getByRole("navigation", { name: "Library sections" });
  await sections.getByRole("link", { name: "Artifacts", exact: true }).click();
  await expect(page).toHaveURL(/\/library\?view=artifacts&surface=code/);
  await expect(sections.getByRole("link", { name: "Artifacts", exact: true })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("library-artifacts.png"), animations: "disabled" });

  await page.goto("/artifacts?type=DESIGN&surface=code");
  await expect(page).toHaveURL(/\/library\?.*view=artifacts/);
  expect(new URL(page.url()).searchParams.get("type")).toBe("DESIGN");
  expect(new URL(page.url()).searchParams.get("surface")).toBe("code");
});

test("a Code session started from Projects is saved in that same project", async ({ page, baseURL }, testInfo) => {
  const headers = { Origin: new URL(baseURL!).origin };
  const response = await page.request.post("/api/projects", {
    headers, data: { name: "Code and Chat project", instructions: "Use the project conventions." },
  });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  const missing = await page.request.post("/api/conversations", {
    headers, data: { kind: "code", projectId: "missing-project" },
  });
  expect(missing.status()).toBe(404);
  await page.route("**/api/code/workspaces", (route) => route.fulfill({
    json: { workspaces: [{ id: "project-workspace", name: "Project repo", path: "/qa/project-repo", lastOpenedAt: "2026-11-22T00:00:00.000Z" }] },
  }));
  await page.goto(`/projects/${id}?surface=code`);
  await expect(page.getByRole("textbox", { name: "Message Alevr", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open in Code" }).click();
  await expect(page).toHaveURL(`/code?project=${id}`);
  await expect(page.getByRole("link", { name: "Code and Chat project" })).toHaveAttribute("href", `/projects/${id}?surface=code`);
  await page.getByRole("button", { name: "Choose a local folder" }).click();
  await page.getByRole("option", { name: /Project repo/ }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Summarize the project layout.");
  await page.screenshot({ path: testInfo.outputPath("code-project.png"), animations: "disabled" });
  const created = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/conversations" && res.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const result = await created;
  expect(result.status()).toBe(201);
  const { conversation } = await result.json();
  expect(conversation.projectId).toBe(id);
  await expect(page).toHaveURL(`/code/${conversation.id}`);
  const brief = await page.request.get(`/api/conversations/${conversation.id}?view=code-project-context`);
  expect(brief.ok()).toBeTruthy();
  expect((await brief.json()).context).toContain("Use the project conventions.");
  await expect(page.getByRole("link", { name: "Code and Chat project", exact: true })).toHaveAttribute("href", `/projects/${id}?surface=code`);
  await page.goto(`/projects/${id}?surface=code&tab=code`);
  await expect(page.getByRole("list", { name: "Code sessions" }).getByRole("link").first()).toHaveAttribute("href", `/code/${conversation.id}`);
});

test("Library explains missing Drive setup and leaves Files available in Code", async ({ page }) => {
  await page.route("**/api/connectors/google-drive/files?*", (route) => route.fulfill({
    status: 503, json: { error: "Google Drive is not configured on this server.", code: "not_configured" },
  }));
  await page.goto("/library?view=drive&surface=code");
  await expect(page.getByText("Google Drive needs setup", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Browse Library files" }).click();
  await expect(page).toHaveURL(/\/library\?view=files&surface=code/);
});
