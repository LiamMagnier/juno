import { test, expect, type Page } from "@playwright/test";

/*
 * Reading-first follow (audit G18, src/lib/chat/follow-machine.ts), against
 * the REAL MessageList on the streaming bench (/dev/streaming, development
 * only). A follow-up pins its question near the top of the transcript, the
 * answer fills the reserved bed below it without moving the viewport, and once
 * it passes the fold the viewport still holds and Jump to latest appears.
 */
test.skip(Boolean(process.env.E2E_BASE_URL), "Development-only streaming bench");
// The bench needs no account.
test.use({ storageState: { cookies: [], origins: [] } });

const SCROLLER = '[aria-label="Conversation messages"]';

async function geometry(page: Page) {
  return page.locator(SCROLLER).evaluate((el) => {
    const questions = [...el.querySelectorAll<HTMLElement>('[data-message-id^="u-"]')];
    const question = questions[questions.length - 1];
    const frame = el.getBoundingClientRect();
    const bed = el.querySelector<HTMLElement>("[data-answer-bed]");
    return {
      scrollTop: el.scrollTop,
      follow: el.getAttribute("data-follow"),
      bed: bed ? bed.getBoundingClientRect().height : 0,
      questionTop: question ? question.getBoundingClientRect().top - frame.top : null,
    };
  });
}

async function settleFirstReply(page: Page) {
  await page.goto("/dev/streaming");
  await page.getByTestId("play-short").click();
  await expect(page.getByTestId("followup-short")).toBeEnabled({ timeout: 30_000 });
}

test("a follow-up pins its question and the answer grows below it without moving the viewport", async ({ page }) => {
  await settleFirstReply(page);
  await page.getByTestId("followup-long").click();
  // Placed: the question's top sits 24px below the top of the transcript.
  await expect.poll(async () => (await geometry(page)).questionTop, { timeout: 5_000 }).toBeGreaterThan(22);
  await expect.poll(async () => Math.abs(((await geometry(page)).questionTop ?? 0) - 24)).toBeLessThan(2);
  const placed = await geometry(page);
  expect(placed.follow).toBe("placed");
  expect(placed.bed).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeHidden();

  // The answer streams past the bed: the viewport does not move, the bed is
  // spent, and Jump to latest appears.
  await expect.poll(async () => (await geometry(page)).follow, { timeout: 20_000 }).toBe("reading");
  const reading = await geometry(page);
  expect(Math.abs(reading.scrollTop - placed.scrollTop)).toBeLessThan(2);
  expect(reading.bed).toBe(0);
  await page.waitForTimeout(1_000);
  expect(Math.abs((await geometry(page)).scrollTop - placed.scrollTop)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  // Jump to latest hands over to following.
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect.poll(async () => (await geometry(page)).follow).toBe("following");
  await expect.poll(() => page.locator(SCROLLER).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(30);
});

test("scrolling up while the answer is placed leaves it where the reader put it", async ({ page }) => {
  await settleFirstReply(page);
  await page.getByTestId("followup-long").click();
  await expect.poll(async () => Math.abs(((await geometry(page)).questionTop ?? 0) - 24), { timeout: 5_000 }).toBeLessThan(2);
  const box = (await page.locator(SCROLLER).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await geometry(page)).follow).toBe("free");
  const after = await geometry(page);
  await page.waitForTimeout(1_500);
  expect(Math.abs((await geometry(page)).scrollTop - after.scrollTop)).toBeLessThan(2);
});

test.describe("reduced motion", () => {
  test("placement is one instant write", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await settleFirstReply(page);
    await page.getByTestId("followup-short").click();
    // No glide: the first frame after the send already shows the pin.
    const frames: Array<number | null> = [];
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
      frames.push((await geometry(page)).questionTop);
    }
    for (const top of frames) expect(Math.abs((top ?? 0) - 24)).toBeLessThan(2);
  });
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 664 } });
  test("the bed is sized to the shorter viewport", async ({ page }) => {
    await settleFirstReply(page);
    await page.getByTestId("followup-short").click();
    await expect.poll(async () => Math.abs(((await geometry(page)).questionTop ?? 0) - 24), { timeout: 5_000 }).toBeLessThan(2);
    const { bed } = await geometry(page);
    const height = await page.locator(SCROLLER).evaluate((el) => el.clientHeight);
    expect(bed).toBeLessThan(height);
  });
});
