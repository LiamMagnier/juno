import { test, expect, type Page } from "@playwright/test";

/**
 * Paged history on the real /chat/[id] route (Workstream I): the 2,000-message
 * conversation with tool runs and files seeded by scripts/perf/seed-perf-data.ts.
 *
 *   PERF_RICH_CONVERSATION_ID=<richConversationId> PERF_STORAGE_STATE=<state.json> \
 *     npx playwright test --config scripts/perf/playwright.perf.config.ts e2e/transcript-history.spec.ts
 *
 * Proves: the first load carries the newest page only; scrolling up loads older
 * pages without moving the line being read; the top of the conversation is
 * reachable and whole; find and ?m= deep links reach rows that were not loaded.
 */
const id = process.env.PERF_RICH_CONVERSATION_ID;
test.skip(!id || Boolean(process.env.E2E_BASE_URL), "Needs the seeded 2,000-message conversation");

const scroller = '[aria-label="Conversation messages"]';
const rows = '[aria-label="Conversation transcript"] [data-message-id]';
const log = '[aria-label="Conversation transcript"]';
const loaded = (page: Page) => page.locator(log).getAttribute("data-history-loaded").then(Number);

async function open(page: Page, query = "") {
  await page.goto(`/chat/${id}${query}`);
  await expect(page.locator(rows).first()).toBeAttached({ timeout: 60_000 });
}

/** The row at the top edge of the viewport and where it sits, in px from the scroller's top. */
function readerLine(page: Page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const edge = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find((r) => r.getBoundingClientRect().bottom > edge + 1)!;
    return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top - edge };
  }, scroller);
}

function lineOf(page: Page, messageId: string) {
  return page.evaluate(([sel, mid]) => {
    const el = document.querySelector(sel)!;
    const row = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(mid)}"]`);
    return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, [scroller, messageId] as const);
}

test("the first load carries the newest page, not the conversation", async ({ page }) => {
  const html = await (await page.request.get(`/chat/${id}`)).text();
  expect(html).toContain("Question 1998:");
  expect(html).not.toContain("Question 1000:");
  expect(html).not.toContain("perf-anchor-6");
  await open(page);
  expect(await loaded(page)).toBeLessThanOrEqual(80);
  await expect(page.locator(log)).toHaveAttribute("data-history-older", "true");
  // The native apps' contract: the thread endpoint without paging is whole.
  const whole = await (await page.request.get(`/api/conversations/${id}`)).json();
  expect(whole.messages).toHaveLength(2000);
  expect(whole.history).toBeUndefined();
});

test("scrolling up loads older pages without moving the line being read", async ({ page }) => {
  // Hold each history response long enough to read the line before it lands.
  await page.route(/\/api\/conversations\/[^/]+\/messages\?/, async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await open(page);
  await page.waitForTimeout(500);
  for (let pageNo = 0; pageNo < 3; pageNo++) {
    const before = await loaded(page);
    await page.locator(scroller).evaluate((el) => { el.scrollTop = 120; });
    await page.waitForTimeout(150);
    const line = await readerLine(page);
    await expect.poll(() => loaded(page), { timeout: 15_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(300); // let measurements of the new rows settle
    const after = await lineOf(page, line.id);
    expect(after).not.toBeNull();
    expect(Math.abs(after! - line.top)).toBeLessThanOrEqual(2);
  }
});

test("the top of the conversation is reachable and whole", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 60; i++) {
    const older = await page.locator(log).getAttribute("data-history-older");
    if (older !== "true") break;
    await page.locator(scroller).evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(250);
  }
  await expect(page.locator(log)).not.toHaveAttribute("data-history-older", "true");
  expect(await loaded(page)).toBe(2000);
  await page.locator(scroller).evaluate((el) => { el.scrollTop = 0; });
  await expect(page.locator(rows).first()).toContainText("Question 0:");
  // Every message arrived once: as many distinct rows as the conversation has.
  const ids = await page.locator(scroller).evaluate(async (el) => {
    const seen = new Set<string>();
    for (let top = 0; top <= el.scrollHeight; top += el.clientHeight / 2) {
      el.scrollTop = top;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const row of el.querySelectorAll<HTMLElement>("[data-message-id]")) seen.add(row.dataset.messageId!);
    }
    return seen.size;
  });
  expect(ids).toBe(2000);
});

test("find in chat reaches a phrase that was not loaded", async ({ page }) => {
  await open(page);
  await expect(page.locator(rows).filter({ hasText: "perf-anchor-6" })).toHaveCount(0);
  await page.locator(scroller).focus();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find in this conversation" }).fill("perf-anchor-6");
  await expect(page.getByRole("search")).toContainText("1 of 1", { timeout: 30_000 });
  const row = page.locator(rows).filter({ hasText: "perf-anchor-6" });
  await expect(row).toBeVisible();
  const offset = await row.evaluate((el, sel) => {
    const viewport = document.querySelector(sel)!.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return Math.abs(rect.top + rect.height / 2 - (viewport.top + viewport.height / 2));
  }, scroller);
  expect(offset).toBeLessThan(4);
});

test("a ?m= deep link opens on a message far above the newest page", async ({ page }) => {
  const whole = await (await page.request.get(`/api/conversations/${id}`)).json() as { messages: Array<{ id: string; content: string }> };
  const target = whole.messages.find((m) => m.content.includes("perf-anchor-1500"))!;
  await open(page, `?m=${target.id}`);
  const row = page.locator(`${rows}[data-message-id="${target.id}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const count = await loaded(page);
  expect(count).toBeGreaterThan(400);
  expect(count).toBeLessThan(2000);
});
