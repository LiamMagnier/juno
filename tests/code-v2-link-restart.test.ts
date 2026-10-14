import assert from "node:assert/strict";
import { test } from "node:test";

import { DeviceLink, LINK_LIMITS } from "@/lib/code-v2/env-link-hub";
import { DeviceLinkTransport, type FetchLike } from "@/lib/code-v2/env-client";
import { linkStreamFrames } from "@/lib/code-v2/link-stream";
import type { ClientCommand, ServerEventEnvelope, ServerResponse } from "@/lib/code-v2/contracts";

const globalEvent = (sequence: number, data: string): ServerEventEnvelope => ({
  type: "event",
  stream: "global",
  sequence,
  at: "2026-10-14T12:00:00Z",
  event: { type: "terminal.output", terminalId: "terminal-1", data },
});

const success = (id: string, result: unknown = {}): ServerResponse => ({ type: "response", id, ok: true, result });

test("link restart: delayed responses cannot settle another command or another viewer's RPC", async (t) => {
  const previous = new DeviceLink();
  const current = new DeviceLink();
  await previous.pull(0);
  await current.pull(0);
  const oldReply = previous.rpc({ id: "7", type: "provider.list", params: {} });
  const [oldCommand] = (await previous.pull(0)).commands;
  const commands: ClientCommand[] = [];
  const replies = [
    current.rpc({ id: "7", type: "git.push", params: { sessionId: "s1" } }),
    current.rpc({ id: "7", type: "provider.list", params: {} }),
  ];
  commands.push(...(await current.pull(0)).commands);
  t.after(async () => {
    previous.push({ responses: [success(oldCommand.id)] });
    current.push({ responses: commands.map((command) => success(command.id)) });
    await Promise.all([oldReply, ...replies]);
  });

  assert.equal(current.stats().pending, 2);
  const stale = current.push({ responses: [success(oldCommand.id, { instances: [] })] });
  assert.equal(stale.accepted, 0, "an old host outbox must not report success for a new action");
  assert.equal(current.stats().pending, 2);
  assert.equal(new Set([oldCommand.id, ...commands.map((command) => command.id)]).size, 3);

  current.push({ responses: [success(commands[1].id, { instances: [] }), success(commands[0].id, { pushed: true })] });
  assert.deepEqual((await replies[0]).responses, [success("7", { pushed: true })]);
  assert.deepEqual((await replies[1]).responses, [success("7", { instances: [] })]);
});

test("link restart: a delayed replay receipt cannot mark a fresh hub's session as covered", async () => {
  let now = 1_000_000;
  const previous = new DeviceLink(() => now);
  const current = new DeviceLink(() => now);
  await previous.pull(0);
  await current.pull(0);
  await previous.poll({ s1: 10 }, -1, 0);
  const [oldReplay] = (await previous.pull(0)).commands;
  await current.poll({ s1: 5 }, -1, 0);
  const [currentReplay] = (await current.pull(0)).commands;

  current.push({ responses: [success(oldReplay.id, { sessionId: "s1" })] });
  now += LINK_LIMITS.replayCooldownMs + 1;
  await current.poll({ s1: 5 }, -1, 0);
  assert.equal((await current.pull(0)).commands.length, 1, "the new replay has not completed and must remain recoverable");
  assert.notEqual(oldReplay.id, currentReplay.id);
});

test("link restart: concurrent browser viewers rebase global cursors without repeating terminal output", async (t) => {
  const previous = new DeviceLink();
  const current = new DeviceLink();
  await previous.pull(0);
  await current.pull(0);
  previous.push({ events: Array.from({ length: 5 }, (_, i) => globalEvent(i, `old-${i}`)) });
  current.push({ events: [globalEvent(10, "new-1")] });
  let nextPushed = false;

  const view = () => {
    const requests: number[] = [];
    const output: string[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const fetcher: FetchLike = async (_url, init) => {
      const request = JSON.parse(init?.body ?? "{}");
      requests.push(request.globalCursor);
      if (requests.length === 3 && !nextPushed) {
        nextPushed = true;
        current.push({ events: [globalEvent(11, "new-2")] });
      }
      const link = requests.length === 1 ? previous : current;
      const reply = await link.poll(request.cursors, request.globalCursor, 0);
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (requests.length === 3) {
            transport.close();
            setImmediate(finished);
          }
          return reply;
        },
      };
    };
    const transport = new DeviceLinkTransport("mac-1", fetcher);
    transport.onMessage((message) => {
      if (message.type === "event" && message.event.type === "terminal.output") output.push(message.event.data);
    });
    t.after(() => transport.close());
    transport.followGlobal();
    return { requests, output, done };
  };

  const viewers = [view(), view()];
  await Promise.all(viewers.map((viewer) => viewer.done));
  for (const viewer of viewers) {
    assert.deepEqual(viewer.requests, [-1, 5, 1]);
    assert.deepEqual(viewer.output, ["old-0", "old-1", "old-2", "old-3", "old-4", "new-1", "new-2"]);
  }
});

test("link transport: equal and overlapping global batches stay deduplicated; session events do not reset them", async (t) => {
  const batches = [
    [globalEvent(1, "first"), globalEvent(2, "second")],
    [globalEvent(1, "first"), globalEvent(2, "second")],
    [{ ...globalEvent(100, "session"), stream: "session", sessionId: "s1" } as ServerEventEnvelope],
    [globalEvent(2, "second"), globalEvent(3, "third")],
  ];
  const cursors: number[] = [];
  const output: string[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const fetcher: FetchLike = async (_url, init) => {
    cursors.push(JSON.parse(init?.body ?? "{}").globalCursor);
    const events = batches[cursors.length - 1];
    if (cursors.length === batches.length) {
      transport.close();
      setImmediate(finished);
    }
    return { ok: true, status: 200, json: async () => ({ events }) };
  };
  const transport = new DeviceLinkTransport("mac-1", fetcher);
  t.after(() => transport.close());
  transport.onMessage((message) => {
    if (message.type === "event" && message.stream === "global" && message.event.type === "terminal.output") output.push(message.event.data);
  });
  transport.followGlobal();
  await done;
  assert.deepEqual(cursors, [-1, 2, 2, 2]);
  assert.deepEqual(output, ["first", "second", "third"]);
});

test("link restart: an SSE stream consumes the renumbered tail once, then waits for new events", async () => {
  const link = new DeviceLink();
  await link.pull(0);
  link.push({ events: [globalEvent(500, "new-1"), globalEvent(501, "new-2")] });
  const frames = linkStreamFrames(link, { cursors: {}, globalCursor: 100, heartbeatMs: 5 });
  try {
    const first = JSON.parse((await frames.next()).value!.replace(/^data: /, "").trim());
    assert.deepEqual(first.events.map((event: ServerEventEnvelope) => event.sequence), [1, 2]);
    assert.equal((await frames.next()).value, ": ping\n\n", "a restart must not create an immediate replay loop");
    link.push({ events: [globalEvent(502, "new-3")] });
    const next = JSON.parse((await frames.next()).value!.replace(/^data: /, "").trim());
    assert.deepEqual(next.events.map((event: ServerEventEnvelope) => event.sequence), [3]);
  } finally {
    await frames.return(undefined);
  }
});
