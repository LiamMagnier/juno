/**
 * Code v3 web functional lane: the terminal stream behind the xterm dock tab,
 * DeviceLinkTransport following the global stream, and the pieces added
 * below (hunk reject, resume at reset, the /code shell sidebar, Antigravity,
 * OpenRouter BYOK).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { appendTerminal, cssColorFromToken, terminalDelta } from "@/lib/code-v2/terminal-stream";
import { DeviceLinkTransport, type FetchLike } from "@/lib/code-v2/env-client";
import { publishThreadState, shellThreads, subscribeThreadStates, threadStateFromRun, threadStatesSnapshot } from "@/lib/code-v2/shell-threads";
import { threadSections } from "@/lib/code-v2/thread-sections";
import { hunkPatch, parseUnifiedDiff } from "@/lib/code-v2/diff";
import { checkPastedRedirect, isManaged, managedStep, safeAuthorizationUrl } from "@/lib/code-v2/managed-runtime";
import { managedCall, runtimeRequest } from "@/lib/code-v2/runtime-lane";
import { DeviceLink } from "@/lib/code-v2/env-link-hub";
import type { ClientCommand, ProviderInstance } from "@/lib/code-v2/contracts";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionsPanel } from "@/components/code/v2/connections";
import { DEVICE, INSTANCES } from "../src/app/dev/code-v2/fixtures";
import { openRouterLab, openRouterPickerModels } from "@/lib/code-v2/openrouter";
import { byokAuthHeaders, byokBaseUrl, isByokOnlyProvider, keyTestRequest } from "@/lib/code-v2/byok";
import { chooseKeySource } from "@/lib/code-v2/agent-routing";
import { buildInstances } from "@/lib/code-v2/workspace-instances";
import { looksLikeKey } from "@/lib/code-v2/byok-client";
import { modelLab } from "@/lib/code-v2/providers-view";

// Some shared brand components use the classic JSX runtime (React in scope); tsx does not inject it.
(globalThis as unknown as { React: typeof React }).React = React;

test("terminal stream: appends, trims the front and counts what it dropped", () => {
  let buf = { output: "", offset: 0 };
  buf = appendTerminal(buf, "hello ", 10);
  buf = appendTerminal(buf, "world!", 10);
  assert.deepEqual(buf, { output: "llo world!", offset: 2 });
  assert.equal(buf.offset + buf.output.length, 12, "stream position is preserved");
});

test("terminal stream: a view writes only what is new, and resets when it fell behind the tail", () => {
  const buf = { output: "abcdef", offset: 4 }; // stream positions 4..10
  assert.deepEqual(terminalDelta(buf, 0), { reset: true, data: "abcdef", position: 10 });
  assert.deepEqual(terminalDelta(buf, 4), { reset: false, data: "abcdef", position: 10 });
  assert.deepEqual(terminalDelta(buf, 8), { reset: false, data: "ef", position: 10 });
  assert.deepEqual(terminalDelta(buf, 10), { reset: false, data: "", position: 10 });
  assert.deepEqual(terminalDelta(buf, 99), { reset: true, data: "abcdef", position: 10 }, "ahead of the stream: another terminal");
});

test("terminal stream: theme tokens become CSS colors xterm accepts", () => {
  assert.equal(cssColorFromToken("240.000 20.000% 99.020%", "#fff"), "hsl(240.000 20.000% 99.020%)");
  assert.equal(cssColorFromToken(" #101010 ", "#fff"), "#101010");
  assert.equal(cssColorFromToken("", "#fff"), "#fff");
  assert.equal(cssColorFromToken("var(--x)", "#fff"), "#fff");
});

test("DeviceLinkTransport.followGlobal polls the global stream with no session open", async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  let t: DeviceLinkTransport | null = null;
  const fetcher: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    calls++;
    if (calls >= 2) t?.close();
    const events = calls === 1 ? [{ type: "event", stream: "global", sequence: 3, at: "", event: { type: "terminal.output", terminalId: "t1", data: "hi" } }] : [];
    return { ok: true, status: 200, json: async () => ({ events }) };
  };
  t = new DeviceLinkTransport("mac-1", fetcher);
  const seen: unknown[] = [];
  t.onMessage((m) => seen.push(m));
  t.followGlobal();
  for (let i = 0; i < 50 && calls < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(bodies[0].kind, "poll");
  assert.deepEqual(bodies[0].cursors, {});
  assert.equal(bodies[1].globalCursor, 3, "the next poll continues after the last global event");
  assert.equal(seen.length, 1);
});

// ── The app shell's Code column ─────────────────────────────────────────────


test("shell threads: Code sessions only, live state over the run, project sections with Needs you first", () => {
  const conversations = [
    { id: "a", title: "Fix login", kind: "code", codeWorkspaceName: "shop", lastMessageAt: "2026-10-09T10:00:00Z" },
    { id: "b", title: "", kind: "code", codeWorkspaceName: "shop", lastMessageAt: "2026-10-09T11:00:00Z" },
    { id: "c", title: "Chat", kind: "chat", lastMessageAt: "2026-10-09T12:00:00Z" },
    { id: "d", title: "Old", kind: "code", archivedAt: "2026-10-01T00:00:00Z", lastMessageAt: "2026-10-01T00:00:00Z" },
    { id: "e", title: "Docs", kind: "code", codeWorkspaceName: null, lastMessageAt: "2026-10-08T00:00:00Z", pinned: true },
  ];
  const runs = new Map([
    ["a", "running" as const],
    ["b", "waiting" as const],
  ]);
  const live = new Map([["a", { state: "waiting" as const, waitingFor: "wants to run a command" }]]);
  const threads = shellThreads(conversations, runs, live);
  assert.deepEqual(threads.map((t) => t.id), ["a", "b", "e"]);
  assert.equal(threads[0].state, "waiting", "the open workspace's live state wins");
  assert.equal(threads[0].waitingFor, "wants to run a command");
  assert.equal(threads[1].title, "Untitled session");
  assert.equal(threads[2].project, "Not in a project");
  const sections = threadSections(threads);
  assert.deepEqual(sections.map((s) => s.title), ["Needs you", "Pinned", "shop"]);
});

test("shell threads: run states map to row states; the live store notifies only on change", () => {
  assert.equal(threadStateFromRun("needs-approval", false), "waiting");
  assert.equal(threadStateFromRun("review", true), "waiting");
  assert.equal(threadStateFromRun("working", false), "running");
  assert.equal(threadStateFromRun("queued", false), "running");
  assert.equal(threadStateFromRun("failed", false), "error");
  assert.equal(threadStateFromRun("finished", false), "idle");
  let calls = 0;
  const off = subscribeThreadStates(() => calls++);
  publishThreadState("x", { state: "running" });
  publishThreadState("x", { state: "running" });
  const snap = threadStatesSnapshot();
  publishThreadState("x", null);
  publishThreadState("x", null);
  off();
  assert.equal(calls, 2);
  assert.equal(snap.get("x")?.state, "running");
  assert.equal(threadStatesSnapshot().has("x"), false);
});

// ── Hunk reject on the Mac ──────────────────────────────────────────────────

const TWO_HUNKS = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@ function f()
 ten
+ten and a half
 eleven
`;

test("hunk patch: one hunk's forward patch, which the Mac applies in reverse to reject it", () => {
  const [file] = parseUnifiedDiff(TWO_HUNKS);
  const second = file.hunks[1].id;
  const patch = hunkPatch(file, [second]);
  assert.equal(
    patch,
    ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,2 +10,3 @@ function f()", " ten", "+ten and a half", " eleven", ""].join("\n"),
  );
  assert.equal(hunkPatch(file, ["nope"]), "");
  const [added] = parseUnifiedDiff("--- /dev/null\n+++ b/new.md\n@@ -0,0 +1 @@\n+hello\n");
  const addPatch = hunkPatch({ ...added, change: "add" }, [added.hunks[0].id]);
  assert.match(addPatch, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/new\.md/);
});

test("runtime lane commands are relayed by the hub and reach the Mac as typed", async () => {
  const link = new DeviceLink();
  await link.pull(0);
  const client = {
    request: (type: string, params: unknown) => link.rpc({ id: "c1", type, params } as unknown as ClientCommand).then((r) => r.responses?.[0]),
  };
  const pending = runtimeRequest(client as never, "checkpoint.applyPatch", { sessionId: "s1", patch: "x", reverse: true });
  const { commands } = await link.pull(0);
  const cmd = commands[0] as unknown as { id: string; type: string; params: unknown };
  assert.equal(cmd.type, "checkpoint.applyPatch");
  assert.deepEqual(cmd.params, { sessionId: "s1", patch: "x", reverse: true });
  link.push({ responses: [{ type: "response", id: cmd.id, ok: true, result: { applied: true, files: ["src/a.ts"] } }] });
  assert.equal(((await pending) as unknown as { ok: boolean }).ok, true);
  for (const type of ["turn.schedule", "turn.unschedule", "provider.install", "provider.auth"]) {
    const r = link.rpc({ id: "c2", type, params: {} } as unknown as ClientCommand);
    const { commands: next } = await link.pull(0);
    assert.equal(next[0].type, type, type);
    link.push({ responses: [{ type: "response", id: next[0].id, ok: true, result: {} }] });
    await r;
  }
});

test("managed calls pick the command and drop empty fields", async () => {
  const calls: [string, unknown][] = [];
  const client = { request: async (type: string, params: unknown) => (calls.push([type, params]), type === "provider.auth" ? { auth: { phase: "waiting" } } : { install: { phase: "downloading" } }) };
  assert.deepEqual(await managedCall(client as never, "acp:antigravity", { type: "auth", action: "start" }), { auth: { phase: "waiting" } });
  await managedCall(client as never, "acp:antigravity", { type: "auth", action: "complete", flowId: "f1", callbackUrl: "http://localhost:51121/cb?code=x" });
  assert.deepEqual(await managedCall(client as never, "acp:antigravity", { type: "install", action: "start" }), { install: { phase: "downloading" } });
  assert.deepEqual(calls, [
    ["provider.auth", { instanceId: "acp:antigravity", action: "start" }],
    ["provider.auth", { instanceId: "acp:antigravity", action: "complete", flowId: "f1", callbackUrl: "http://localhost:51121/cb?code=x" }],
    ["provider.install", { instanceId: "acp:antigravity", action: "start" }],
  ]);
});

// ── Antigravity: managed install and sign-in ────────────────────────────────

const AG: ProviderInstance = { id: "acp:antigravity", kind: "acp", label: "Antigravity", status: "signed-out", acpCommand: ["antigravity-acp"] };

test("managed runtime: install progress, then a Google sign-in that waits on the loopback", () => {
  assert.equal(isManaged(AG), false, "an older env server: the terminal setup applies");
  const notInstalled = { ...AG, status: "not-installed", install: { phase: "idle", version: "1.2.0" } } as ProviderInstance;
  assert.equal(isManaged(notInstalled), true);
  assert.deepEqual(managedStep(notInstalled), { kind: "install", busy: false, pct: undefined, sentence: "Not installed. Alevr downloads the vendor's own release (1.2.0) and checks it before it runs.", operationId: undefined });
  const downloading = managedStep(notInstalled, { install: { phase: "downloading", operationId: "op1", downloadedBytes: 25_000_000, totalBytes: 100_000_000 } });
  assert.equal(downloading?.kind, "install");
  assert.equal(downloading?.busy, true);
  assert.equal(downloading?.kind === "install" && downloading.pct, 25);
  const waiting = managedStep({ ...AG, auth: { phase: "waiting", flowId: "f1", authorizationUrl: "https://accounts.google.com/o?x=1", method: "Google account" } } as ProviderInstance);
  assert.equal(waiting?.kind, "sign-in");
  assert.equal(waiting?.kind === "sign-in" && waiting.waiting, true);
  assert.equal(waiting?.sentence, "Sign in with your Google account to finish.");
  const ready = managedStep({ ...AG, status: "ready", auth: { phase: "idle" } } as ProviderInstance);
  assert.equal(ready, null, "signed in: the row is an ordinary subscription again");
});

test("managed runtime: only https sign-in pages open, and only loopback redirects with an answer are sent to the Mac", () => {
  assert.equal(safeAuthorizationUrl("https://accounts.google.com/o?x=1"), "https://accounts.google.com/o?x=1");
  assert.equal(safeAuthorizationUrl("javascript:alert(1)"), null);
  assert.equal(safeAuthorizationUrl("http://accounts.google.com"), null);
  assert.deepEqual(checkPastedRedirect(" http://localhost:51121/oauth-callback?code=4/abc&state=s "), { ok: true, url: "http://localhost:51121/oauth-callback?code=4/abc&state=s" });
  assert.equal(checkPastedRedirect("http://127.0.0.1:8080/cb?error=access_denied").ok, true);
  assert.equal(checkPastedRedirect("https://evil.example/cb?code=1").ok, false);
  assert.equal(checkPastedRedirect("http://localhost/cb?code=1").ok, false, "a loopback redirect always has a port");
  assert.equal(checkPastedRedirect("http://localhost:5000/cb").ok, false);
  assert.equal(checkPastedRedirect("not a url").ok, false);
});

test("Connections: Antigravity mid sign-in offers the Google page and the paste-back path; an older Mac says to update", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: INSTANCES, device: DEVICE, onManaged: async () => ({}), initialSelected: "acp:antigravity" }));
  assert.match(html, /Antigravity/);
  assert.match(html, /Sign in with your Google account to finish\./);
  assert.match(html, /href="https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=example"[^>]*target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Not on your Mac\?/);
  assert.match(html, />Cancel</);
  const older = renderToStaticMarkup(React.createElement(ConnectionsPanel, { instances: INSTANCES.filter((i) => i.id !== "acp:antigravity"), device: DEVICE, initialSelected: "acp:antigravity" }));
  assert.match(older, /Antigravity<\/span><span class="ds">Update Alevr on your Mac/);
  assert.match(older, /<p class="cv2-ds"[^>]*>Your Mac does not offer this yet\./);
  assert.doesNotMatch(older + html, /\u2014/, "no em-dashes in UI copy");
});

// ── OpenRouter on the user's own key ────────────────────────────────────────

test("OpenRouter BYOK: its own endpoint, a key test that a bad key fails, attribution headers, never Alevr's key", () => {
  assert.equal(isByokOnlyProvider("openrouter"), true);
  assert.equal(isByokOnlyProvider("anthropic"), false);
  assert.equal(byokBaseUrl("openrouter"), "https://openrouter.ai/api/v1");
  assert.equal(keyTestRequest("openrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz").url, "https://openrouter.ai/api/v1/key");
  assert.deepEqual(byokAuthHeaders("openrouter", "k"), { authorization: "Bearer k", "http-referer": "https://alevr.com", "x-title": "Alevr" });
  assert.equal(looksLikeKey("openrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz"), true);
  assert.deepEqual(chooseKeySource({ preference: "auto", provider: "openrouter", hasUserKey: true }), { ok: true, source: "byok", provider: "openrouter" });
  const missing = chooseKeySource({ preference: "auto", provider: "openrouter", hasUserKey: false });
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.status, 409);
  const alevr = chooseKeySource({ preference: "alevr", provider: "openrouter", hasUserKey: true });
  assert.equal(!alevr.ok && alevr.body.code, "BYOK_ONLY_PROVIDER");
});

test("OpenRouter models: tool-capable text models with prices, big labs first, wearing their lab's mark", () => {
  const rows = [
    { id: "acme/tiny", name: "Acme: Tiny", context_length: 32_000, pricing: { prompt: "0.0000001", completion: "0.0000002" }, supported_parameters: ["tools"] },
    { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", context_length: 1_000_000, pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" }, supported_parameters: ["tools", "reasoning"] },
    { id: "openai/gpt-image", name: "OpenAI: Image", pricing: { prompt: "0.00001", completion: "0.00004" }, supported_parameters: ["tools"], architecture: { output_modalities: ["image"] } },
    { id: "meta-llama/llama-5", name: "Meta: Llama 5", context_length: 128_000, pricing: { prompt: "0.0000002", completion: "0.0000006" } },
    { id: "openrouter/auto", name: "Auto Router", pricing: { prompt: "-1", completion: "-1" }, supported_parameters: ["tools"] },
  ];
  const models = openRouterPickerModels(rows);
  assert.deepEqual(models.map((m) => m.id), ["openrouter:anthropic/claude-sonnet-4.5", "openrouter:acme/tiny"]);
  assert.equal(models[0].label, "Claude Sonnet 4.5");
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(models[0].contextTiers, [{ tokens: 1_000_000, label: "1M", inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }]);
  assert.equal(openRouterLab("x-ai/grok-5"), "xai");
  assert.equal(openRouterLab("acme/tiny"), null);
  assert.equal(modelLab("openrouter:anthropic/claude-sonnet-4.5"), "anthropic");
  assert.equal(modelLab("openrouter:acme/tiny"), null);
  const instances = buildInstances({ alevrModels: [], byokKeys: [{ provider: "openrouter", hint: "…abcd", addedAt: "2026-10-09T00:00:00Z" }], openRouterModels: models });
  const or = instances.find((i) => i.id === "byok:openrouter");
  assert.deepEqual(or?.models?.map((m) => m.id), models.map((m) => m.id));
  assert.equal(or?.status, "ready");
});
