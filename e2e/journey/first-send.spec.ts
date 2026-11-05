import { expect, test, type Page } from "@playwright/test";
import { composer } from "../helpers";
import { lastAnswer, openNewChat } from "./journey";

/*
 * A new user's first message (COMPETITORS.md §4, outcome 1): they can tell
 * which model and mode the composer will use without provider vocabulary,
 * attach a file through the Add menu, and send, on the real chat route with
 * the deterministic smoke provider.
 *
 * Two defects this pins:
 *   - While a file was still uploading, words in the field did not make the
 *     primary button a Send: it stayed "Start voice conversation", so the press
 *     a person meant as Send opened a call. It must be a disabled Send that
 *     says it is waiting for the upload.
 *   - The button's faces (voice, send, stop) are layered glyphs that cross
 *     over. A press that started on a leaving glyph and ended after it was
 *     removed produced no click: typing and pressing Send right away did
 *     nothing, about one time in three. The press must always land on the
 *     button itself.
 */

/** Words a person should never need to send a message. */
const PROVIDER_VOCABULARY = /\b(provider|api|endpoint|base url|api key|dashscope|token(s)? in|inference)\b/i;

const primary = (page: Page) => page.locator(".composer-primary-action");

/** What a press at the centre of the primary button would land on. */
function pressTarget(page: Page) {
  return primary(page).evaluate((button) => {
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === button ? "button" : hit ? `${hit.tagName.toLowerCase()} inside the button` : "nothing";
  });
}

test.describe("First send", () => {
  test("the model and mode are named in plain words, and a file attached from Add goes out with the message", async ({ page }) => {
    test.setTimeout(120_000);
    await openNewChat(page);

    // What will answer, said on the chip and in its accessible name.
    const model = page.getByRole("button", { name: /^Model: / });
    await expect(model).toBeVisible();
    const modelName = (await model.getAttribute("aria-label"))!.replace(/^Model: /, "");
    expect(modelName.length).toBeGreaterThan(0);
    await expect(model).toContainText(modelName.split(",")[0].split(" ")[0]);
    // How tasks from this chat run, named rather than iconic.
    const mode = page.getByRole("button", { name: /^Tasks from this chat/ });
    await expect(mode).toBeVisible();
    for (const control of [model, mode, page.getByRole("button", { name: /^Add files and more/ })]) {
      const name = (await control.getAttribute("aria-label")) ?? (await control.innerText());
      expect(name, `"${name}" needs no provider vocabulary`).not.toMatch(PROVIDER_VOCABULARY);
    }

    // The upload is held until the words are typed, as a slow network would.
    let releaseUpload!: () => void;
    const uploadHeld = new Promise<void>((resolve) => { releaseUpload = resolve; });
    await page.route("**/api/upload", async (route) => {
      await uploadHeld;
      await route.continue();
    });

    await page.getByRole("button", { name: /^Add files and more/ }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Add (photos and )?files/ }).click();
    await (await chooser).setFiles({ name: "quarterly-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Revenue rose in the third quarter.") });
    await expect(page.getByRole("button", { name: "Remove quarterly-notes.txt" })).toBeVisible();

    const prompt = "Summarise the attached notes. JUNO_FIRST_SEND_OK";
    await composer(page).fill(prompt);
    // Words plus a file still uploading: a Send that waits, never a call.
    await expect(primary(page)).toHaveAttribute("data-face", "send");
    await expect(primary(page)).toBeDisabled();
    await expect(primary(page)).toHaveAttribute("aria-label", "Send (waiting for the attachment to finish uploading)");

    const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/upload" && r.request().method() === "POST");
    releaseUpload();
    expect((await uploaded).ok()).toBeTruthy();
    await expect(primary(page)).toBeEnabled();
    await expect(primary(page)).toHaveAttribute("aria-label", "Send message");
    // A press lands on the button, not on one of its glyph layers.
    expect(await pressTarget(page)).toBe("button");

    const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/chat");
    await primary(page).click();
    const body = (await request).postDataJSON() as { message?: string; attachmentIds?: string[] };
    expect(body.message).toBe(prompt);
    expect(body.attachmentIds ?? []).toHaveLength(1);

    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    await expect(transcript).toContainText(prompt, { timeout: 30_000 });
    await expect(transcript).toContainText("quarterly-notes", { timeout: 30_000 });
    await expect(lastAnswer(page)).toContainText("JUNO_FIRST_SEND_OK", { timeout: 60_000 });
  });

  test("Send works on the first press, every time, straight after typing", async ({ page }) => {
    test.setTimeout(120_000);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await openNewChat(page);
      await composer(page).fill(`First press ${attempt}. JUNO_FIRST_PRESS_OK`);
      // The voice face is still leaving as the send face arrives: the press
      // must still land on the button.
      expect(await pressTarget(page), `attempt ${attempt}`).toBe("button");
      const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/chat", { timeout: 10_000 });
      await primary(page).click();
      await request;
      await expect(page).toHaveURL(/\/chat\/[a-z0-9]+/i, { timeout: 30_000 });
      await expect(lastAnswer(page)).toContainText("JUNO_FIRST_PRESS_OK", { timeout: 60_000 });
    }
  });
});
