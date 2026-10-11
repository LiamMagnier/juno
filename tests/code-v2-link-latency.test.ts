/**
 * End-to-end latency of the phone's link, Mac push → hub → phone, with the
 * real hub (`DeviceLink`) and the real stream (`linkStreamFrames`) and the
 * network and database simulated with fixed costs. It measures what the
 * timers and the request pattern add, the part this code controls:
 *
 *   before: the Mac holds each push for a 50 ms flush timer; the phone
 *           long-polls, so every batch costs a new request (one way out,
 *           sign-in, device and pair lookups), the pair again after the wait
 *           wakes, and one way back.
 *   after:  the Mac pushes the first event at once and batches only while a
 *           push is on the wire; the phone holds one stream open, so a batch
 *           costs the push and one way back.
 *
 * Assumed costs (a good network, a warm pool): 40 ms one way, 8 ms per
 * database lookup. The owner's target is under 300 ms per event.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DeviceLink } from "@/lib/code-v2/env-link-hub";
import { linkStreamFrames } from "@/lib/code-v2/link-stream";
import type { ServerEventEnvelope } from "@/lib/code-v2/contracts";

const ONE_WAY = 40;
const LOOKUP = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (sequence: number): ServerEventEnvelope =>
  ({ type: "event", stream: "session", sessionId: "s1", sequence, at: new Date().toISOString(), event: { type: "item.delta", itemId: "m", field: "text", append: "x" } }) as unknown as ServerEventEnvelope;

/** A streamed answer: `count` deltas, one every `everyMs`, as the env server emits them. */
async function produce(count: number, everyMs: number, emit: (sequence: number, at: number) => void) {
  for (let i = 1; i <= count; i++) {
    emit(i, performance.now());
    await sleep(everyMs);
  }
}

/** The Mac's outbox as it was: a 50 ms timer after the first item, pushes may overlap. */
function oldMac(link: DeviceLink) {
  let queued: ServerEventEnvelope[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (e: ServerEventEnvelope) => {
    queued.push(e);
    if (timer) return;
    timer = setTimeout(async () => {
      timer = undefined;
      const batch = queued;
      queued = [];
      await sleep(ONE_WAY + 2 * LOOKUP); // the push request: one way, sign-in and device
      link.push({ events: batch });
    }, 50);
  };
}

/** The Mac's outbox now: at once when idle, one push in flight, the rest batched. */
function newMac(link: DeviceLink) {
  let queued: ServerEventEnvelope[] = [];
  let pushing = false;
  const flush = async () => {
    pushing = true;
    while (queued.length) {
      const batch = queued;
      queued = [];
      await sleep(ONE_WAY + 2 * LOOKUP);
      link.push({ events: batch });
      await sleep(ONE_WAY); // the push's answer, before the next one leaves
    }
    pushing = false;
  };
  return (e: ServerEventEnvelope) => {
    queued.push(e);
    if (!pushing) void flush();
  };
}

async function measure(mac: "old" | "new", phone: "poll" | "stream"): Promise<{ p50: number; p95: number; max: number }> {
  const link = new DeviceLink();
  await link.pull(0);
  const enqueue = mac === "old" ? oldMac(link) : newMac(link);
  const emitted = new Map<number, number>();
  const latencies: number[] = [];
  const total = 40;
  const done = new AbortController();
  const receive = (events: ServerEventEnvelope[]) => {
    const now = performance.now();
    for (const e of events) {
      const at = emitted.get(e.sequence);
      if (at !== undefined && latencies.length < total) latencies.push(now - at);
    }
    if (latencies.length >= total) done.abort();
  };
  const reader = (async () => {
    if (phone === "stream") {
      await sleep(ONE_WAY + 3 * LOOKUP); // opening the stream, once
      const cursors = { s1: 0 };
      for await (const frame of linkStreamFrames(link, { cursors, signal: done.signal, heartbeatMs: 1_000, pairRecheckMs: 5_000, checkPair: async () => (await sleep(2 * LOOKUP), null) })) {
        if (!frame.startsWith("data:")) continue;
        const payload = JSON.parse(frame.slice(5)) as { events?: ServerEventEnvelope[] };
        // The frame's way to the phone; the next frame does not wait for it.
        void sleep(ONE_WAY).then(() => receive(payload.events ?? []));
      }
    } else {
      let cursor = 0;
      while (!done.signal.aborted) {
        await sleep(ONE_WAY + 4 * LOOKUP); // a new request: one way, sign-in, device, pair
        const reply = await link.poll({ s1: cursor }, -1, 1_000, done.signal);
        await sleep(2 * LOOKUP); // the pair again after the wait wakes
        await sleep(ONE_WAY); // the answer's way back
        const events = reply.events ?? [];
        for (const e of events) cursor = Math.max(cursor, e.sequence);
        receive(events);
      }
    }
  })();
  await sleep(200);
  await produce(total, 50, (sequence, at) => {
    emitted.set(sequence, at);
    enqueue(ev(sequence));
  });
  await Promise.race([reader, sleep(5_000)]);
  done.abort();
  latencies.sort((a, b) => a - b);
  const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  return { p50: at(0.5), p95: at(0.95), max: latencies[latencies.length - 1] };
}

test("latency: the stream and the leading-edge push stay under 300 ms per event; the old path did not", async () => {
  const before = await measure("old", "poll");
  const after = await measure("new", "stream");
  console.log(`link latency per event (40 ms one way, 8 ms per lookup), before p50 ${before.p50.toFixed(0)} p95 ${before.p95.toFixed(0)} max ${before.max.toFixed(0)} ms; after p50 ${after.p50.toFixed(0)} p95 ${after.p95.toFixed(0)} max ${after.max.toFixed(0)} ms`);
  assert.ok(after.p95 < 300, `after p95 ${after.p95.toFixed(0)} ms`);
  assert.ok(after.p50 < before.p50, "faster than before at the median");
});
