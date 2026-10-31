import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import JSZip from "jszip";
import { SMOKE_ARTIFACT_BODY, SMOKE_ARTIFACT_DIRECTIVE, SMOKE_ARTIFACT_TITLE } from "../../src/lib/chat/turn/model-streams";
import { conversationIdOf, expectNotStreaming, openNewChat, submitPrompt } from "./journey";

/*
 * Editing an artifact in the canvas and exporting it (COMPETITORS.md §4,
 * outcome 5): the reader's own words survive into every export, the edit
 * becomes a version beside the original, and nothing exports a file that is
 * not what the canvas shows.
 *
 * The defect this pins: with an edit typed but not yet saved, the More menu
 * offered "Word document", which the server builds from the latest SAVED
 * version. "Download source" one row up carried the edit; the Word file
 * silently did not. Now the Office formats wait, disabled, under a line that
 * says to save first, and after Save version the Word file carries the edit.
 */

const EDIT = "READER_EDIT_LINE: added in the canvas by the reader.";

async function textOf(download: Download) {
  return readFile((await download.path())!, "utf8");
}

async function wordTextOf(download: Download) {
  const zip = await JSZip.loadAsync(await readFile((await download.path())!));
  return (await zip.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "");
}

/** The canvas's own More menu (the answer's turn has a "More actions" too). */
async function openMore(page: Page) {
  // A menu still closing hides the rest of the page from the accessibility
  // tree (Radix modal menus); wait for it to go before looking for the next.
  await expect(page.getByRole("menu")).toHaveCount(0);
  const canvasHeader = page
    .getByRole("button", { name: "Close canvas" })
    .locator("xpath=ancestor::*[.//button[@aria-label='More actions']][1]");
  await canvasHeader.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

test.describe("Canvas edit and export", () => {
  test.use({ acceptDownloads: true });

  test("an edit is kept in every export and saved as a new version beside the original", async ({ page }) => {
    test.setTimeout(150_000);
    await openNewChat(page);
    await submitPrompt(page, `Canvas probe: write a short note. ${SMOKE_ARTIFACT_DIRECTIVE}`);
    const card = page.getByRole("button", { name: `Open ${SMOKE_ARTIFACT_TITLE} in canvas` }).first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expectNotStreaming(page);
    const conversationId = await conversationIdOf(page);

    await card.click();
    await expect(page.getByRole("button", { name: "Close canvas" })).toBeVisible({ timeout: 15_000 });

    // Beside the canvas the transcript is a narrow column: nothing on the
    // answer's row (its actions, the model · tokens · cost receipt) may run
    // past the column into the canvas, where it was cut in half.
    await expect.poll(() => page.locator('[aria-label="Conversation messages"]').evaluate((scroller) => {
      const edge = scroller.getBoundingClientRect().right;
      return [...scroller.querySelectorAll<HTMLElement>("[data-juno-message] span, [data-juno-message] button")]
        .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > edge + 1)
        .map((el) => el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName);
    }), { timeout: 5_000 }).toEqual([]);

    await page.getByRole("tab", { name: "Code" }).click();
    const editor = page.getByRole("textbox", { name: `${SMOKE_ARTIFACT_TITLE} source` });
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(`\n\n${EDIT}`);
    await expect(page.getByRole("button", { name: "Save version" })).toBeVisible();

    // Unsaved: the source download is what the editor shows…
    await openMore(page);
    const [source] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Download source" }).click()]);
    const sourceText = await textOf(source);
    expect(sourceText).toContain(EDIT);
    expect(sourceText).toContain(SMOKE_ARTIFACT_BODY);

    // …and the Word file, built from the saved version, waits for the save.
    await openMore(page);
    await expect(page.getByText("Save version to export your edit")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Word document/ })).toBeDisabled();
    await page.keyboard.press("Escape");

    // Save: a second version, the first kept.
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByRole("button", { name: "Version history, v2" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Save version" })).toHaveCount(0);

    const listed = (await (await page.request.get("/api/artifacts")).json()) as {
      items: Array<{ id: string; title: string; conversationId: string | null }>;
    };
    const stored = listed.items.find((item) => item.conversationId === conversationId && item.title === SMOKE_ARTIFACT_TITLE);
    expect(stored, "the artifact is stored for this conversation").toBeTruthy();
    const { artifact } = (await (await page.request.get(`/api/artifacts/${stored!.id}`)).json()) as {
      artifact: { currentVersion: number; content: string; versions: Array<{ version: number; content: string }> };
    };
    expect(artifact.currentVersion).toBe(2);
    expect(artifact.content).toContain(EDIT);
    const v1 = artifact.versions.find((version) => version.version === 1);
    expect(v1?.content, "the original version is kept as it was").toContain(SMOKE_ARTIFACT_BODY);
    expect(v1?.content).not.toContain(EDIT);

    // Saved: the Word file now carries the reader's edit.
    await openMore(page);
    const word = page.getByRole("menuitem", { name: /Word document/ });
    await expect(word).toBeEnabled();
    await expect(page.getByText("Save version to export your edit")).toHaveCount(0);
    const [docx] = await Promise.all([page.waitForEvent("download"), word.click()]);
    expect(docx.suggestedFilename()).toMatch(/\.docx$/);
    const wordText = await wordTextOf(docx);
    expect(wordText).toContain("READER_EDIT_LINE");
    expect(wordText).toContain(SMOKE_ARTIFACT_BODY);

    // The edit survives a reload: the canvas reopens on v2 with it.
    await page.reload();
    await page.getByRole("button", { name: `Open ${SMOKE_ARTIFACT_TITLE} in canvas` }).first().click();
    await expect(page.getByRole("button", { name: "Version history, v2" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(EDIT.split(":")[0]).first()).toBeVisible();
  });
});
