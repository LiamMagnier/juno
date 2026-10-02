import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_COLUMN, whereHasOwner } from "@/lib/db";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { pendingApprovalWhere } from "@/lib/work/domain";
import { SCOPING_HELPERS, scanOwnershipCallSites, type CallSite } from "../scripts/ownership-callsites";

/*
 * The ownership guard (src/lib/db.ts) throws in every environment. On
 * 2026-10-01 it started doing so in production without anyone listing the call
 * sites that were still unscoped, and project chats, project edit/delete, the
 * member list, iPhone-to-Mac commands, roadmap votes, the admin users page,
 * Composio state changes and memory extraction all failed in production.
 *
 * This is the gate that would have caught it: every guarded Prisma call in
 * src/ and scripts/ is found statically and its `where` judged the way the
 * guard judges it. A literal without the owner column fails here, not in
 * production. A `where` the scanner cannot see into has to be listed below with
 * the reason it is safe, and the list cannot go stale.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Call sites whose `where` is built somewhere the scanner cannot follow, or is
 * unscoped on a client the scanner cannot classify. Keyed by file, model.op and
 * the where text, so changing the where makes it a new decision.
 */
const REVIEWED: Record<string, string> = {
  "src/app/api/admin/users/route.ts|Usage.findMany|{ userId: { in: ids }, period }":
    "ids is a page of users; the route skips the query when it is empty (the guard refuses an empty `in`).",
  "src/app/api/admin/users/route.ts|ApiSpend.groupBy|{ userId: { in: ids }, createdAt: { gte: monthStart } }":
    "Same non-empty page of user ids as above.",
  "src/app/api/admin/users/route.ts|ModerationFlag.groupBy|{ userId: { in: ids } }":
    "Same non-empty page of user ids as above.",
  "src/lib/share.ts|Share.findFirst|{ ...where, takenDownAt: { not: null } }":
    "`where` is typed `{ userId: string; ... }` by assertNotTakenDown's signature.",
  "src/lib/work/store.ts|WorkRun.findMany|{ status: { in: [...WORK_LEASED_STATUSES] }, leaseExpiresAt: { lt: now }, ...(input.userId ? { userId: input.userId } : {}), }":
    "Guarded branch runs only when input.userId is set; the cross-account sweep uses prismaUnguarded.",
  "src/lib/artifact-trash.ts|Artifact.deleteMany|ownerId ? { id: { in: group }, userId: ownerId } : { id: { in: group }, userId: null }":
    "The guarded caller (purgeTrashedArtifact) always passes userId, so every locked row has that owner; the null branch is the unguarded sweep's.",
  "src/lib/artifact-writes.ts|Artifact.update|{ id: locked.id, ...(locked.userId ? { userId: locked.userId } : {}) }":
    "Guarded callers lock with their userId, so locked.userId is set; ownerless legacy rows only reach here through prismaUnguarded.",
  "src/lib/artifact-writes.ts|ArtifactPublication.updateMany|{ artifactId: locked.id, ...(locked.userId ? { userId: locked.userId } : {}), retiredAt: null, publishedAt: { not: null }, pinnedVersion: null, }":
    "As above: locked.userId is the caller's userId on every guarded path.",
  "src/lib/artifact-writes.ts|ArtifactDraft.findFirst|{ artifactId: locked.id, ...(locked.userId ? { userId: locked.userId } : {}) }":
    "As above.",
  "scripts/encrypt-columns.ts|MemorySummary.findMany|pageArgs(cursor, take, { id: true, content: true })":
    "The backfill is handed prismaUnguarded (main) on purpose: it walks every account.",
  "scripts/encrypt-columns.ts|MemorySummary.update|{ id }": "Same unguarded backfill client.",
  "scripts/encrypt-columns.ts|ScheduledTask.findMany|pageArgs(cursor, take, { id: true, prompt: true })":
    "Same unguarded backfill client.",
  "scripts/encrypt-columns.ts|ScheduledTask.update|{ id }": "Same unguarded backfill client.",
  "src/lib/research/completion.ts|Conversation.updateMany|{ id: conversationId }":
    "Called only inside touchConversation, which is invoked after conversationExists has already " +
    "verified ownership of that id in the same transaction.",
};

const sites = scanOwnershipCallSites(ROOT, OWNER_COLUMN);

function describe(site: CallSite): string {
  return `${site.file}:${site.line} ${site.model}.${site.operation} (${site.receiver}, ${site.verdict})\n    ${site.snippet}`;
}

test("the scanner finds the guarded call sites at all", () => {
  // Vacuity check: if the scan collapses, every assertion below passes.
  assert.ok(sites.length > 1000, `expected over a thousand guarded call sites, found ${sites.length}`);
  assert.ok(sites.some((site) => site.file === "src/app/api/chat/route.ts" && site.model === "Project"));
});

test("no guarded Prisma call reaches the ownership guard without an owner filter", () => {
  const unscoped = sites.filter((site) => site.receiver === "guarded" && site.verdict === "unscoped");
  assert.deepEqual(
    unscoped.map(describe),
    [],
    "These calls throw [ownership-guard] in production. Scope them to the owner, or use prismaUnguarded " +
      "where the read is deliberately cross-account (after an access check), and say why at the call site."
  );
});

test("every call site the scanner cannot judge has been reviewed", () => {
  const undecided = sites.filter(
    (site) => site.verdict !== "scoped" && !(site.receiver === "guarded" && site.verdict === "unscoped") && !REVIEWED[site.key]
  );
  assert.deepEqual(
    undecided.map((site) => `${describe(site)}\n    key: ${site.key}`),
    [],
    "Add the key to REVIEWED with the reason the where is always owner-scoped at runtime, or make the scope visible."
  );
});

test("the reviewed list has no stale entries", () => {
  const keys = new Set(sites.map((site) => site.key));
  assert.deepEqual(Object.keys(REVIEWED).filter((key) => !keys.has(key)), []);
});

test("every scoping helper the scanner trusts really scopes to its owner", () => {
  assert.deepEqual([...SCOPING_HELPERS].sort(), ["ownedArtifactWhere", "pendingApprovalWhere"]);
  assert.equal(whereHasOwner(ownedArtifactWhere("alice"), "userId"), true);
  assert.equal(whereHasOwner(ownedArtifactWhere("alice", { id: "a" }, { trashed: true }), "userId"), true);
  // The helper's owner wins over anything the caller passes in `extra`.
  assert.deepEqual(ownedArtifactWhere("alice", { userId: "mallory" } as never).userId, "alice");
  assert.equal(whereHasOwner(pendingApprovalWhere("run", "alice", new Date()), "userId"), true);
});

test("the scanner flags the shapes that broke production and accepts the fixes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "juno-ownership-scan-"));
  try {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(
      path.join(dir, "src", "fixture.ts"),
      `import { prisma, prismaUnguarded } from "@/lib/prisma";
       export async function f(id: string, userId: string, conversation: { projectId: string; userId: string }) {
         await prisma.project.findUnique({ where: { id: conversation.projectId } });
         await prisma.project.findUnique({ where: { id: conversation.projectId, userId: conversation.userId } });
         await prisma.featureVote.count({ where: { requestId: id } });
         await prismaUnguarded.featureVote.count({ where: { requestId: id } });
         await prisma.codeRemoteSession.findUnique({ where: { deviceId_sessionId: { deviceId: id, sessionId: id } } });
         await prisma.$transaction(async (tx) => tx.projectMember.findMany({ where: { projectId: id } }));
         await prismaUnguarded.$transaction(async (tx) => tx.projectMember.findMany({ where: { projectId: id } }));
         const where = { userId, id };
         await prisma.conversation.findFirst({ where });
         await prisma.conversation.findMany({ where: { OR: [{ userId }, { id }] } });
         await prisma.conversation.findMany({ where: { userId: undefined } });
         await prisma.usage.count();
         const { prisma: lazy } = await import("@/lib/prisma");
         await lazy.conversationMemory.upsert({ where: { conversationId: id }, create: {}, update: {} } as never);
       }`
    );
    const found = scanOwnershipCallSites(dir, OWNER_COLUMN, ["src"]);
    const verdicts = found.map((site) => `${site.model}.${site.operation}:${site.receiver}:${site.verdict}`);
    assert.deepEqual(verdicts, [
      "Project.findUnique:guarded:unscoped",
      "Project.findUnique:guarded:scoped",
      "FeatureVote.count:guarded:unscoped",
      "CodeRemoteSession.findUnique:guarded:unscoped",
      "ProjectMember.findMany:guarded:unscoped",
      "Conversation.findFirst:guarded:scoped",
      "Conversation.findMany:guarded:unscoped",
      "Conversation.findMany:guarded:unscoped",
      "Usage.count:guarded:unscoped",
      "ConversationMemory.upsert:guarded:unscoped",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
