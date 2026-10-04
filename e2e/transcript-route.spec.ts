import { test, expect } from "@playwright/test";

/**
 * The real /chat/[id] route with a 1,000-message conversation (seeded by
 * scripts/perf/seed-perf-data.ts). Development server only: it reads the
 * development render counter (lib/chat/transcript-window.ts) and stubs the
 * model stream in the page, so the product's own parser and renderer run with
 * no provider. Skipped unless PERF_LONG_CONVERSATION_ID names the seeded chat.
 */
const id = process.env.PERF_LONG_CONVERSATION_ID;
test.skip(!id || Boolean(process.env.E2E_BASE_URL), "Needs the seeded 1,000-message conversation on a development server");

const rows = '[aria-label="Conversation transcript"] [data-message-id]';

test("streaming into 1,000 messages re-renders only the streaming row", async ({ page }) => {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      const stub = (window as unknown as { __stream?: { id: string; done?: boolean } }).__stream;
      if (stub && path === "/api/chat/clarify") return Promise.resolve(Response.json({ needsClarification: false }));
      if (stub && path === "/api/chat" && init?.method === "POST") {
        const enc = new TextEncoder();
        return Promise.resolve(new Response(new ReadableStream({
          start(c) {
            const send = (o: object) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            send({ type: "meta", conversationId: stub.id, resumable: false });
            let n = 0;
            const tick = () => { if (n++ >= 80) { stub.done = true; return; } send({ type: "delta", text: `word${n} ` }); setTimeout(tick, 15); };
            setTimeout(tick, 15);
          },
        }), { headers: { "content-type": "text/event-stream" } }));
      }
      return realFetch(input, init);
    };
  });
  await page.goto(`/chat/${id}`);
  await expect(page.locator(rows).first()).toBeAttached({ timeout: 60_000 });
  await expect.poll(() => page.locator(rows).count()).toBeLessThan(40);
  await page.waitForTimeout(1500);
  await page.evaluate((cid) => {
    window.__alevrTranscriptRenders = {};
    (window as unknown as { __stream: { id: string } }).__stream = { id: cid };
  }, id!);
  const composer = page.locator("#juno-composer-textarea");
  await composer.fill("Benchmark stream");
  await composer.press("Enter");
  await page.waitForFunction(() => (window as unknown as { __stream: { done?: boolean } }).__stream.done, null, { timeout: 60_000 });
  const counts = await page.evaluate(() => Object.entries(window.__alevrTranscriptRenders ?? {}).map(([, n]) => n).sort((a, b) => b - a));
  expect(counts[0]).toBeGreaterThan(80);
  expect(counts.slice(1).every((n) => n <= 8)).toBe(true);
});

test("find in chat mounts and centres a row far outside the window", async ({ page }) => {
  await page.goto(`/chat/${id}`);
  await expect(page.locator(rows).first()).toBeAttached({ timeout: 60_000 });
  // Message 42 is ~950 turns above the bottom the conversation opens at.
  await expect(page.locator(rows).filter({ hasText: "perf-anchor-42" })).toHaveCount(0);
  await page.locator('[aria-label="Conversation messages"]').focus();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "Find in this conversation" }).fill("perf-anchor-42");
  await expect(page.getByRole("search")).toContainText("1 of 1");
  const row = page.locator(rows).filter({ hasText: "perf-anchor-42" });
  await expect(row).toBeVisible();
  const offset = await row.evaluate((el) => {
    const viewport = document.querySelector('[aria-label="Conversation messages"]')!.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return Math.abs(rect.top + rect.height / 2 - (viewport.top + viewport.height / 2));
  });
  expect(offset).toBeLessThan(viewportTolerance);
  await expect.poll(() => page.locator(rows).count()).toBeLessThan(40);
});

const viewportTolerance = 4;
