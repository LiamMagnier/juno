import { test, expect, type Page } from "@playwright/test";
import { composer } from "./helpers";

type SubmissionFixture = {
  counts: { clarify: number; chat: number };
  release: () => void;
  turns: Array<{ preflightClarification?: { skipped?: boolean; answers: Array<{ source: string; value?: unknown }> } }>;
};

async function installSubmissionFixture(page: Page, options: { privateMode: boolean; holdPreflight?: boolean; needsClarification?: boolean }) {
  // Every model/preflight request stays in the browser. The ordinary saved
  // path also receives a meta frame so its soft URL handoff is exercised.
  await page.addInitScript(({ privateMode, holdPreflight, needsClarification }) => {
    const counts = { clarify: 0, chat: 0 };
    const turns: unknown[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(window, { __qaSubmission: { counts, release, turns } });
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      if (path === "/api/chat/clarify") {
        counts.clarify++;
        if (holdPreflight) await held;
        else await new Promise((resolve) => setTimeout(resolve, 250));
        return Response.json({
          needsClarification: !!needsClarification,
          reason: "Choose the audience.",
          title: "Project details",
          description: "One choice before the response.",
          questions: needsClarification ? [{
            id: "audience", question: "Who will read this?", type: "single-choice",
            options: ["Technical team", "General audience"], allowElse: true,
            elseLabel: "Other audience", elsePlaceholder: "Describe the audience", required: true,
          }] : [],
        });
      }
      if (path === "/api/chat/cancel") return Response.json({ ok: true });
      if (path === "/api/chat" && init?.method === "POST") {
        counts.chat++;
        turns.push(typeof init.body === "string" ? JSON.parse(init.body) : null);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            const send = (event: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            if (!privateMode) send({ type: "meta", conversationId: "cmqasubmission000000000001", title: "Submission fixture", resumable: false });
            send({ type: "delta", text: "One accepted request." });
            init.signal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return realFetch(input, init);
    };
    localStorage.setItem("juno:onboarded:v1", "1");
  }, options);
  await page.goto("/chat");
  if (options.privateMode) await page.getByRole("button", { name: "Turn on incognito", exact: true }).click();
}

test("clarification keeps a newer draft and serializes Continue with Skip", async ({ page }) => {
  await installSubmissionFixture(page, { privateMode: true, holdPreflight: true, needsClarification: true });
  await composer(page).fill("Help me organize the details of this project.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission.counts.clarify)).toBe(1);
  await composer(page).fill("Keep this newer thought for my next message.");
  await page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission.release());
  const question = page.getByRole("dialog", { name: "Project details", exact: true });
  await expect(question).toBeVisible();
  await expect(composer(page)).toHaveText("Keep this newer thought for my next message.");
  await question.getByRole("option", { name: "Technical team", exact: true }).click();
  await question.getByRole("button", { name: "Continue", exact: true }).evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("Continue must be a button");
    const skip = Array.from(button.closest('[role="dialog"]')!.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === "Use your judgment")!;
    button.click();
    button.click();
    skip.click();
  });
  await expect(page.locator(".prose-juno").last()).toContainText("One accepted request.");
  await expect(composer(page)).toHaveText("Keep this newer thought for my next message.");
  const fixture = await page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission);
  expect(fixture.counts.chat).toBe(1);
  expect(fixture.turns[0].preflightClarification?.answers).toEqual([
    { questionId: "audience", question: "Who will read this?", source: "option", value: "Technical team" },
  ]);
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
});

test("cancel restores the intercepted draft and Skip preserves an unsent answer", async ({ page }) => {
  await installSubmissionFixture(page, { privateMode: true, needsClarification: true });
  const original = "Help me organize the details of this project.";
  await composer(page).fill(original);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const question = page.getByRole("dialog", { name: "Project details", exact: true });
  await expect(question).toBeVisible();
  await expect(composer(page)).toHaveText("");
  await question.getByRole("button", { name: "Cancel clarification", exact: true }).click();
  await expect(composer(page)).toHaveText(original);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(question).toBeVisible();
  await question.getByRole("option", { name: "Technical team", exact: true }).click();
  await composer(page).fill("Save this answer if I skip the question.");
  await question.getByRole("button", { name: "Use your judgment", exact: true }).evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("Skip must be a button");
    const next = Array.from(button.closest('[role="dialog"]')!.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === "Continue")!;
    button.click();
    next.click();
  });
  await expect(page.locator(".prose-juno").last()).toContainText("One accepted request.");
  await expect(composer(page)).toHaveText("Save this answer if I skip the question.");
  const fixture = await page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission);
  expect(fixture.counts.chat).toBe(1);
  expect(fixture.turns[0].preflightClarification?.skipped).toBe(true);
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
});

test("switching incognito preserves the saved draft without storing private words", async ({ page }) => {
  await installSubmissionFixture(page, { privateMode: false });
  const saved = "This unsent saved-chat draft must survive.";
  const secret = "This incognito draft stays only in memory.";
  await composer(page).fill(saved);
  await page.getByRole("button", { name: "Turn on incognito", exact: true }).click();
  await expect(composer(page)).toHaveText("");
  await composer(page).fill(secret);
  const persisted = await page.evaluate(() => Object.keys(sessionStorage)
    .filter((key) => key.startsWith("juno:composer-draft:"))
    .map((key) => sessionStorage.getItem(key)).join(" "));
  expect(persisted).toContain(saved);
  expect(persisted).not.toContain(secret);
  await page.getByRole("button", { name: "Leave incognito", exact: true }).click();
  await expect(composer(page)).toHaveText(saved);
  expect(await page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission.counts.chat)).toBe(0);
});

test("a successful new chat clears its draft and repeated Send starts only one request", async ({ page }, testInfo) => {
  await installSubmissionFixture(page, { privateMode: false });
  await composer(page).fill("Help me organize the details of this project.");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await expect(send).toBeEnabled();
  // Same task, before an awaited connector/preflight callback resumes.
  await send.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("Send must be a button");
    button.click();
    button.click();
  });
  await expect(page.locator(".prose-juno").last()).toContainText("One accepted request.");
  const counts = await page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission.counts);
  expect(counts.chat).toBe(1);
  expect(counts.clarify).toBe(1);
  await expect(page).toHaveURL(/\/chat\/cmqasubmission000000000001$/);
  await expect(composer(page)).toHaveText("");
  await expect(page.locator('[aria-label="Conversation transcript"] h2').filter({ hasText: "You said" })).toHaveCount(1);
  const acceptedPath = testInfo.outputPath("composer-single-accepted-request.png");
  await page.screenshot({ path: acceptedPath });
  await testInfo.attach("composer-single-accepted-request", { path: acceptedPath, contentType: "image/png" });
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`a newer incognito draft survives the first-send handoff (${reducedMotion})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await installSubmissionFixture(page, { privateMode: true, holdPreflight: true });
    await composer(page).fill("Help me organize the details of this project.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission.counts.clarify)).toBe(1);
    await composer(page).fill("Keep this newer thought for my next message.");
    const pendingPath = testInfo.outputPath(`composer-pending-draft-${reducedMotion}.png`);
    await page.screenshot({ path: pendingPath });
    await testInfo.attach(`composer-pending-draft-${reducedMotion}`, { path: pendingPath, contentType: "image/png" });
    await page.evaluate(() => (window as unknown as { __qaSubmission: SubmissionFixture }).__qaSubmission.release());
    await expect(page.locator(".prose-juno").last()).toContainText("One accepted request.");
    await expect(composer(page)).toHaveText("Keep this newer thought for my next message.");
    const storedDrafts = await page.evaluate(() => Object.keys(sessionStorage)
      .filter((key) => key.startsWith("juno:composer-draft:"))
      .map((key) => sessionStorage.getItem(key)));
    expect(storedDrafts.join(" ")).not.toContain("Keep this newer thought");
    await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  });
}
