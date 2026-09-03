import { test, expect, type Page } from "@playwright/test";
import { composer } from "./helpers";

// Sidebar folders + archive, end to end through the real routes: create a
// folder, move a chat into it, archive the chat, restore it from the Archived
// dialog, then clean up. Runs against the deterministic smoke provider, so no
// provider quota is spent and the reply text is controlled.
const TOKEN = "JUNO_FOLDER_PROBE_OK";

function alphaSuffix() {
  return Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
}

async function startChat(page: Page, prompt: string): Promise<string> {
  await page.goto("/chat");
  const input = composer(page);
  await input.fill(prompt);
  const send = page.locator(".composer-primary-action");
  await expect(send).toBeEnabled({ timeout: 5_000 });
  await send.click();
  await expect(page.locator("main")).toContainText(prompt, { timeout: 15_000 });
  await expect(page.locator(".prose-juno").last()).toContainText(TOKEN, { timeout: 90_000 });
  await expect(page).toHaveURL(/\/chat\/.+/, { timeout: 15_000 });
  return page.url().split("/chat/")[1].split("?")[0];
}

function conversationLink(page: Page, id: string) {
  return page.locator("aside").locator(`a[href="/chat/${id}"]`);
}

/// The cookie banner docks bottom-left over the sidebar footer; send it away
/// before touching anything down there.
async function dismissCookieBanner(page: Page) {
  const banner = page.getByRole("region", { name: "Cookie preferences" });
  if (await banner.isVisible().catch(() => false)) {
    await banner.getByRole("button", { name: "Accept" }).click();
    await expect(banner).toBeHidden({ timeout: 10_000 });
  }
}

async function openRowMenu(page: Page, id: string) {
  const row = conversationLink(page, id).first();
  await row.hover();
  // Note: `has` scopes its locator to the candidate, so the inner selector
  // must be relative (an absolute `aside >> a` path matches nothing in here).
  const rowContainer = page
    .locator("aside")
    .locator("div.group", { has: page.locator(`a[href="/chat/${id}"]`) })
    .last();
  await rowContainer.getByRole("button", { name: "Conversation options" }).click();
}

test.describe("Sidebar folders and archive", () => {
  test("create, move-to-folder, archive, restore", async ({ page }) => {
    const suffix = alphaSuffix();
    const folderName = `E2E Folder ${suffix}`;
    const chatTitle = `E2E Probe ${suffix}`;

    const id = await startChat(page, `Folder probe ${suffix}: reply with the exact token ${TOKEN}.`);

    // Rename first so every later surface names this chat deterministically
    // (the AI title would arrive whenever it arrives).
    await openRowMenu(page, id);
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const renameInput = page.locator("aside").getByPlaceholder("Chat name");
    await renameInput.fill(chatTitle);
    await renameInput.press("Enter");
    await expect(conversationLink(page, id).first()).toContainText(chatTitle, { timeout: 15_000 });

    // Create a folder from the Recents section action (no folders yet, so the
    // section action lives on Recents rather than on a Folders section).
    await page.locator("aside").hover();
    await page.getByRole("button", { name: "New folder" }).first().click();
    const folderInput = page.getByPlaceholder("Folder name");
    await folderInput.fill(folderName);
    await folderInput.press("Enter");
    const folderToggle = page.locator("aside").locator("button[aria-expanded]", { hasText: folderName });
    await expect(folderToggle).toBeVisible({ timeout: 15_000 });

    // Move the chat in through its own menu (no drag simulation involved).
    await openRowMenu(page, id);
    await page.getByRole("menuitem", { name: "Move to folder" }).hover();
    await page.getByRole("menuitem", { name: folderName }).click();
    await expect(folderToggle).toContainText("1", { timeout: 15_000 });
    // A folder that receives the active chat expands on its own; clicking the
    // toggle then would fold it back up mid-transition. Open it only if it is
    // still closed, and wait for the expanded state rather than the row.
    if ((await folderToggle.getAttribute("aria-expanded")) !== "true") await folderToggle.click();
    await expect(folderToggle).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 });
    await expect(conversationLink(page, id).first()).toBeVisible({ timeout: 15_000 });

    // Archive removes it from the sidebar; the Archived dialog restores it.
    await openRowMenu(page, id);
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("Chat archived.")).toBeVisible({ timeout: 15_000 });
    await expect(conversationLink(page, id)).toHaveCount(0, { timeout: 15_000 });

    await dismissCookieBanner(page);
    // Archived chats lives in the sidebar's More flyout.
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Archived chats" }).click();
    const dialog = page.getByRole("dialog", { name: "Archived chats" });    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const archivedItem = dialog.locator("li", { hasText: chatTitle });
    await expect(archivedItem).toBeVisible({ timeout: 15_000 });
    await archivedItem.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Chat restored.")).toBeVisible({ timeout: 15_000 });
    // Restoring leaves the dialog open over the sidebar; close it before
    // asserting on the rows behind it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    // Restoring does not expand the folder: open it before asserting on the
    // nested row.
    await folderToggle.click();
    await expect(conversationLink(page, id).first()).toBeVisible({ timeout: 15_000 });

    // Cleanup: delete the chat, then the (now empty) folder.
    await openRowMenu(page, id);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete chat" }).click();
    await expect(conversationLink(page, id)).toHaveCount(0, { timeout: 15_000 });

    const folderRow = folderToggle.locator("xpath=ancestor::div[contains(@class, 'group')][1]");
    await folderRow.hover();
    await folderRow.getByRole("button", { name: "Folder options" }).click();
    await page.getByRole("menuitem", { name: "Delete folder" }).click();
    await page.getByRole("button", { name: "Delete folder" }).click();
    await expect(folderToggle).toHaveCount(0, { timeout: 15_000 });
  });
});
