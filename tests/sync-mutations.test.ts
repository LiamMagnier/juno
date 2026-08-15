import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mutationOperationSchema, mutationRequestSchema } from "../src/lib/sync-mutations";

test("mutation union accepts the folder lifecycle and conversation.archive", () => {
  assert.ok(mutationOperationSchema.safeParse({ type: "folder.create", name: "Research" }).success);
  assert.ok(mutationOperationSchema.safeParse({ type: "folder.create", clientEntityId: randomUUID(), name: "Research" }).success);
  assert.ok(mutationOperationSchema.safeParse({ type: "folder.rename", entityId: "f1", name: "Archive" }).success);
  assert.ok(mutationOperationSchema.safeParse({ type: "folder.delete", entityId: "f1" }).success);

  const archive = mutationOperationSchema.safeParse({ type: "conversation.archive", entityId: "c1" });
  assert.ok(archive.success);
  // Omitted flag means "archive"; unarchive is the explicit false.
  assert.equal(archive.data.type === "conversation.archive" && archive.data.archived, true);
  assert.ok(mutationOperationSchema.safeParse({ type: "conversation.archive", entityId: "c1", archived: false }).success);

  assert.ok(!mutationOperationSchema.safeParse({ type: "folder.create", name: "" }).success);
  assert.ok(!mutationOperationSchema.safeParse({ type: "folder.rename", entityId: "f1" }).success);
  assert.ok(!mutationOperationSchema.safeParse({ type: "folder.explode", entityId: "f1" }).success);
});

test("conversation.create carries kind, model, and projectId; strict shapes reject drift", () => {
  const full = mutationOperationSchema.safeParse({
    type: "conversation.create",
    clientEntityId: randomUUID(),
    title: "Ship the sync milestone",
    kind: "code",
    model: "anthropic:claude-opus-4-8",
    projectId: "p1",
  });
  assert.ok(full.success);
  assert.ok(mutationOperationSchema.safeParse({ type: "conversation.create" }).success);
  assert.ok(!mutationOperationSchema.safeParse({ type: "conversation.create", kind: "voice" }).success);
  assert.ok(!mutationOperationSchema.safeParse({ type: "conversation.create", surprise: true }).success);
  assert.ok(mutationOperationSchema.safeParse({
    type: "conversation.update",
    entityId: "c1",
    patch: { model: "anthropic:claude-opus-4-8", pinned: true },
  }).success);
  assert.ok(!mutationOperationSchema.safeParse({
    type: "conversation.update",
    entityId: "c1",
    patch: { model: "" },
  }).success);
});

test("settings.update accepts the email preference fields the web settings API supports", () => {
  assert.ok(
    mutationOperationSchema.safeParse({
      type: "settings.update",
      patch: { emailBudgetAlerts: false, emailWeeklyDigest: true },
    }).success,
  );
  assert.ok(!mutationOperationSchema.safeParse({ type: "settings.update", patch: { emailBudgetAlerts: "yes" } }).success);
});

test("project.update accepts a typed favorite and rejects malformed values", () => {
  assert.ok(mutationOperationSchema.safeParse({
    type: "project.update",
    entityId: "project-1",
    starred: true,
  }).success);
  assert.ok(!mutationOperationSchema.safeParse({
    type: "project.update",
    entityId: "project-1",
    starred: "yes",
  }).success);
});

test("project_workspace.upsert is keyed by project and carries a whole config", () => {
  assert.ok(mutationOperationSchema.safeParse({
    type: "project_workspace.upsert",
    projectId: "project-1",
    config: { personaName: "Release captain", allowedTools: ["webSearch", "canvas"] },
  }).success);
  // An empty config is a legitimate reset: it says "no opinion about anything".
  assert.ok(mutationOperationSchema.safeParse({
    type: "project_workspace.upsert", projectId: "project-1", config: {},
  }).success);
  assert.ok(mutationOperationSchema.safeParse({ type: "project_workspace.delete", entityId: "w1" }).success);

  // Strictness matters more here than elsewhere: a misspelled key in a tool
  // whitelist that were accepted silently would store a restriction nothing
  // enforces, and the user would believe the assistant was locked down.
  assert.ok(!mutationOperationSchema.safeParse({
    type: "project_workspace.upsert", projectId: "p1", config: { allowedTool: ["webSearch"] },
  }).success);
  assert.ok(!mutationOperationSchema.safeParse({
    type: "project_workspace.upsert", projectId: "p1", config: { allowedTools: ["timeTravel"] },
  }).success);
  assert.ok(!mutationOperationSchema.safeParse({ type: "project_workspace.upsert", config: {} }).success);
});

test("an empty tool whitelist survives the mutation schema as an empty array", () => {
  // The op that locks an assistant out of every tool and the op that leaves it
  // inheriting the account's must not arrive as the same request. `[]` is the
  // first; an omitted key is the second.
  const restricted = mutationOperationSchema.safeParse({
    type: "project_workspace.upsert", projectId: "p1", config: { allowedTools: [] },
  });
  assert.ok(restricted.success);
  assert.ok(
    restricted.data.type === "project_workspace.upsert" &&
      Array.isArray(restricted.data.config.allowedTools) &&
      restricted.data.config.allowedTools.length === 0
  );

  const inherits = mutationOperationSchema.safeParse({
    type: "project_workspace.upsert", projectId: "p1", config: {},
  });
  assert.ok(inherits.success);
  assert.ok(
    inherits.data.type === "project_workspace.upsert" &&
      inherits.data.config.allowedTools === undefined,
    "no default may be manufactured for a key nobody set"
  );
});

test("mutation request keeps idempotency envelope requirements", () => {
  const valid = {
    clientMutationId: randomUUID(),
    baseRevision: 0,
    operation: { type: "folder.create", name: "Inbox" },
  };
  assert.ok(mutationRequestSchema.safeParse(valid).success);
  assert.ok(!mutationRequestSchema.safeParse({ ...valid, clientMutationId: "not-a-uuid" }).success);
  assert.ok(!mutationRequestSchema.safeParse({ ...valid, baseRevision: -1 }).success);
});
