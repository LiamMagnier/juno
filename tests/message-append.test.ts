import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { appendRequestSchema, appendTurnCreatedAt, MAX_APPEND_TURNS, MAX_ATTACHMENTS_PER_TURN } from "../src/lib/message-append";

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

/*
 * Attachments on an appended turn.
 *
 * The native composer uploads each file first and sends the returned ids with
 * the turn. `/api/chat` claims attachments for the web, but it creates the user
 * message itself — the native flow appends through this route instead, so
 * without a claim here native uploads would succeed and then attach to nothing.
 */
describe("appendRequestSchema — attachments", () => {
  const validTurn = {
    clientId: "client-abcdefgh",
    role: "USER" as const,
    content: "Look at this",
  };
  const attachmentId = "cmrqlaev0000abcdefghijkl";

  it("accepts attachment ids on a USER turn", () => {
    const parsed = appendRequestSchema.safeParse({
      turns: [{ ...validTurn, attachmentIds: [attachmentId] }],
    });
    assert.equal(parsed.success, true);
  });

  it("accepts a turn with no attachments at all", () => {
    assert.equal(appendRequestSchema.safeParse({ turns: [validTurn] }).success, true);
  });

  /*
   * Only a person attaches files. An ASSISTANT turn claiming attachments is
   * either a client bug or an attempt to bind someone's upload to generated
   * content, and neither should pass quietly.
   */
  it("refuses attachments on an ASSISTANT turn", () => {
    const parsed = appendRequestSchema.safeParse({
      turns: [{
        clientId: "client-abcdefgh",
        role: "ASSISTANT",
        content: "Here you go",
        attachmentIds: [attachmentId],
      }],
    });
    assert.equal(parsed.success, false);
  });

  /* A non-cuid id cannot address a row, so it is rejected before it reaches SQL. */
  it("refuses ids that are not cuids", () => {
    for (const bad of ["../../etc", "'; DROP TABLE", "", "not-a-cuid"]) {
      const parsed = appendRequestSchema.safeParse({
        turns: [{ ...validTurn, attachmentIds: [bad] }],
      });
      assert.equal(parsed.success, false, `${bad} must be refused`);
    }
  });

  it("enforces the per-turn ceiling", () => {
    const parsed = appendRequestSchema.safeParse({
      turns: [{
        ...validTurn,
        attachmentIds: Array.from(
          { length: MAX_ATTACHMENTS_PER_TURN + 1 },
          (_, i) => `cmrqlaev0000abcdefghij${String(i).padStart(2, "0")}`,
        ),
      }],
    });
    assert.equal(parsed.success, false);
  });
});
