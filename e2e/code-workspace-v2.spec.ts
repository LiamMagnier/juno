import { readFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import { readQaFixtures } from "./support/fixtures";

test("Code configures a delegated team and keeps the draft if the team cannot be saved", async ({ page, isMobile }, testInfo) => {
  await page.route("**/api/code/workspaces", (route) => route.fulfill({
    json: { workspaces: [{ id: "qa-workspace", name: "Storefront", path: "/qa/storefront", lastOpenedAt: "2026-11-22T00:00:00.000Z" }] },
  }));
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({ status: 201, json: { conversation: { id: "qa-team-session" } } });
  });
  let routing: unknown;
  let cleaned = false;
  await page.route("**/api/code/routing/qa-team-session", (route) => {
    routing = route.request().postDataJSON().routing;
    return route.fulfill({ status: 400, json: { error: "This routing can't run." } });
  });
  await page.route("**/api/conversations/qa-team-session", (route) => {
    cleaned = route.request().method() === "DELETE";
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/code");
  const draft = page.getByRole("combobox", { name: "Message", exact: true });
  await draft.fill("Make the checkout summary easier to scan.");
  await page.getByRole("button", { name: "Choose a local folder" }).click();
  await page.getByRole("option", { name: /Storefront/ }).click();
  const orchestrator = page.getByRole("button", { name: "Orchestrator", exact: true });
  await orchestrator.click();
  const picker = page.getByRole("dialog", { name: "Orchestrator" });
  const delegated = picker.getByRole("button", { name: "Swarm", exact: true });
  await delegated.click();
  await expect(delegated).toHaveAttribute("aria-pressed", "true");
  await expect(picker.getByRole("button", { name: /Architect/ })).toHaveCount(0);
  await picker.getByRole("button", { name: "More workers" }).click();
  await expect(picker.getByRole("group", { name: "Workers" })).toContainText("×4");
  await expect(picker.getByRole("list", { name: "Team models" }).getByRole("listitem")).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath("code-orchestrator.png"), animations: "disabled" });
  const worker = picker.getByRole("button", { name: /^Worker 2:/ });
  const previous = await worker.getAttribute("aria-label");
  await worker.click();
  await expect(picker.getByText("Choose a model for Worker 2.")).toBeVisible();
  const search = picker.getByRole("textbox", { name: "Search models" });
  await search.fill("Sonnet");
  const option = picker.getByRole("option", { name: /Sonnet/ }).first();
  await expect(option).toBeVisible();
  if (isMobile) {
    await expect.poll(() => picker.locator(".ui-dialog-body").evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath("code-swarm-models.png"), animations: "disabled" });
  await option.click();
  await picker.getByRole("button", { name: "Back to team" }).click();
  await expect(worker).toBeFocused();
  await expect(worker).toHaveAccessibleName(/Worker 2:.*Sonnet/);
  expect(await worker.getAttribute("aria-label")).not.toBe(previous);
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Couldn’t save the orchestrator. Check the team models or try again.")).toBeVisible();
  await expect(draft).toHaveText("Make the checkout summary easier to scan.");
  await expect(page).toHaveURL(/\/code$/);
  await expect.poll(() => cleaned).toBe(true);
  expect(routing).toMatchObject({ preset: "lead-workers", workers: { length: 4 } });
  const { workers } = routing as { workers: { model: string }[] };
  expect(workers[1].model).toContain("sonnet");
  expect(workers[0].model).not.toBe(workers[1].model);
  expect(workers[2].model).toBe(workers[0].model);
});

test("Code opens Agents directly and keeps the composer usable at narrow widths", async ({ page, isMobile }, testInfo) => {
  await page.goto("/code");
  const home = page.getByRole("heading", { name: "What will you build?" });
  await expect(home).toBeVisible();
  const row = page.locator("[data-composer-row]");
  const tools = page.getByRole("group", { name: "Code tools" });
  await expect(row.getByRole("button", { name: /Model:/ })).toBeVisible();
  await expect(row.getByRole("button", { name: /Orchestrator|Mode:|Skills/ })).toHaveCount(0);
  for (const name of [/Orchestrator/, /Mode:/, /Skills/]) {
    await expect(tools.getByRole("button", { name })).toBeVisible();
  }
  const [rowBox, toolBox] = await Promise.all([row.boundingBox(), tools.boundingBox()]);
  expect(toolBox!.y).toBeGreaterThanOrEqual(rowBox!.y + rowBox!.height);
  for (const label of ["Orchestrator", "Accept edits", "Skills"]) {
    const text = tools.getByText(label, { exact: true });
    expect(await text.evaluate((span) => span.scrollWidth - span.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: testInfo.outputPath("code-landing.png"), animations: "disabled" });
  if (isMobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByText("Workspace", { exact: true })).toBeVisible();
  await expect(nav.getByText("Tools", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pull requests", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("code-sidebar.png"), animations: "disabled" });
  await page.getByRole("link", { name: /QA · Code session/ }).click();
  if (isMobile) {
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Sessions", exact: true })).toBeVisible();
  }
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  await agents.click();
  const pane = page.getByRole("tabpanel", { name: "Agents" });
  await expect(pane.getByRole("heading", { name: "No subagents in this run" })).toBeVisible();
  if (isMobile) {
    await expect(page.getByRole("dialog", { name: "Workspace panel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close the panel" })).toBeFocused();
  }
  await page.screenshot({ path: testInfo.outputPath("code-agents.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Close the panel" }).click();
  await expect(pane).toBeHidden();
  if (isMobile) await expect(agents).toBeFocused();
  const draft = page.getByRole("combobox", { name: "Message", exact: true });
  await expect(draft).toBeVisible();
  expect(await page.locator("[data-composer-row]").evaluate((bar) => bar.scrollWidth - bar.clientWidth)).toBeLessThanOrEqual(1);
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.locator("[data-composer-row]").evaluate((bar) => bar.scrollWidth - bar.clientWidth)).toBeLessThanOrEqual(1);
  }
});


test("Chat and Code share the resting editor and Code offers voice without a build-time relay URL", async ({ page }, testInfo) => {
  await page.route("**/api/voice/relay-token*", (route) => route.fulfill({
    status: 503, json: { error: "Realtime voice is not configured." },
  }));
  const geometry = async () => page.locator('.chat-composer[data-frame="home"]').evaluate((box) => {
    const field = box.querySelector('[role="combobox"]')!;
    const row = box.querySelector("[data-composer-row]")!;
    const shellStyle = getComputedStyle(box);
    const fieldStyle = getComputedStyle(field);
    const rowStyle = getComputedStyle(row);
    return {
      radius: shellStyle.borderRadius,
      padding: shellStyle.padding,
      shadow: shellStyle.boxShadow,
      field: [fieldStyle.fontSize, fieldStyle.padding, fieldStyle.minHeight],
      controls: [rowStyle.padding, rowStyle.columnGap],
    };
  });
  // Wait for the real focus shadow to settle after autofocus is cleared.
  // The browser can otherwise sample either composer halfway through its transition.
  const rest = (editor: Locator) => editor.evaluate(async (field) => {
    field.blur();
    const shell = field.closest(".chat-composer");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.allSettled(shell?.getAnimations().map((animation) => animation.finished) ?? []);
  });
  await page.goto("/chat");
  const chatEditor = page.getByRole("combobox", { name: "Message Alevr", exact: true });
  await expect(chatEditor).toBeEditable();
  await rest(chatEditor);
  const chat = await geometry();
  await page.screenshot({ path: testInfo.outputPath("chat-reference.png"), animations: "disabled" });
  await page.goto("/code");
  const editor = page.getByRole("combobox", { name: "Message", exact: true });
  await expect(editor).toBeEditable();
  await rest(editor);
  await expect.poll(geometry).toEqual(chat);
  const launcher = page.getByRole("button", { name: "Start voice conversation" });
  await expect(launcher).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("code-chat-composer.png"), animations: "disabled" });

  const strokes = await page.locator('.chat-composer svg[data-interface-icon]').evaluateAll((icons) =>
    icons.map((icon) => [getComputedStyle(icon).strokeWidth, getComputedStyle(icon.querySelector("path, circle, rect")!).vectorEffect]),
  );
  expect(strokes.length).toBeGreaterThan(2);
  expect(strokes.every(([width, effect]) => width === "1.5px" && effect === "non-scaling-stroke")).toBe(true);

  const token = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/voice/relay-token");
  await launcher.click();
  await token;
  await expect(page.getByRole("alert").filter({ hasText: "Realtime voice is not configured." })).toBeVisible();
  await page.getByRole("button", { name: "Close voice", exact: false }).click();
  await expect(launcher).toBeVisible();

  await editor.fill("Keep this draft");
  await page.getByRole("button", { name: "Add files and more" }).click();
  const add = page.getByRole("menu", { name: "Add files and more", exact: true });
  await expect(add.getByText("Attach", { exact: true })).toBeVisible();
  await expect(add.getByRole("menuitem", { name: "Photos & files" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("code-add-menu.png"), animations: "disabled" });
  await add.getByRole("menuitem", { name: "Use a command" }).click();
  await expect.poll(() => editor.evaluate((field) => (field as HTMLTextAreaElement).value)).toBe("Keep this draft\n/");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
});

test("the Swarm grid and activity follow persisted Code task events", async ({ page, isMobile }, testInfo) => {
  const { qaCodeSessionId } = readQaFixtures();
  expect(qaCodeSessionId).toBeTruthy();
  const lead = { instanceId: "alevr", model: "anthropic:claude-opus-5-5" };
  const worker = { instanceId: "alevr", model: "anthropic:claude-sonnet-5-5" };
  const task = { id: "qa-swarm-task", status: "running", target: "device" };
  await page.route(`**/api/code/routing/${qaCodeSessionId}`, (route) => route.fulfill({
    json: { routing: { preset: "lead-workers", orchestrator: lead, workers: [lead, worker] } },
  }));
  await page.route("**/api/code/tasks?conversationId=*&limit=20", (route) => route.fulfill({ json: { tasks: [task] } }));
  const agents = [
    { id: "qa-worker-1", title: "Map the auth middleware", role: "worker", model: lead.model, status: "done" },
    { id: "qa-worker-2", title: "Check the password reset form", role: "worker", model: worker.model, status: "running", currentActivity: "Inspecting the reset page" },
  ];
  await page.route(`**/api/code/tasks/${task.id}/events?*`, (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "events", task, events: agents.map((agent, index) => ({
      seq: index + 1, kind: "agent", createdAt: new Date().toISOString(), payload: { agent },
    })) })}\n\n`,
  }));

  await page.goto(`/code/${qaCodeSessionId}`);
  await expect(page.getByRole("button", { name: /^Orchestrator: Swarm/ })).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Agents" });
  const grid = panel.getByRole("list", { name: "Swarm agents" });
  const workerTwo = grid.getByRole("button", { name: /Worker 2.*Sonnet/i });
  await expect(grid.getByRole("listitem")).toHaveCount(3);
  await expect(workerTwo).toBeVisible();
  await expect(workerTwo.locator(".agent-face[data-state=working]")).toBeVisible();
  await expect(grid.getByRole("button", { name: /Worker 1/ }).locator(".agent-face[data-state=done]")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("code-swarm-live.png"), animations: "disabled" });
  await panel.getByRole("button", { name: /^activity$/i }).click();
  const activity = panel.getByRole("list", { name: "Swarm activity" });
  await expect(activity.getByText(/Check the password reset form/)).toBeVisible();
  await panel.getByRole("button", { name: /^grid$/i }).click();
  await workerTwo.click();
  await expect(panel.getByRole("heading", { name: "Worker 2" })).toBeVisible();
  if (isMobile) {
    await panel.getByRole("button", { name: "All agents" }).click();
    await expect(workerTwo).toBeFocused();
  }
});

test("Code reads an answer aloud and downloads the visible conversation", async ({ page }, testInfo) => {
  const { qaCodeSessionId } = readQaFixtures();
  expect(qaCodeSessionId).toBeTruthy();
  await page.goto(`/code/${qaCodeSessionId}`);

  const answer = page.getByRole("toolbar", { name: "Answer actions" }).last();
  await expect(answer.getByRole("button", { name: "Read aloud" })).toBeVisible();
  let finishSpeech!: () => void;
  const speechResponse = new Promise<void>((resolve) => { finishSpeech = resolve; });
  await page.route("**/api/voice/tts", async (route) => {
    await speechResponse;
    await route.fulfill({ status: 503, json: { error: "Speech service test" } });
  });
  try {
    const request = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/voice/tts");
    await answer.getByRole("button", { name: "Read aloud" }).click();
    expect((await request).postDataJSON().text).toContain("Added");
    await answer.getByRole("button", { name: "Stop reading" }).click();
    await expect(answer.getByRole("button", { name: "Read aloud" })).toBeVisible();
  } finally {
    finishSpeech();
  }

  await page.screenshot({ path: testInfo.outputPath("code-thread.png"), animations: "disabled" });
  const openExport = async () => {
    await page.locator(".cv2-crumb").getByRole("button", { name: "QA · Code session" }).click();
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
  };
  await openExport();
  const started = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download Markdown", exact: true }).click();
  const download = await started;
  expect(download.suggestedFilename()).toBe("qa-code-session.md");
  const path = await download.path();
  const markdown = await readFile(path, "utf8");
  expect(markdown).toContain("Add a health check route that returns ok.");
  expect(markdown).toContain("Added");

  await page.evaluate(() => {
    window.print = () => {
      const transcript = document.querySelector("[data-print-document]");
      document.body.dataset.printedTranscript = transcript?.textContent ?? "";
      window.dispatchEvent(new Event("afterprint"));
    };
  });
  await openExport();
  await page.getByRole("menuitem", { name: "Print or save as PDF", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed-transcript", /Add a health check route/);
  await expect(page.locator("[data-print-document]")).toHaveCount(0);
});
