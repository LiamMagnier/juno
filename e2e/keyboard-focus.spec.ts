import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { composer } from "./helpers";

/*
 * Keyboard and focus regressions on the web shell, driven with real key
 * presses. Each case is a place focus used to fall to <body> (so the next Tab
 * started over at "Skip to content") or a control that was in the tab order
 * while invisible. The sidebar rows and the header cluster these drive are the
 * desktop layout's; the phone drawer is a different surface.
 */
test.skip(({ isMobile }) => isMobile, "Desktop shell: sidebar rows and the chat header cluster");

async function openChat(page: Page) {
  await page.goto("/chat");
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

async function expectFocused(locator: Locator) {
  await expect(locator).toBeFocused({ timeout: 5_000 });
}

async function expectFocusNotOnBody(page: Page) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
}

test.describe("dialogs give focus back to what opened them", () => {
  test("search overlay opened from the sidebar row", async ({ page }) => {
    await openChat(page);
    const search = page.getByRole("button", { name: "Search", exact: true });
    await search.focus();
    await page.keyboard.press("Enter");
    await expectFocused(page.getByRole("combobox", { name: "Search everything" }));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectFocused(search);
  });

  test("command menu opened with the chord from the composer", async ({ page }) => {
    await openChat(page);
    await composer(page).focus();
    await page.keyboard.press("ControlOrMeta+k");
    await expectFocused(page.getByRole("combobox", { name: "Command menu" }));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectFocused(composer(page));
  });

  test("confirm dialog opened from a conversation's menu", async ({ page }) => {
    await openChat(page);
    const row = page.locator("[data-conversation-row]").first();
    test.skip((await row.count()) === 0, "Needs a conversation in the sidebar (scripts/seed-e2e-user.ts seeds one)");
    const options = row.getByRole("button", { name: /(Conversation|Session) options/ });
    await options.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectFocused(dialog.getByRole("button", { name: "Cancel" }));
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expectFocused(options);
  });
});

test("inline rename returns focus to the renamed row", async ({ page }) => {
  await openChat(page);
  const row = page.locator("[data-conversation-row]").first();
  test.skip((await row.count()) === 0, "Needs a conversation in the sidebar (scripts/seed-e2e-user.ts seeds one)");
  const id = await row.getAttribute("data-conversation-row");
  const link = page.locator(`[data-conversation-row="${id}"] a[href="/chat/${id}"]`);

  for (const key of ["Escape", "Enter"]) {
    await page.locator(`[data-conversation-row="${id}"]`).getByRole("button", { name: /(Conversation|Session) options/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeFocused();
    await page.keyboard.press("Enter");
    // The field is named, not only placeholdered: the placeholder is gone the
    // moment the field holds the current title.
    await expectFocused(page.getByRole("textbox", { name: /Rename (chat|session)/ }));
    await page.keyboard.press(key);
    await expectFocused(link);
  }
});

test("incognito switch keeps focus on a control", async ({ page }) => {
  await openChat(page);
  const turnOn = page.getByRole("button", { name: "Turn on incognito" });
  await expect(turnOn).toBeVisible();

  // Folded, the incognito band is invisible: its close must not be tabbable.
  const foldedCloseTabbable = await page.evaluate(() => {
    const close = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Leave incognito");
    return close ? !close.closest("[inert]") : false;
  });
  expect(foldedCloseTabbable).toBe(false);

  await turnOn.focus();
  await page.keyboard.press("Enter");
  await expectFocused(page.getByRole("button", { name: "Leave incognito" }));
  await page.keyboard.press("Enter");
  await expectFocused(page.getByRole("button", { name: "Turn on incognito" }));
  await expectFocusNotOnBody(page);
});

test("axe finds no WCAG A/AA violations on the chat shell and its search overlay", async ({ page }) => {
  const axePath = path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js");
  test.skip(!fs.existsSync(axePath), "axe-core is not installed");
  await openChat(page);
  const run = async () => {
    await page.addScriptTag({ path: axePath });
    return page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
      const result = await axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        // Contrast is the design QA pass's job (and flaky under the
        // entrance animations); this guards structure: names, roles, focus.
        rules: { "color-contrast": { enabled: false } },
      });
      return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    });
  };
  expect(await run()).toEqual([]);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const field = page.getByRole("combobox", { name: "Search everything" });
  await expect(field).toBeFocused();
  // The empty result set is the state that used to fail: its prose sat inside
  // a role=listbox with no options (aria-required-children).
  await field.fill("zzqx no such thing anywhere");
  await expect(page.getByText(/Nothing matches/)).toBeVisible({ timeout: 15_000 });
  expect(await run()).toEqual([]);
});
