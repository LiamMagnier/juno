import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

/*
 * ACCEPTANCE FOR LEDGER P1-1: STOP REACHES A GENERATION IN ANOTHER PROCESS.
 *
 * Two real Node processes, one real Postgres:
 *
 *  - Process A (tests/fixtures/chat-turn-process.ts) runs chat turns through
 *    the real POST /api/chat, with its own generation registry and signal
 *    pump. Only the session, provider configuration, `after()` and the model
 *    are stood in; the model streams a word every 100 ms until aborted.
 *  - Process B is this test. It never holds the generation. It presses Stop
 *    through the real POST /api/chat/cancel — exactly what a second backend
 *    instance, or the replacement process during a reload, would receive.
 *
 * Each case asserts the Stop crossed the process boundary within 3 s (the
 * provider's AbortSignal fired in A, and A's terminal frame was written), and
 * that the turn ended as a USER Stop — partial kept, charge kept, receipt
 * completed — not as the refunded error a bare abort would read as.
 *
 * Skipped unless CROSS_PROCESS_STOP_TEST_DATABASE_URL names a throwaway,
 * migrated local database (it never falls back to DATABASE_URL):
 *   CROSS_PROCESS_STOP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/juno_route_test_xproc \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/chat-cross-process-stop.integration.test.ts
 */

const DB_URL = process.env.CROSS_PROCESS_STOP_TEST_DATABASE_URL;
const STOP_BUDGET_MS = 3_000;

type ChildEvent = { id?: string; event: string; at?: number; [key: string]: unknown };
type Frame = { type: string; finishReason?: string; message?: { content?: string }; receiptState?: string; [key: string]: unknown };

if (!DB_URL) {
  test("cross-process Stop suite is skipped without CROSS_PROCESS_STOP_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(DB_URL, /^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/juno_route_test(?:_[a-z0-9]+)?$/, "only an explicit local disposable database");
  const sharedEnv = {
    DATABASE_URL: DB_URL,
    DIRECT_URL: DB_URL,
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    AUTH_SECRET: process.env.AUTH_SECRET ?? "cross-process-stop-test-secret",
  };
  Object.assign(process.env, sharedEnv);
  delete process.env.DATA_ENCRYPTION_KEYRING;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  let child: ChildProcessWithoutNullStreams;
  const events: ChildEvent[] = [];
  const waiters: Array<{ match: (e: ChildEvent) => boolean; resolve: (e: ChildEvent) => void }> = [];
  const childLog: string[] = [];

  function onEvent(event: ChildEvent) {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.match(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  }

  function waitFor(match: (e: ChildEvent) => boolean, label: string, timeoutMs = 60_000): Promise<ChildEvent> {
    const seen = events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${label}\n--- process A output (tail) ---\n${childLog.slice(-40).join("\n")}`));
      }, timeoutMs);
      waiters.push({
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  const on = (id: string, event: string) => (e: ChildEvent) => e.id === id && e.event === event;

  function startTurn(userId: string, body: Record<string, unknown>): string {
    const id = `turn-${randomUUID()}`;
    child.stdin.write(`${JSON.stringify({ id, userId, body })}\n`);
    return id;
  }

  async function pressStopFromProcessB(generationId: string) {
    const route = await import("@/app/api/chat/cancel/route");
    const sentAt = Date.now();
    const res = await route.POST(
      new Request("http://juno.test/api/chat/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generationId }),
      })
    );
    return { sentAt, status: res.status, body: (await res.json()) as { ok: boolean; cancelled: boolean; delivery: string } };
  }

  async function seedUser() {
    const user = await prisma.user.create({
      data: { email: `xproc-${randomUUID()}@example.invalid`, name: "Cross-process tester", emailVerified: new Date() },
    });
    await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  async function waitForNoLease(userId: string) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const leases = await prisma.rateLimit.count({ where: { key: { startsWith: `generation:live:${userId}:` } } });
      if (leases === 0 || Date.now() > deadline) return leases;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  test("process A starts and is a separate process", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/chat-turn-process.ts", import.meta.url));
    child = spawn(process.execPath, ["--import", "tsx", "--experimental-test-module-mocks", "--conditions=react-server", fixture], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ...sharedEnv, NODE_OPTIONS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        if (line.startsWith("@@xproc ")) onEvent(JSON.parse(line.slice("@@xproc ".length)) as ChildEvent);
        else childLog.push(line);
      });
    }
    child.on("exit", (code) => onEvent({ event: "child-exit", code }));
    const ready = await waitFor((e) => e.event === "ready", "process A to boot", 120_000);
    assert.notEqual(ready.pid, process.pid);
  });

  test("a turn WITHOUT a first-submission receipt is stopped from process B within 3 s, as a user Stop", async () => {
    const user = await seedUser();
    const id = startTurn(user.id, { message: "Write a long essay." });
    const meta = await waitFor(on(id, "meta"), "the turn's meta frame");
    const generationId = meta.generationId as string;
    await waitFor((e) => e.id === id && e.event === "delta" && (e.deltas as number) >= 3, "A to be streaming");

    // No receipt: the only durable path is the cancel row.
    assert.equal(await prisma.chatFirstSubmissionReceipt.count({ where: { generationId } }), 0);

    const stop = await pressStopFromProcessB(generationId);
    assert.equal(stop.status, 200);
    assert.deepEqual(stop.body, { ok: true, cancelled: true, delivery: "remote" }, "B knew A holds it (live lease) and recorded the Stop");

    const aborted = await waitFor(on(id, "provider-aborted"), "A's provider call to be aborted", 10_000);
    const terminal = await waitFor(on(id, "terminal"), "A's terminal frame", 10_000);
    const abortMs = (aborted.at as number) - stop.sentAt;
    const terminalMs = (terminal.at as number) - stop.sentAt;
    assert.ok(abortMs < STOP_BUDGET_MS, `provider aborted ${abortMs} ms after Stop (budget ${STOP_BUDGET_MS})`);
    assert.ok(terminalMs < STOP_BUDGET_MS, `terminal frame ${terminalMs} ms after Stop (budget ${STOP_BUDGET_MS})`);
    console.info(`[xproc] no-receipt turn: provider aborted after ${abortMs} ms, terminal frame after ${terminalMs} ms`);

    const frame = terminal.frame as Frame;
    assert.equal(frame.type, "done");
    assert.equal(frame.finishReason, "user_stopped", "a Stop from another process is the user's Stop, not an error");
    const partial = frame.message?.content ?? "";
    assert.match(partial, /^word0 word1 word2 /, "the partial answer is kept");
    assert.doesNotMatch(partial, /word299/, "the answer did not run to the end");

    await waitFor(on(id, "settled"), "A to settle");
    const conversationId = meta.conversationId as string;
    const assistant = await prisma.message.findFirst({ where: { conversationId, role: "ASSISTANT" } });
    assert.ok(assistant, "the partial answer was persisted");
    const { decryptMessageTextSafe } = await import("@/lib/message-crypto");
    assert.equal(decryptMessageTextSafe(assistant.content), partial);
    const usage = await prisma.usage.findFirst({ where: { userId: user.id } });
    assert.equal(usage?.messageCount, 1, "a Stop is not refunded");
    assert.equal(await prisma.spendReservation.count({ where: { userId: user.id, state: "open" } }), 0, "no hold left open");
    assert.equal(await waitForNoLease(user.id), 0, "A released the live lease when the turn ended");
    const signal = await prisma.rateLimit.findUnique({ where: { key: `generation:cancel:${user.id}:${generationId}` } });
    assert.equal(signal?.count, 1, "one durable cancel row");
  });

  test("a receipt-backed turn is stopped from process B within 3 s and its receipt completes as stopped", async () => {
    const user = await seedUser();
    const id = startTurn(user.id, {
      message: "Write a long essay.",
      clientRequestId: `req-${randomUUID()}`,
      clientMessageId: `msg-${randomUUID()}`,
    });
    const meta = await waitFor(on(id, "meta"), "the turn's meta frame");
    const generationId = meta.generationId as string;
    await waitFor((e) => e.id === id && e.event === "delta" && (e.deltas as number) >= 3, "A to be streaming");
    assert.equal((await prisma.chatFirstSubmissionReceipt.findFirst({ where: { generationId } }))?.state, "running");

    const stop = await pressStopFromProcessB(generationId);
    assert.deepEqual(stop.body, { ok: true, cancelled: true, delivery: "remote" });
    const terminal = await waitFor(on(id, "terminal"), "A's terminal frame", 10_000);
    const terminalMs = (terminal.at as number) - stop.sentAt;
    assert.ok(terminalMs < STOP_BUDGET_MS, `terminal frame ${terminalMs} ms after Stop`);
    console.info(`[xproc] receipt-backed turn: terminal frame after ${terminalMs} ms`);
    assert.equal((terminal.frame as Frame).finishReason, "user_stopped");

    await waitFor(on(id, "settled"), "A to settle");
    const receipt = await prisma.chatFirstSubmissionReceipt.findFirst({ where: { generationId } });
    assert.equal(receipt?.state, "completed");
    assert.equal(receipt?.finishReason, "user_stopped");
    assert.ok(receipt?.cancelRequestedAt, "the receipt flag was written too");
  });

  test("a Stop pressed before the turn registered stops it as soon as it does (client-chosen generation id)", async () => {
    const user = await seedUser();
    const generationId = `gen-${randomUUID()}`;
    const stop = await pressStopFromProcessB(generationId);
    assert.deepEqual(stop.body, { ok: true, cancelled: false, delivery: "queued" }, "nobody holds it yet: recorded, not claimed");

    const id = startTurn(user.id, { message: "Write a long essay.", generationId });
    const meta = await waitFor(on(id, "meta"), "the turn's meta frame");
    assert.equal(meta.generationId, generationId);
    const terminal = await waitFor(on(id, "terminal"), "A's terminal frame", 10_000);
    const sinceRegistered = (terminal.at as number) - (meta.at as number);
    assert.ok(sinceRegistered < STOP_BUDGET_MS, `stopped ${sinceRegistered} ms after the turn registered`);
    assert.equal((terminal.frame as Frame).finishReason, "user_stopped");
    assert.ok((terminal.deltas as number) < 30, "the answer was cut short");
    await waitFor(on(id, "settled"), "A to settle");
  });

  test("a Stop pressed before a durable first submission registered stops it too: its receipt takes the caller's id", async () => {
    // The web sends durable first-submission keys on a new chat's first
    // message (src/lib/chat/send-retry.ts). Before the receipt took the
    // caller's generation id, a Stop pressed in admission was recorded under
    // an id the turn never registered with, and the turn ran on.
    const user = await seedUser();
    const generationId = `gen-${randomUUID()}`;
    const stop = await pressStopFromProcessB(generationId);
    assert.deepEqual(stop.body, { ok: true, cancelled: false, delivery: "queued" }, "nobody holds it yet: recorded, not claimed");

    const id = startTurn(user.id, {
      message: "Write a long essay.",
      generationId,
      clientRequestId: `req-${randomUUID()}`,
      clientMessageId: `msg-${randomUUID()}`,
    });
    const meta = await waitFor(on(id, "meta"), "the turn's meta frame");
    assert.equal(meta.generationId, generationId, "the receipt generates under the caller's id");
    const terminal = await waitFor(on(id, "terminal"), "A's terminal frame", 10_000);
    const sinceRegistered = (terminal.at as number) - (meta.at as number);
    assert.ok(sinceRegistered < STOP_BUDGET_MS, `stopped ${sinceRegistered} ms after the turn registered`);
    assert.equal((terminal.frame as Frame).finishReason, "user_stopped");
    assert.ok((terminal.deltas as number) < 30, "the answer was cut short");
    await waitFor(on(id, "settled"), "A to settle");
    const receipt = await prisma.chatFirstSubmissionReceipt.findFirst({ where: { generationId } });
    assert.ok(receipt, "the receipt is the caller's generation");
    assert.notEqual(receipt.state, "running", "and it is settled, not left running");
  });

  test("a private turn (no live lease, nothing written on its own) is still stopped from process B within 3 s", async () => {
    const user = await seedUser();
    const generationId = `gen-${randomUUID()}`;
    const id = startTurn(user.id, {
      privateMode: true,
      message: "psst",
      privateHistory: [{ role: "USER", content: "psst" }],
      generationId,
    });
    await waitFor((e) => e.id === id && e.event === "delta" && (e.deltas as number) >= 3, "A to be streaming");
    assert.equal(
      await prisma.rateLimit.count({ where: { key: { startsWith: `generation:live:${user.id}:` } } }),
      0,
      "a private turn takes no lease"
    );

    const stop = await pressStopFromProcessB(generationId);
    assert.equal(stop.body.delivery, "queued", "B cannot see a private turn; it records the Stop anyway");
    const terminal = await waitFor(on(id, "terminal"), "A's terminal frame", 10_000);
    const terminalMs = (terminal.at as number) - stop.sentAt;
    assert.ok(terminalMs < STOP_BUDGET_MS, `terminal frame ${terminalMs} ms after Stop`);
    assert.equal((terminal.frame as Frame).finishReason, "user_stopped");
    await waitFor(on(id, "settled"), "A to settle");
  });

  test("another account's Stop for the same generation id does nothing", async () => {
    const owner = await seedUser();
    const id = startTurn(owner.id, { message: "Write a long essay." });
    const meta = await waitFor(on(id, "meta"), "the turn's meta frame");
    await waitFor((e) => e.id === id && e.event === "delta" && (e.deltas as number) >= 3, "A to be streaming");

    await seedUser(); // signs B in as someone else
    const stop = await pressStopFromProcessB(meta.generationId as string);
    assert.deepEqual(stop.body, { ok: true, cancelled: false, delivery: "queued" }, "the intruder cannot see the owner's lease");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(events.some(on(id, "terminal")), false, "still streaming after more than two polls");

    signedIn = { id: owner.id, email: owner.email!, name: owner.name! };
    const ownerStop = await pressStopFromProcessB(meta.generationId as string);
    assert.equal(ownerStop.body.cancelled, true);
    const terminal = await waitFor(on(id, "terminal"), "A's terminal frame", 10_000);
    assert.equal((terminal.frame as Frame).finishReason, "user_stopped");
    await waitFor(on(id, "settled"), "A to settle");
  });

  test("a resume served by process B tails a turn streaming in process A to its terminal frame (live lease)", async () => {
    const user = await seedUser();
    const id = startTurn(user.id, { message: "Write a long essay." });
    const meta = await waitFor(on(id, "meta"), "the turn's meta frame");
    const generationId = meta.generationId as string;
    // Past the stream log's first flush (250 ms), so the logged meta frame —
    // the ownership proof for a turn without a receipt — is in the database.
    await waitFor((e) => e.id === id && e.event === "delta" && (e.deltas as number) >= 6, "A to be streaming");

    // B reconnects the dropped stream. B does not hold the generation and
    // there is no receipt: before the live lease, B called the turn over and
    // ended the tail with `refetch` after the 3 s terminal grace.
    const resumeRoute = await import("@/app/api/chat/stream/[generationId]/route");
    const abort = new AbortController();
    const res = await resumeRoute.GET(
      new Request(`http://juno.test/api/chat/stream/${generationId}?after=0`, { signal: abort.signal }),
      { params: Promise.resolve({ generationId }) }
    );
    if (res.status !== 200) await pressStopFromProcessB(generationId); // do not leave A streaming
    assert.equal(res.status, 200);
    const frames: Frame[] = [];
    let ended = false;
    const reading = (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Frame);
      }
      ended = true;
    })();

    await new Promise((resolve) => setTimeout(resolve, 4_500));
    const endedEarly = ended;
    const refetched = frames.some((f) => f.type === "resume");
    const deltasSoFar = frames.filter((f) => f.type === "delta").length;
    await pressStopFromProcessB(generationId);
    assert.equal(endedEarly, false, "still tailing past the 3 s terminal grace: B knows A holds the turn");
    assert.equal(refetched, false, "no refetch while A is generating");
    assert.ok(deltasSoFar >= 20, `B replayed and tailed A's frames (${deltasSoFar} deltas)`);

    await Promise.race([reading, new Promise((_, reject) => setTimeout(() => reject(new Error("resume did not end")), 10_000))]);
    const last = frames.at(-1)!;
    assert.equal(last.type, "done", "the tail ended on A's terminal frame, not a refetch");
    assert.equal(last.finishReason, "user_stopped");
    await waitFor(on(id, "settled"), "A to settle");
  });

  test("process A exits cleanly", async () => {
    child.stdin.end();
    const exit = await waitFor((e) => e.event === "child-exit", "process A to exit", 30_000);
    assert.equal(exit.code, 0);
    assert.equal(events.filter((e) => e.event === "crashed").length, 0, "no turn crashed in process A");
  });

  test("disconnect", async () => {
    const { prismaUnguarded } = await import("@/lib/prisma");
    await prismaUnguarded.$disconnect();
    await prisma.$disconnect();
  });
}
