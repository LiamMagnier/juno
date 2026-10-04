import { test, expect } from "@playwright/test";

// This is an authenticated development benchmark, intentionally absent from
// production builds. Persisted-route acceptance is documented separately.
test.skip(Boolean(process.env.E2E_BASE_URL), "Development-only transcript fixture");

test("a thousand turns keep search, streaming anchors and keyboard traversal", async ({ page }) => {
  await page.goto("/dev/performance");
  await page.getByRole("button", { name: "Jump to message 42", exact: true }).click();
  const target = page.locator('[data-message-id="benchmark-42"]');
  await expect(target).toBeVisible();
  const scroller = page.locator('[aria-label="Conversation messages"]');
  await expect.poll(() => page.locator("[data-message-id]").count()).toBeLessThan(40);
  const position = () => target.evaluate((el) => {
    const viewport = document.querySelector('[aria-label="Conversation messages"]')!;
    const rect = el.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    return { top: rect.top - frame.top, centerError: Math.abs(rect.top + rect.height / 2 - frame.top - frame.height / 2) };
  });
  await expect.poll(async () => (await position()).centerError).toBeLessThan(2);
  const before = await position();
  await page.getByRole("button", { name: "Stream 120 updates", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stream 120 updates", exact: true })).toBeEnabled();
  await expect(target).toBeVisible();
  await expect.poll(async () => Math.abs((await position()).top - before.top)).toBeLessThan(2);
  // Streaming isolation: the streamed row re-renders per update; settled rows
  // only on the busy edges or when the window mounts them (StrictMode doubles
  // every count in development).
  const report = JSON.parse((await page.getByLabel("Performance measurement").textContent()) ?? "{}");
  expect(report.streamingRowRenders).toBeGreaterThan(100);
  expect(report.maxSettledRowRenders).toBeLessThanOrEqual(8);

  await scroller.press("Home");
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(1);
  await expect(page.locator('[data-message-id="benchmark-0"]')).toBeVisible();
  await scroller.press("End");
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);

  await page.getByRole("button", { name: "Find in conversation", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in this conversation", exact: true }).fill("performance-anchor-42");
  await expect(target).toBeVisible();
  await expect(page.getByRole("search")).toContainText("1 of 1");
});

test("full transcript accessibility mode is explicit and reversible", async ({ page }) => {
  await page.goto("/dev/performance");
  await page.getByRole("button", { name: "Read full conversation", exact: true }).press("Enter");
  await expect(page.locator("[data-message-id]")).toHaveCount(1000);
  await page.getByRole("button", { name: "Use compact conversation view", exact: true }).press("Enter");
  await expect.poll(() => page.locator("[data-message-id]").count()).toBeLessThan(40);
});

test("primary navigation preserves the mounted application shell", async ({ page }) => {
  await page.goto("/dev/performance");
  await page.getByRole("button", { name: "Record measurement", exact: true }).click();
  await page.locator("aside").evaluate((el) => el.setAttribute("data-performance-shell", "mounted"));
  const samples: Array<{ route: string; clickToHeadingMs: number }> = [];
  for (const [label, route] of [["Projects", "/projects"], ["Library", "/library"], ["Customize", "/customize"], ["Chat", "/chat"]]) {
    const start = Date.now();
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route}$`), { timeout: 20000 });
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect(page.locator("aside")).toHaveAttribute("data-performance-shell", "mounted");
    samples.push({ route, clickToHeadingMs: Date.now() - start });
  }
  console.log("Navigation development samples", JSON.stringify(samples));
});

test("a card growing above the reader does not move the line being read", async ({ page }) => {
  await page.goto("/dev/performance");
  await page.getByRole("button", { name: "Jump to message 906", exact: true }).click();
  const reader = page.locator('[data-message-id="benchmark-906"]');
  await expect(reader).toBeVisible();
  // A reader's own gesture ends the jump's centring; from here the window
  // anchors on the row the reader is looking at.
  const scroller = page.locator('[aria-label="Conversation messages"]');
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(300);
  await expect(page.locator("[data-benchmark-card]")).toBeAttached();
  const top = () => reader.evaluate((el) => el.getBoundingClientRect().top);
  const before = await top();
  const cardTop = await page.locator("[data-benchmark-card]").evaluate((el) => el.getBoundingClientRect().top);
  expect(cardTop).toBeLessThan(before);
  await page.getByRole("button", { name: "Grow card above reader", exact: true }).click();
  await expect(page.locator("[data-benchmark-card]")).toContainText("expanded");
  await expect.poll(async () => Math.abs((await top()) - before)).toBeLessThan(2);
});
