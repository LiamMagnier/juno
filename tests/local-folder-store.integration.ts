/** Launched only against the migration gate or CI's disposable shadow database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { createDurableLocalToolStore } from "@/lib/chat/local-folder-store";
import { registerLocalToolCall, waitLocalToolResult } from "@/lib/chat/local-folder-bridge";

if (process.env.ALEVR_DISPOSABLE_LOCAL_TOOL_DB !== "1"
  || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/shadow$/.test(process.env.DATABASE_URL ?? "")
  || process.env.AUTH_SECRET !== "alevr-local-tool-disposable-test-only") {
  throw new Error("Refusing to run outside the migration gate's disposable database");
}
async function main() {
const db = new PrismaClient();
const store = createDurableLocalToolStore(db);
const childInput = process.env.ALEVR_LOCAL_TOOL_CHILD;
if (childInput) {
  try {
    const input = JSON.parse(childInput);
    const action = process.argv.includes("--read") ? await store.read(input) : await store.deliver(input);
    console.log(JSON.stringify(action));
  } finally { await db.$disconnect(); }
} else {
  const userId = `fixture-${randomUUID()}`;
  const generationId = `generation-${randomUUID()}`;
  const identity = (name: string) => ({ callId: `lft_${name}-${randomUUID()}`, userId, generationId });
  const child = async (input: unknown, read = false) => {
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--conditions=react-server", "--import", "tsx", "tests/local-folder-store.integration.ts", ...(read ? ["--read"] : [])],
      { env: { ...process.env, ALEVR_LOCAL_TOOL_CHILD: JSON.stringify(input) } });
    return JSON.parse(stdout.trim());
  };
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@fixture.invalid` } });
    const input = identity("cross-process");
    const result = { outcome: "succeeded" as const, output: "private document fixture only" };
    await registerLocalToolCall({ ...input, store, timeoutMs: 5000 });
    assert.equal(await child({ ...input, result }), "accepted", "a different process accepts the receipt");
    assert.deepEqual(await waitLocalToolResult({ ...input, store }), result);
    const recovered = await child(input, true);
    assert.deepEqual(recovered.result, result, "a fresh process recovers a completed result");
    assert.equal(await store.deliver({ ...input, result }), "accepted");
    assert.equal(await store.deliver({ ...input, result: { ...result, output: "conflict" } }), "unknown");
    assert.equal(await store.deliver({ ...input, userId: "intruder", result }), "unknown");
    assert.equal(await store.deliver({ ...input, generationId: "other-turn", result }), "unknown");
    assert.equal(await store.create({ ...input, status: "pending", expiresAt: Date.now() + 5000 }), false);
    const row = await db.chatLocalToolCall.findUniqueOrThrow({ where: { id: input.callId } });
    assert.ok(row.sealedResult?.startsWith("v1b."));
    assert.ok(!row.sealedResult?.includes(result.output), "document text is never persisted in plaintext");
    await store.end(input, "cancelled");
    assert.deepEqual((await store.read(input))?.result, result, "completed receipt cannot be overwritten by cancellation");

    const race = identity("race");
    await registerLocalToolCall({ ...race, store, timeoutMs: 5000 });
    const answers = await Promise.all([child({ ...race, result }), child({ ...race, result: { ...result, output: "other" } })]);
    assert.deepEqual(answers.sort(), ["accepted", "unknown"], "one conflicting response wins CAS");

    for (const status of ["cancelled", "expired"] as const) {
      const id = identity(status);
      await store.create({ ...id, status: "pending", expiresAt: status === "expired" ? Date.now() - 1 : Date.now() + 5000 });
      await store.end(id, status);
      assert.equal(await child({ ...id, result }), "unknown");
      assert.equal((await waitLocalToolResult({ ...id, store })).outcome, "failed");
    }
    const transplant = identity("transplant");
    await store.create({ ...transplant, status: "pending", expiresAt: Date.now() + 5000 });
    await db.chatLocalToolCall.update({ where: { id: transplant.callId }, data: { status: "completed", sealedResult: row.sealedResult } });
    await assert.rejects(store.read(transplant), "moving ciphertext to another call fails authenticated decryption");
    console.log("Local tool receipt integration passed: separate processes, restart recovery, CAS, duplicate/ownership/expiry/cancel and bound encryption.");
  } finally {
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
}

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
