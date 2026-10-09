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
