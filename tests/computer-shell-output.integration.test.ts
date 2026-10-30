/**
 * Streamed shell output on a real Postgres (src/lib/computer/shell-output.ts,
 * the Prisma persistence; docs/design/agents-v2/COMPUTERS_2026-10.md S5.1 and
 * §4.1, migration 20261030100000_computer_shell_output). Opt-in, like the other
 * computer database tests:
 *
 *   COMPUTER_TEST_DATABASE_URL=postgresql://…/juno_computer_test \
 *     NODE_OPTIONS=--conditions=react-server npx tsx --test tests/computer-shell-output.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.COMPUTER_TEST_DATABASE_URL;

test("rows are stored encrypted, in seq order per run, read back only by their owner, and go with the run", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z0-9_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "computer-shell-output-integration-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const shell = await import("../src/lib/computer/shell-output");
  const userId = `shell_${randomUUID()}`;
  const otherId = `shell_${randomUUID()}`;
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    await db.user.create({ data: { id: otherId, email: `${otherId}@example.invalid` } });
    const session = await db.workSession.create({ data: { userId, title: "Primes", goal: "Write primes.csv" } });
    const run = await db.workRun.create({ data: { userId, sessionId: session.id, attempt: 1, status: "running" } });

    // Two logs for one run (a runner restart): seq keeps counting from the database.
    const first = shell.createShellOutputLog({ userId, agentId: "agent_1", runId: run.id, flushMs: 10 });
    const call = first.call("call_1", "python3 -c 'print(1)'");
    call.append({ stream: "stdout", text: "1\n" });
    call.append({ stream: "stderr", text: "warn €\n" });
    await call.end({ exitCode: 0, timedOut: false });
    const second = shell.createShellOutputLog({ userId, agentId: "agent_1", runId: run.id, flushMs: 10 });
    const next = second.call("call_2", "ls");
    next.append({ stream: "stdout", text: "primes.csv\n" });
    await next.end({ exitCode: 0, timedOut: false });

    const stored = await db.computerShellOutput.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    assert.deepEqual(stored.map((row) => row.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(stored.map((row) => row.stream), ["command", "stdout", "stderr", "exit", "command", "stdout", "exit"]);
    for (const row of stored) {
      assert.equal(row.text.includes("primes") || row.text.includes("python3") || row.text.includes("warn"), false, "encrypted at rest");
    }

    const page = await shell.readShellOutput({ userId, agentId: "agent_1", runId: run.id, afterSeq: 2 });
    assert.deepEqual(page.rows.map((row) => [row.seq, row.stream, row.text]), [
      [3, "stderr", "warn €\n"],
      [4, "exit", JSON.stringify({ exitCode: 0, timedOut: false, capped: false })],
      [5, "command", "ls"],
      [6, "stdout", "primes.csv\n"],
      [7, "exit", JSON.stringify({ exitCode: 0, timedOut: false, capped: false })],
    ]);
    assert.equal(page.next, 7);
    assert.equal((await shell.readShellOutput({ userId: otherId, agentId: "agent_1", runId: run.id, afterSeq: 0 })).rows.length, 0, "not another account's");
    assert.equal((await shell.readShellOutput({ userId, agentId: "agent_2", runId: run.id, afterSeq: 0 })).rows.length, 0, "not another agent's");

    // The rows live as long as the run.
    await db.workRun.delete({ where: { id: run.id } });
    assert.equal(await db.computerShellOutput.count({ where: { runId: run.id } }), 0);
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.user.delete({ where: { id: otherId } }).catch(() => undefined);
    await db.$disconnect();
  }
});
