import { expect, test } from "@playwright/test";

const folderMime = "application/vnd.google-apps.folder";
const entries = {
  folder: { id: "reports", name: "Reports", kind: "folder", mimeType: folderMime, iconMime: folderMime, modifiedAt: null, size: null, unavailable: null },
  file: { id: "report", name: "Roadmap.md", kind: "file", mimeType: "text/markdown", iconMime: "text/markdown", modifiedAt: null, size: 54, unavailable: null },
};

test("Library opens a Google Drive folder, loads pages and imports a file", async ({ page }) => {
  await page.route("**/api/connectors/google-drive/files?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const root = params.get("parent") === "root";
    const next = params.get("cursor");
    return route.fulfill({ json: { entries: root ? [entries.folder] : next ? [{ ...entries.file, id: "other", name: "Brief.md" }] : [entries.file], nextCursor: root || next ? null : "page-two" } });
  });
  let requested: unknown;
  await page.route("**/api/connectors/google-drive/files/attach", (route) => {
    requested = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { attachments: [{ id: "saved-report" }], failed: [] } });
  });
  await page.goto("/library");
  await page.getByRole("link", { name: "Google Drive", exact: true }).click();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Folder path" })).toContainText("Reports");
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.getByText("Brief.md", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import Roadmap.md" }).click();
  await expect(page.getByRole("button", { name: "Import Roadmap.md" })).toBeDisabled();
  expect(requested).toEqual({ files: [{ id: "report" }] });
  await expect(page.getByRole("link", { name: "View imported files" })).toHaveAttribute("href", "/library?view=files");
});

test("Drive connection returns to the Library folder", async ({ page }) => {
  await page.route("**/api/connectors/google-drive/files?*", (route) => route.fulfill({
    status: 409, json: { error: "Connect Google Drive.", code: "connector_not_connected" },
  }));
  await page.goto("/library?view=drive");
  const link = page.getByRole("link", { name: "Connect Google Drive", exact: true });
  await expect(link).toHaveAttribute("href", /return=%2Flibrary%3Fview%3Ddrive$/);
});

test("a project retries a failed Drive check and adds a picked folder", async ({ page, isMobile }) => {
  const list = await page.request.get("/api/projects");
  expect(list.ok()).toBeTruthy();
  const { projects } = await list.json() as { projects: { id: string }[] };
  const project = projects[0];
  expect(project).toBeDefined();
  let calls = 0;
  let body: unknown;
  await page.route(`**/api/projects/${project.id}/sources`, (route) => {
    if (route.request().method() === "POST") {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { sources: [] } });
    }
    if (++calls === 1) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    return route.fulfill({ json: { sources: [], drive: { enabled: true, configured: true, connected: true, accountLabel: null } } });
  });
  await page.route(`**/api/projects/${project.id}/sources/drive?*`, (route) => route.fulfill({ json: { entries: [entries.folder], nextCursor: null } }));
  await page.goto(`/projects/${project.id}?tab=sources`);
  if (isMobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(page.getByRole("button", { name: "New chat in project" })).toBeVisible();
  if (isMobile) await page.getByRole("button", { name: "Close menu", exact: true }).click();
  await page.getByRole("button", { name: "Add knowledge" }).first().click();
  await page.getByRole("menuitem", { name: "Google Drive file or folder" }).click();
  const picker = page.getByRole("dialog", { name: "Add from Google Drive" });
  await expect(picker.getByText("Couldn’t check Google Drive")).toBeVisible();
  await picker.getByRole("button", { name: "Try again" }).click();
  const folder = picker.getByRole("checkbox", { name: "Add the folder Reports" });
  await folder.click();
  await expect(folder).toBeChecked();
  await picker.getByRole("button", { name: "Add 1 folder" }).click();
  await expect(picker).toHaveCount(0);
  expect(body).toEqual({ provider: "google-drive", items: [{ id: "reports", kind: "folder" }], includeSubfolders: true });
});

test("Code's starting points preserve drafts and the shared sidebar exposes workspace tools", async ({ page, isMobile }) => {
  await page.goto("/code");
  const draft = page.getByRole("textbox", { name: "Message" });
  await expect(draft).toBeVisible();
  await draft.fill("A draft to keep");
  await expect(draft).toHaveValue("A draft to keep");
  await page.getByRole("button", { name: "Add files and more" }).click();
  await page.getByRole("menuitem", { name: "Starting points" }).click();
  await page.getByRole("menuitem", { name: "Review changes" }).click();
  await expect(draft).toHaveValue("A draft to keep");
  const draftHint = page.getByText("Finish or clear your draft before choosing a starting point.");
  await expect(draftHint).toBeVisible();
  await draft.fill("");
  await page.getByRole("button", { name: "Add files and more" }).click();
  await page.getByRole("menuitem", { name: "Starting points" }).click();
  await page.getByRole("menuitem", { name: "Review changes" }).click();
  await expect(draft).toHaveValue(/^Review the current changes/);
  await expect(draftHint).toBeHidden();
  if (isMobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(primary.getByRole("link", { name: "Artifacts" })).toHaveCount(0);
  await expect(primary.getByRole("link", { name: "Library" })).toHaveAttribute("href", "/library?surface=code");
  await expect(primary.getByRole("link", { name: "Apps & plugins" })).toHaveAttribute("href", "/connections?surface=code");
  await expect(primary.getByRole("link", { name: "Skills" })).toHaveAttribute("href", "/skills?surface=code");
  await page.getByRole("link", { name: /QA · Code session/ }).click();
  if (isMobile) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: /Find in this session/ }).click();
  } else {
    await page.getByRole("button", { name: "Find in this session", exact: true }).click();
  }
  const finder = page.getByRole("dialog", { name: "Find in this session" });
  await finder.getByRole("textbox", { name: "Find in this session" }).fill("health check route");
  await expect(finder.getByRole("option", { name: /Add a health check route/ })).toBeVisible();
});
