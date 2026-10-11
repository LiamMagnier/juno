/**
 * The device link's push stream (src/lib/code-v2/link-stream.ts): the phone
 * keeps one response open and each batch the Mac pushes is written into it at
 * once. Timers and batching: events leave within milliseconds of the push,
 * a quiet stream sends heartbeats, the window ends it, the pair is re-checked
 * at most every `pairRecheckMs`, and the cursors advance inside the stream.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DeviceLink, LINK_RELAYED_COMMANDS } from "@/lib/code-v2/env-link-hub";
import { LINK_STREAM_LIMITS, advanceCursors, linkStreamFrames } from "@/lib/code-v2/link-stream";
import type { ServerEventEnvelope } from "@/lib/code-v2/contracts";

const ev = (sessionId: string, sequence: number): ServerEventEnvelope =>
  ({ type: "event", stream: "session", sessionId, sequence, at: new Date().toISOString(), event: { type: "item.delta", itemId: "i", field: "text", append: "x" } }) as unknown as ServerEventEnvelope;
const gev = (sequence: number): ServerEventEnvelope =>
  ({ type: "event", stream: "global", sequence, at: new Date().toISOString(), event: { type: "provider.updated", instance: {} } }) as unknown as ServerEventEnvelope;

async function onlineLink(): Promise<DeviceLink> {
  const link = new DeviceLink();
  await link.pull(0);
  return link;
}

function parse(frame: string): { events?: ServerEventEnvelope[]; offline?: boolean; error?: string } | "ping" {
  if (frame.startsWith(":")) return "ping";
  return JSON.parse(frame.replace(/^data: /, "").trim());
}

test("stream limits: under the route's 60 s maxDuration, heartbeat well inside proxy timeouts", () => {
  assert.ok(LINK_STREAM_LIMITS.windowMs < 60_000);
  assert.ok(LINK_STREAM_LIMITS.heartbeatMs <= 20_000);
  assert.ok(LINK_STREAM_LIMITS.pairRecheckMs <= 10_000);
  assert.ok(LINK_RELAYED_COMMANDS.has("session.setMode"), "the phone's access picker reaches the Mac");
});

test("advanceCursors: per followed session and the global stream, never backwards", () => {
  const cursors: Record<string, number> = { s1: 4, s2: 10 };
  const global = advanceCursors(cursors, 2, [ev("s1", 5), ev("s1", 6), ev("s2", 9), ev("other", 99), gev(3)]);
  assert.deepEqual(cursors, { s1: 6, s2: 10 });
  assert.equal(global, 3);
});

test("stream: a push reaches the open stream within milliseconds, one frame per batch", async () => {
  const link = await onlineLink();
  const abort = new AbortController();
  const frames = linkStreamFrames(link, { cursors: { s1: 0 }, signal: abort.signal, heartbeatMs: 5_000 });
  const latencies: number[] = [];
  for (let i = 1; i <= 20; i++) {
    const next = frames.next();
    const pushedAt = performance.now();
    setTimeout(() => link.push({ events: [ev("s1", i)] }), 0);
    const frame = parse((await next).value as string);
    latencies.push(performance.now() - pushedAt);
    assert.ok(frame !== "ping");
    assert.deepEqual(frame.events?.map((e) => e.sequence), [i], "cursors advance inside the stream");
  }
  abort.abort();
  await frames.return(undefined);
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95) - 1];
  // In-process the hub hands a push to the waiting stream in about a millisecond.
  assert.ok(p95 < 50, `p95 push to frame ${p95.toFixed(1)} ms`);
});

test("stream: quiet means a heartbeat; the window ends it; offline is said once and ends it", async () => {
  const link = await onlineLink();
  let clock = 0;
  const frames = linkStreamFrames(link, { cursors: { s1: 0 }, heartbeatMs: 10, windowMs: 1_000, now: () => clock });
  assert.equal(parse((await frames.next()).value as string), "ping");
  clock = 2_000;
  assert.equal((await frames.next()).done, true, "the window is over");

  // Offline: a link that has never been pulled is offline.
  const offline = linkStreamFrames(new DeviceLink(), { cursors: { s1: 0 }, heartbeatMs: 10 });
  const first = parse((await offline.next()).value as string);
  assert.ok(first !== "ping" && first.offline === true);
  assert.equal((await offline.next()).done, true);
});

test("stream: the pair is re-checked before events leave, at most every pairRecheckMs, and a refusal ends it", async () => {
  const link = await onlineLink();
  let clock = 0;
  let checks = 0;
  let refuse: string | null = null;
  const frames = linkStreamFrames(link, {
    cursors: { s1: 0 },
    heartbeatMs: 1_000,
    pairRecheckMs: 5_000,
    now: () => clock,
    checkPair: async () => {
      checks++;
      return refuse;
    },
  });
  link.push({ events: [ev("s1", 1)] });
  await frames.next();
  assert.equal(checks, 0, "checked when it opened (by the route), not again inside the window");
  clock = 6_000;
  link.push({ events: [ev("s1", 2)] });
  await frames.next();
  assert.equal(checks, 1);
  clock = 7_000;
  link.push({ events: [ev("s1", 3)] });
  await frames.next();
  assert.equal(checks, 1, "not per batch");
  clock = 12_000;
  refuse = "This phone is no longer paired with your Mac.";
  link.push({ events: [ev("s1", 4)] });
  const refused = parse((await frames.next()).value as string);
  assert.ok(refused !== "ping" && refused.error === refuse && !refused.events);
  assert.equal((await frames.next()).done, true);
});
