import { expect, test, type Locator, type Page } from "@playwright/test";
import { SMOKE_SOURCES, SMOKE_SOURCES_DIRECTIVE, SMOKE_SOURCES_TOKEN } from "../../src/lib/chat/turn/model-streams";
import { expectNotStreaming, lastAnswer, openNewChat, submitPrompt } from "./journey";

/*
 * What a reader does with a turn (COMPETITORS.md §4, outcome 4): copy, retry
 * (regenerate), edit and resend, and inspect the sources. Each is reachable
 * by keyboard with a visible focus indicator, is a real touch target on a
 * 390px phone, and does what it says, on the real chat route.
 */

const PROMPT = `Which pages describe the example domains? ${SMOKE_SOURCES_DIRECTIVE}`;

/** The row of the transcript that holds `text` (a question or an answer). */
function rowWith(page: Page, text: string) {
  return page.locator('[aria-label="Conversation transcript"] [data-message-id]').filter({ hasText: text }).last();
}

async function answeredWithSources(page: Page) {
  await openNewChat(page);
  await submitPrompt(page, PROMPT);
  await expect(lastAnswer(page)).toContainText(SMOKE_SOURCES_TOKEN, { timeout: 60_000 });
  await expectNotStreaming(page);
  await expect(page.getByRole("button", { name: /^Sources/ })).toBeVisible({ timeout: 30_000 });
}

/** A focus indicator that a sighted keyboard user can see: a real outline or ring, on a visible control. */
async function focusIndicator(control: Locator) {
  return control.evaluate((el) => {
    const style = getComputedStyle(el);
    let opacity = 1;
    for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return {
      focused: el === document.activeElement && el.matches(":focus-visible"),
      outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 && style.outlineColor !== "rgba(0, 0, 0, 0)",
      ring: style.boxShadow !== "none",
      opacity: Math.round(opacity * 100) / 100,
    };
  });
}

/** The area a finger can hit: the box, or the invisible pad (`hit-44`) when it is larger. */
async function hitArea(control: Locator) {
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    let width = box.width;
    let height = box.height;
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (style.content === "none" || style.position !== "absolute") continue;
      width = Math.max(width, parseFloat(style.width) || 0);
      height = Math.max(height, parseFloat(style.height) || 0);
    }
    return { width: Math.round(width), height: Math.round(height) };
  });
}

test.describe("Turn actions", () => {
  test.describe("keyboard", () => {
    test("copy, regenerate, more, sources and edit each show where the keyboard is", async ({ page }) => {
      test.setTimeout(120_000);
      await answeredWithSources(page);

      // A press on the answer's text puts focus on the transcript itself; from
      // there Tab walks the turns in reading order, as a keyboard user does.
      const answer = rowWith(page, SMOKE_SOURCES_TOKEN);
      const question = rowWith(page, PROMPT);
      await lastAnswer(page).click();
      const wanted = new Map<string, Locator>([
        ["Copy (question)", question.getByRole("button", { name: "Copy", exact: true })],
        ["Edit", question.getByRole("button", { name: "Edit", exact: true })],
        ["Sources", answer.getByRole("button", { name: /^Sources/ })],
        ["Copy", answer.getByRole("button", { name: "Copy", exact: true })],
        ["Regenerate", answer.getByRole("button", { name: "Regenerate", exact: true })],
        ["More actions", answer.getByRole("button", { name: "More actions", exact: true })],
      ]);
      const order: string[] = [];
      for (let step = 0; step < 24 && order.length < wanted.size; step++) {
        await page.keyboard.press("Tab");
        for (const [name, control] of wanted) {
          if (order.includes(name) || !(await control.evaluate((el) => el === document.activeElement))) continue;
          const indicator = await focusIndicator(control);
          expect(indicator.focused, `${name} has keyboard focus`).toBe(true);
          expect(indicator.outline || indicator.ring, `${name} draws a focus outline`).toBe(true);
          // Its reveal is an opacity fade (kept under reduced motion, Tier A):
          // visible once it lands, not necessarily on the very frame focus arrives.
          await expect.poll(async () => (await focusIndicator(control)).opacity, { message: `${name} is visible while focused` }).toBe(1);
          order.push(name);
        }
      }
      expect(order, "every action is reached, in reading order").toEqual([...wanted.keys()]);

      // And back: Shift+Tab from More lands on Regenerate, still drawn.
      await page.keyboard.press("Shift+Tab");
      await expect(wanted.get("Regenerate")!).toBeFocused();
      await expect.poll(async () => (await focusIndicator(wanted.get("Regenerate")!)).opacity).toBe(1);

      // Enter on Sources inspects them: the list opens with real links.
      await answer.getByRole("button", { name: /^Sources/ }).focus();
      await page.keyboard.press("Enter");
      await expect(answer.getByRole("button", { name: /^Sources/ })).toHaveAttribute("aria-expanded", "true");
      for (const source of SMOKE_SOURCES) {
        await expect(answer.locator(`a[href="${source.url}"]`)).toBeVisible();
      }
    });
  });

  test.describe("390px touch", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ["clipboard-read", "clipboard-write"] });

    test("every turn action is a 44px target that fits the column, and copy, regenerate, edit-and-resend and sources work", async ({ page }) => {
      test.setTimeout(150_000);
      await answeredWithSources(page);
      const answer = rowWith(page, SMOKE_SOURCES_TOKEN);
      const question = rowWith(page, PROMPT);

      const controls: Array<[string, Locator]> = [
        ["Sources", answer.getByRole("button", { name: /^Sources/ })],
        ["Copy", answer.getByRole("button", { name: "Copy", exact: true })],
        ["Good response", answer.getByRole("button", { name: /^Good response/ })],
        ["Bad response", answer.getByRole("button", { name: /^Bad response/ })],
        ["Regenerate", answer.getByRole("button", { name: "Regenerate", exact: true })],
        ["More actions", answer.getByRole("button", { name: "More actions", exact: true })],
        ["Copy (question)", question.getByRole("button", { name: "Copy", exact: true })],
        ["Edit", question.getByRole("button", { name: "Edit", exact: true })],
      ];
      const width = 390;
      for (const [name, control] of controls) {
        await expect(control, `${name} is shown without hover on touch`).toBeVisible();
        const area = await hitArea(control);
        expect(area.width, `${name} hit width`).toBeGreaterThanOrEqual(44);
        expect(area.height, `${name} hit height`).toBeGreaterThanOrEqual(44);
        const box = (await control.boundingBox())!;
        expect(box.x, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${name} ends on screen`).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth), "no sideways scroll").toBeLessThanOrEqual(width);

      // Copy puts the answer on the clipboard.
      await answer.getByRole("button", { name: "Copy", exact: true }).tap();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(SMOKE_SOURCES_TOKEN);

      // Inspect the sources.
      await answer.getByRole("button", { name: /^Sources/ }).tap();
      for (const source of SMOKE_SOURCES) await expect(answer.locator(`a[href="${source.url}"]`)).toBeVisible();

      // Regenerate › Try again asks again and keeps both answers.
      const regenerated = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/chat");
      await answer.getByRole("button", { name: "Regenerate", exact: true }).tap();
      await page.getByRole("menuitem", { name: "Try again" }).tap();
      expect(((await regenerated).postDataJSON() as { regenerate?: boolean }).regenerate).toBe(true);
      await expect(page.getByText("2/2").first()).toBeVisible({ timeout: 60_000 });
      await expectNotStreaming(page);

      // Edit and resend: the question's new wording goes out and is shown.
      const edited = `Which pages, briefly? ${SMOKE_SOURCES_DIRECTIVE}`;
      await rowWith(page, PROMPT).getByRole("button", { name: "Edit", exact: true }).tap();
      const field = page.getByRole("textbox", { name: "Edit message" });
      await expect(field).toBeFocused();
      await field.fill(edited);
      // The new wording is stored on the question (PATCH), then answered afresh.
      const rewritten = page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname.startsWith("/api/messages/"));
      const reanswered = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/chat");
      await page.getByRole("button", { name: "Send", exact: true }).tap();
      expect((await rewritten).postDataJSON()).toEqual({ content: edited });
      expect(((await reanswered).postDataJSON() as { regenerate?: boolean }).regenerate).toBe(true);
      await expect(rowWith(page, edited)).toBeVisible({ timeout: 30_000 });
      await expect(lastAnswer(page)).toContainText(SMOKE_SOURCES_TOKEN, { timeout: 60_000 });
    });
  });
});
