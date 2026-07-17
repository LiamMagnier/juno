import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { appendRequestSchema, appendTurnCreatedAt, MAX_APPEND_TURNS } from "../src/lib/message-append";

const turn = (overrides: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  role: "USER",
  content: "hello from the app",
  ...overrides,
});

test("append batches require unique clientIds so retries stay idempotent", () => {
  assert.ok(appendRequestSchema.safeParse({ turns: [turn(), turn({ role: "ASSISTANT", model: "anthropic:claude-opus-4-8" })] }).success);

  const clientId = randomUUID();
  const duplicated = appendRequestSchema.safeParse({ turns: [turn({ clientId }), turn({ clientId })] });
  assert.ok(!duplicated.success);
});

test("append turns validate shape: roles, metadata ownership, and bounds", () => {
  // Generation metadata belongs to ASSISTANT turns only.
  assert.ok(!appendRequestSchema.safeParse({ turns: [turn({ model: "anthropic:claude-opus-4-8" })] }).success);
  assert.ok(!appendRequestSchema.safeParse({ turns: [turn({ promptTokens: 12 })] }).success);
  assert.ok(appendRequestSchema.safeParse({ turns: [turn({ role: "ASSISTANT", promptTokens: 12, completionTokens: 40 })] }).success);

  assert.ok(!appendRequestSchema.safeParse({ turns: [] }).success);
  assert.ok(!appendRequestSchema.safeParse({ turns: [turn({ content: "" })] }).success);
  assert.ok(!appendRequestSchema.safeParse({ turns: [turn({ role: "SYSTEM" })] }).success);
  assert.ok(!appendRequestSchema.safeParse({ turns: [turn({ clientId: "short" })] }).success);
  assert.ok(!appendRequestSchema.safeParse({ turns: [turn({ createdAt: "yesterday" })] }).success);
  assert.ok(!appendRequestSchema.safeParse({ turns: Array.from({ length: MAX_APPEND_TURNS + 1 }, () => turn()) }).success);
});

test("turn timestamps honor the client clock but never run ahead of the server", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const past = appendTurnCreatedAt(turn({ createdAt: "2026-07-17T11:00:00.000Z" }) as never, 0, 2, now);
  assert.equal(past.toISOString(), "2026-07-17T11:00:00.000Z");

  const future = appendTurnCreatedAt(turn({ createdAt: "2026-07-18T00:00:00.000Z" }) as never, 0, 2, now);
  assert.equal(future.getTime(), now);

  // Missing timestamps backfill a compact monotonic range ending at now.
  const first = appendTurnCreatedAt(turn() as never, 0, 3, now);
  const second = appendTurnCreatedAt(turn() as never, 1, 3, now);
  const third = appendTurnCreatedAt(turn() as never, 2, 3, now);
  assert.ok(first.getTime() < second.getTime());
  assert.ok(second.getTime() < third.getTime());
  assert.equal(third.getTime(), now);
});
