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
