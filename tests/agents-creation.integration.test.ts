import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createAgentTransaction } from "../src/lib/agents/creation";
import { createAgentSchema, MAX_AGENTS_PER_ACCOUNT } from "../src/lib/agents/domain";
import { decryptField } from "../src/lib/field-crypto";
import { newAgentInput } from "../src/lib/agents/new-agent";

// Explicit opt-in: never connects to, truncates, or modifies a developer/production database.
const url = process.env.JUNO_AGENTS_TEST_DATABASE_URL;
test("atomic creation: concurrent retry, ownership, rollback, encrypted request, and account cap", { skip: !url }, async () => {
  assert.match(url!, /127\.0\.0\.1:65439\/juno_agents_test$/);
  const db = new PrismaClient({ datasourceUrl: url });
  const owners = [`agents-test-${randomUUID()}`, `agents-test-${randomUUID()}`];
  process.env.AUTH_SECRET ??= "juno-agents-isolated-integration-test-key";
  try {
    for (const id of owners) await db.user.create({ data: { id, email: `${id}@example.invalid` } });
    const request = createAgentSchema.parse({ name: "Test teammate", creationKey: randomUUID(), starterMessage: "Keep my private project on track", firstGoal: "Review the project" });
    const create = (owner: string, input = request) => db.$transaction(tx => createAgentTransaction(tx, owner, input, [], null, "claude-opus-4-8"), { timeout: 20000 });
    const results = await Promise.all(Array.from({ length: 6 }, () => create(owners[0])));
    assert.equal(new Set(results.map(a => a?.id)).size, 1, "retries create one agent");
    assert.equal(await db.conversation.count({ where: { userId: owners[0] } }), 1);
    assert.equal(await db.agentGoal.count({ where: { userId: owners[0] } }), 1);
    assert.equal(await db.agentEvent.count({ where: { userId: owners[0], kind: "hired" } }), 1);
    const event = await db.agentEvent.findFirstOrThrow({ where: { userId: owners[0], kind: "hired" } });
    const encrypted = (event.detail as { starterMessage: string }).starterMessage;
    assert.notEqual(encrypted, request.starterMessage);
    assert.match(encrypted, /^enc:/);
    assert.equal(decryptField(encrypted), request.starterMessage);
    assert.notEqual((await create(owners[1]))?.id, results[0]?.id, "keys are scoped to account");
    await assert.rejects(db.$transaction(async tx => {
      await createAgentTransaction(tx, owners[1], { ...request, creationKey: randomUUID() }, [], null, "claude-opus-4-8");
      throw new Error("simulated failure before commit");
    }));
    assert.equal(await db.agent.count({ where: { userId: owners[1] } }), 1);
    assert.equal(await db.conversation.count({ where: { userId: owners[1] } }), 1);
    const hires = await Promise.all(Array.from({ length: MAX_AGENTS_PER_ACCOUNT + 3 }, () => create(owners[0], { ...request, creationKey: randomUUID() })));
    assert.equal(hires.filter(Boolean).length, MAX_AGENTS_PER_ACCOUNT - 1);
    assert.equal(await db.agent.count({ where: { userId: owners[0] } }), MAX_AGENTS_PER_ACCOUNT);
    assert.equal((await create(owners[0]))?.id, results[0]?.id, "retry still works at cap");
  } finally {
    await db.user.deleteMany({ where: { id: { in: owners } } });
    await db.$disconnect();
  }
});

test("Agents home's request creates the agent it showed: face, name, blank brief, first message", { skip: !url }, async () => {
  assert.match(url!, /127\.0\.0\.1:65439\/juno_agents_test$/);
  const db = new PrismaClient({ datasourceUrl: url });
  const owner = `agents-home-${randomUUID()}`;
  process.env.AUTH_SECRET ??= "juno-agents-isolated-integration-test-key";
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
    const avatar = { shape: "petal", tone: "violet", eyes: "wide", mark: "none" } as const;
    const input = createAgentSchema.parse(newAgentInput({ text: "Watch flights to Tokyo in March", name: "Wren", avatar, creationKey: randomUUID() }));
    const agent = await db.$transaction(tx => createAgentTransaction(tx, owner, input, [], null, "claude-opus-4-8"), { timeout: 20000 });
    assert.ok(agent?.conversationId, "it opens straight onto its own thread");
    assert.equal(agent.name, "Wren");
    assert.deepEqual(agent.avatar, avatar);
    assert.equal(agent.instructions, "");
    assert.deepEqual(agent.connectorIds, []);
    const hired = await db.agentEvent.findFirstOrThrow({ where: { userId: owner, agentId: agent.id, kind: "hired" } });
    assert.equal(decryptField((hired.detail as { starterMessage: string }).starterMessage), "Watch flights to Tokyo in March");
  } finally {
    await db.agent.deleteMany({ where: { userId: owner } }).catch(() => {});
    await db.user.deleteMany({ where: { id: owner } }).catch(() => {});
    await db.$disconnect();
  }
});
