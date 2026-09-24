/**
 * Artifacts R1, the data model and the contracts every other slice codes
 * against (04-MERGE-PLAN §2.6, §3.5).
 *
 * Three groups:
 *
 *   1. The migration, read as text. It must stay additive (no DROP COLUMN,
 *      DROP TABLE, ALTER COLUMN, CHECK or partial index — the last two because
 *      Prisma cannot declare them, so CI's blocking drift check would fail),
 *      and both conversation triggers must carry the WHEN clause that keeps
 *      the account anchor out of the change feed. A trigger without it would
 *      sync "Your artifacts" to every installed Mac and iPhone as a chat.
 *   2. The schema, read as text: the new fields exist with the nullability and
 *      delete behaviour the migration gives them.
 *   3. The pure helpers: visibility, effective project, flags; and the
 *      serializer's "only when set" rule, which keeps sync payloads unchanged.
 *
 * No database. `npm test` runs this directory without the react-server
 * condition, so the serializer group (serializers.ts is `server-only`) skips
 * there and runs under:
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/artifact-r1-schema.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Artifact, ArtifactVersion, Prisma } from "@prisma/client";
import {
  ANCHOR_KIND,
  ANCHOR_TITLE,
  anchorConversationId,
  visibleConversationSql,
  visibleConversationWhere,
} from "@/lib/conversation-visibility";
import { artifactProjectSql, artifactProjectWhere, effectiveArtifactProjectId } from "@/lib/artifact-scope";
import {
  artifactPurgeArmed,
  artifactTrashEnabled,
  detachOnDeleteEnabled,
  reemitGuardEnabled,
} from "@/lib/artifact-flags";

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "prisma/migrations");

function source(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * Found by suffix, not by timestamp: the release rule is to rename this
 * migration's timestamp if another lands on main first, and the test should
 * not have to follow.
 */
function r1MigrationDir(): string {
  const dirs = readdirSync(MIGRATIONS).filter((d) => d.endsWith("_artifact_lifecycle_r1"));
  assert.equal(dirs.length, 1, `exactly one *_artifact_lifecycle_r1 migration, found ${dirs.length}`);
  return dirs[0];
}

/**
 * The SQL with comments removed and whitespace flattened, as deploy.yml's
 * CONCURRENTLY gate reads it: the header explains in prose why there is no
 * CHECK and no partial index, and those words must not trip the checks below.
 */
function executableSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function statements(sql: string): string[] {
  return executableSql(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const r1Sql = () => source(`prisma/migrations/${r1MigrationDir()}/migration.sql`);

// ----------------------------------------------------------------------------
// 1. The migration
// ----------------------------------------------------------------------------

test("the R1 migration is additive: no dropped or altered column, table, constraint or index", () => {
  const sql = executableSql(r1Sql());
  for (const [label, pattern] of [
    ["DROP COLUMN", /\bDROP\s+COLUMN\b/i],
    ["DROP TABLE", /\bDROP\s+TABLE\b/i],
    ["ALTER COLUMN", /\bALTER\s+COLUMN\b/i],
    ["DROP CONSTRAINT", /\bDROP\s+CONSTRAINT\b/i],
    ["DROP INDEX", /\bDROP\s+INDEX\b/i],
    ["RENAME", /\bRENAME\b/i],
  ] as const) {
    assert.doesNotMatch(sql, pattern, `the migration must not ${label}`);
  }
  // The one DROP is the trigger it replaces, in the same transaction.
  const drops = sql.match(/\bDROP\s+\w+(\s+IF\s+EXISTS)?\s+\S+/gi) ?? [];
  assert.deepEqual(drops, ["DROP TRIGGER IF EXISTS juno_change_conversation"]);
});

test("the R1 migration declares nothing Prisma cannot: no CHECK, no partial index, no CONCURRENTLY", () => {
  const sql = r1Sql();
  assert.doesNotMatch(executableSql(sql), /\bCHECK\b/i, "a CHECK constraint is drift the blocking CI check rejects");
  const indexes = statements(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s));
  assert.equal(indexes.length, 4, "the four indexes of the schema diff");
  for (const index of indexes) {
    assert.doesNotMatch(index, /\bWHERE\b/i, `a partial index is drift the blocking CI check rejects: ${index}`);
    assert.doesNotMatch(index, /\bCONCURRENTLY\b/i, "CONCURRENTLY cannot run inside Prisma's transaction");
  }
});

test("the R1 migration backfills nothing: every new Artifact column is nullable", () => {
  const sql = r1Sql();
  const alter = statements(sql).find((s) => /^ALTER TABLE "Artifact" ADD COLUMN/i.test(s));
  assert.ok(alter, "one ALTER TABLE adds the Artifact columns");
  for (const column of ['"projectId" TEXT', '"deletedAt" TIMESTAMP(3)', '"deletedReason" TEXT']) {
    assert.ok(alter.includes(`ADD COLUMN ${column}`), `adds ${column}`);
  }
  assert.doesNotMatch(alter, /NOT NULL|DEFAULT/i, "no NOT NULL and no default, so no table rewrite");
  for (const dml of [/^UPDATE\b/i, /^INSERT\b/i, /^DELETE\b/i]) {
    assert.equal(statements(sql).some((s) => dml.test(s)), false, `no ${dml.source} backfill`);
  }
});

test("the R1 migration's foreign keys: a project delete un-files, an artifact or message delete takes its proposals", () => {
  const sql = executableSql(r1Sql());
  assert.match(
    sql,
    /ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY \("projectId"\) REFERENCES "Project"\("id"\) ON DELETE SET NULL/,
  );
  assert.match(
    sql,
    /ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_artifactId_fkey" FOREIGN KEY \("artifactId"\) REFERENCES "Artifact"\("id"\) ON DELETE CASCADE/,
  );
  assert.match(
    sql,
    /ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_messageId_fkey" FOREIGN KEY \("messageId"\) REFERENCES "Message"\("id"\) ON DELETE CASCADE/,
  );
});

test("both conversation triggers skip the anchor, and nothing else about change capture moves", () => {
  const sql = executableSql(r1Sql());
  const upsert =
    /CREATE TRIGGER juno_change_conversation AFTER INSERT OR UPDATE ON "Conversation" FOR EACH ROW WHEN \(NEW\."kind" <> 'anchor'\) EXECUTE FUNCTION juno_record_account_change\('conversation', 'direct'\)/;
  const remove =
    /CREATE TRIGGER juno_change_conversation_delete AFTER DELETE ON "Conversation" FOR EACH ROW WHEN \(OLD\."kind" <> 'anchor'\) EXECUTE FUNCTION juno_record_account_change\('conversation', 'direct'\)/;
  assert.match(sql, upsert, "INSERT OR UPDATE skips NEW anchors");
  assert.match(sql, remove, "DELETE skips OLD anchors (a DELETE trigger's WHEN cannot name NEW)");

  // Every trigger this file creates is guarded; none is created unguarded.
  const created = sql.match(/CREATE TRIGGER \w+[^;]*/g) ?? [];
  assert.equal(created.length, 2);
  for (const trigger of created) assert.match(trigger, /FOR EACH ROW WHEN \((NEW|OLD)\."kind" <> 'anchor'\)/);

  // The old trigger is dropped before its replacement is created, in one file.
  assert.ok(
    sql.indexOf("DROP TRIGGER IF EXISTS juno_change_conversation ON") < sql.search(upsert),
    "drop, then create",
  );

  // The shared function is untouched (every entity type routes through it),
  // and proposals are never change-captured: they are never synced.
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(sql, /ON "ArtifactProposal" FOR EACH ROW/i);
  assert.doesNotMatch(sql, /ON "Artifact(Version)?" FOR EACH ROW/i, "artifact triggers keep firing unchanged");
});

// ----------------------------------------------------------------------------
// 2. The schema
// ----------------------------------------------------------------------------

/** One model's body as normalised lines: comments stripped, spaces collapsed. */
function model(name: string): string[] {
  const schema = source("prisma/schema.prisma");
  const match = schema.match(new RegExp(`\\nmodel ${name} \\{\\n([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `schema.prisma declares model ${name}`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function assertDeclares(name: string, lines: string[], expected: string[]) {
  for (const line of expected) assert.ok(lines.includes(line), `${name} declares \`${line}\``);
}

test("the schema: Artifact gains its own project and a trash stamp, and keeps its chat", () => {
  const artifact = model("Artifact");
  assertDeclares("Artifact", artifact, [
    "projectId String?",
    "deletedAt DateTime?",
    "deletedReason String?",
    "project Project? @relation(fields: [projectId], references: [id], onDelete: SetNull)",
    "proposals ArtifactProposal[]",
    "@@index([projectId])",
    "@@index([deletedAt])",
    // Unchanged until contraction (M10): installed builds decode it as required.
    "conversationId String",
    "conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)",
    "@@unique([conversationId, identifier])",
  ]);
  assertDeclares("Project", model("Project"), ["artifacts Artifact[]"]);
  assertDeclares("Message", model("Message"), ["artifactProposals ArtifactProposal[]"]);
  assertDeclares("Conversation", model("Conversation"), ['kind String @default("chat")']);
});

test("the schema: ArtifactProposal is keyed to its artifact and its reply, with no owner column", () => {
  const proposal = model("ArtifactProposal");
  assertDeclares("ArtifactProposal", proposal, [
    "id String @id @default(cuid())",
    "artifactId String",
    "baseVersion Int",
    'role String @default("suggestion")',
    'kind String @default("REWRITE")',
    "payload Json",
    'summary String @default("")',
    "messageId String?",
    "taint String?",
    'status String @default("PENDING")',
    "createdAt DateTime @default(now())",
    "resolvedAt DateTime?",
    "artifact Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)",
    "message Message? @relation(fields: [messageId], references: [id], onDelete: Cascade)",
    "@@index([artifactId, status])",
    "@@index([messageId])",
  ]);
  // Ownership is the artifact's, through its conversation. A userId here would
  // put the model under tests/ownership-guard.test.ts and db.ts's guard.
  assert.equal(proposal.some((line) => /^userId\b/.test(line)), false);
});

// ----------------------------------------------------------------------------
// 3. The contracts
// ----------------------------------------------------------------------------

test("the anchor's identity is fixed per account", () => {
  assert.equal(ANCHOR_KIND, "anchor");
  assert.equal(ANCHOR_TITLE, "Your artifacts");
  assert.equal(anchorConversationId("user_123"), "anchor_user_123");
});

test("visibleConversationWhere appends to AND and keeps the caller's own filters", () => {
  const notAnchor = { kind: { not: "anchor" } };
  assert.deepEqual(visibleConversationWhere(), { AND: [notAnchor] });
  assert.deepEqual(visibleConversationWhere({ userId: "u1", kind: "code" }), {
    userId: "u1",
    kind: "code",
    AND: [notAnchor],
  });

  const single = { userId: "u1", AND: { pinned: true } };
  assert.deepEqual(visibleConversationWhere(single), { userId: "u1", AND: [{ pinned: true }, notAnchor] });
  assert.deepEqual(single, { userId: "u1", AND: { pinned: true } }, "the caller's object is not mutated");

  const list = { AND: [{ pinned: true }, { archivedAt: null }] };
  assert.deepEqual(visibleConversationWhere(list).AND, [{ pinned: true }, { archivedAt: null }, notAnchor]);
  assert.equal(list.AND.length, 2, "the caller's array is not mutated");

  // Compile-time: the result still fits a unique where, so `update`, `delete`
  // and `findUnique` can take it directly (checked by tsc, not at runtime).
  const unique: Prisma.ConversationWhereUniqueInput = visibleConversationWhere({ id: "c1", userId: "u1" });
  assert.equal(unique.id, "c1");
});

test("visibleConversationSql qualifies the column and refuses an unsafe alias", () => {
  assert.equal(visibleConversationSql().sql, `"kind" <> 'anchor'`);
  assert.equal(visibleConversationSql("c").sql, `c."kind" <> 'anchor'`);
  assert.equal(visibleConversationSql("conv_2").sql, `conv_2."kind" <> 'anchor'`);
  assert.deepEqual(visibleConversationSql("c").values, []);
  for (const bad of ["", "C", "1c", '"c"', "c.d", "c; DROP TABLE x", "c --"]) {
    assert.throws(() => visibleConversationSql(bad), /Unsafe SQL alias/, `rejects ${JSON.stringify(bad)}`);
  }
});

test("artifactProjectWhere reads the chat's project, or the artifact's own once anchored", () => {
  assert.deepEqual(artifactProjectWhere("p1"), {
    OR: [
      { conversation: { projectId: "p1", kind: { not: "anchor" } } },
      { projectId: "p1", conversation: { kind: "anchor" } },
    ],
  });
});

test("artifactProjectSql is the same rule as a SQL expression", () => {
  assert.equal(
    artifactProjectSql().sql,
    `CASE WHEN c."kind" = 'anchor' THEN a."projectId" ELSE c."projectId" END`,
  );
  assert.equal(
    artifactProjectSql("art", "conv").sql,
    `CASE WHEN conv."kind" = 'anchor' THEN art."projectId" ELSE conv."projectId" END`,
  );
  assert.throws(() => artifactProjectSql("a; --"), /Unsafe SQL alias/);
  assert.throws(() => artifactProjectSql("a", "C"), /Unsafe SQL alias/);
});

test("effectiveArtifactProjectId never reads a chat artifact's own (stale or unset) projectId", () => {
  assert.equal(effectiveArtifactProjectId({ projectId: "stale" }, { kind: "chat", projectId: "p-chat" }), "p-chat");
  assert.equal(effectiveArtifactProjectId({ projectId: "stale" }, { kind: "chat", projectId: null }), null);
  assert.equal(effectiveArtifactProjectId({ projectId: "p-own" }, { kind: "anchor", projectId: null }), "p-own");
  assert.equal(effectiveArtifactProjectId({ projectId: null }, { kind: "anchor", projectId: null }), null);
  assert.equal(effectiveArtifactProjectId({}, { kind: "code" }), null);
});

test("the R1 flags: three on unless 0, the purge off unless 1", () => {
  for (const enabled of [detachOnDeleteEnabled, reemitGuardEnabled, artifactTrashEnabled]) {
    assert.equal(enabled(undefined), true, `${enabled.name} defaults on`);
    assert.equal(enabled(""), true);
    assert.equal(enabled("1"), true);
    assert.equal(enabled("0"), false, `${enabled.name} turns off with 0`);
  }
  assert.equal(artifactPurgeArmed(undefined), false, "the purge defaults to a dry run");
  assert.equal(artifactPurgeArmed("0"), false);
  assert.equal(artifactPurgeArmed("true"), false, "only the exact value arms it");
  assert.equal(artifactPurgeArmed("1"), true);
});

// serializers.ts is `server-only`: without the react-server condition the
// import throws, which is `npm test`'s situation. Skip there, run everywhere
// the documented command is used.
async function loadSerializers(t: TestContext) {
  try {
    return await import("@/lib/serializers");
  } catch {
    t.skip("needs NODE_OPTIONS=--conditions=react-server (serializers.ts is server-only)");
    return null;
  }
}

type ArtifactRow = Artifact & {
  versions: ArtifactVersion[];
  proposals?: Array<{ id: string; baseVersion: number; messageId: string | null; summary: string; createdAt: Date }>;
};

const NOW = new Date("2026-09-25T10:00:00Z");
function artifactRow(extra: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "art1",
    conversationId: "c1",
    messageId: "m1",
    identifier: "pricing",
    title: "Pricing",
    type: "HTML",
    language: null,
    currentVersion: 2,
    createdAt: NOW,
    updatedAt: NOW,
    projectId: null,
    deletedAt: null,
    deletedReason: null,
    versions: [
      { id: "v2", artifactId: "art1", version: 2, content: "<p>2</p>", origin: "edit", createdAt: NOW },
      { id: "v1", artifactId: "art1", version: 1, content: "<p>1</p>", origin: "generated", createdAt: NOW },
    ],
    ...extra,
  };
}

test("serializeArtifact: a live artifact with nothing waiting is exactly its pre-R1 payload", async (t) => {
  const mod = await loadSerializers(t);
  if (!mod) return;
  const iso = NOW.toISOString();
  const expected = {
    id: "art1",
    identifier: "pricing",
    type: "HTML",
    title: "Pricing",
    language: null,
    currentVersion: 2,
    content: "<p>2</p>",
    versions: [
      { version: 1, content: "<p>1</p>", origin: "generated", createdAt: iso },
      { version: 2, content: "<p>2</p>", origin: "edit", createdAt: iso },
    ],
    messageId: "m1",
    createdAt: iso,
    updatedAt: iso,
  };
  // Byte-identical, key order included: this is what the sync feed hashes and
  // what native decoders have always seen.
  assert.equal(JSON.stringify(mod.serializeArtifact(artifactRow())), JSON.stringify(expected));
  assert.equal(
    JSON.stringify(mod.serializeArtifact(artifactRow({ proposals: [] }))),
    JSON.stringify(expected),
    "an include with no PENDING proposal adds nothing",
  );
  // An anchored artifact's own project is server-side only.
  assert.equal("projectId" in mod.serializeArtifact(artifactRow({ projectId: "p1" })), false);
});

test("serializeArtifact adds deletedAt and pendingSuggestion only when set", async (t) => {
  const mod = await loadSerializers(t);
  if (!mod) return;
  const trashedAt = new Date("2026-09-25T12:00:00Z");
  const trashed = mod.serializeArtifact(artifactRow({ deletedAt: trashedAt, deletedReason: "user" }));
  assert.equal(trashed.deletedAt, trashedAt.toISOString());
  assert.equal("deletedReason" in trashed, false, "the reason stays server-side");
  assert.equal("pendingSuggestion" in trashed, false);

  const waiting = mod.serializeArtifact(
    artifactRow({
      proposals: [{ id: "prop1", baseVersion: 2, messageId: "m9", summary: "You edited this after Juno's last version", createdAt: NOW }],
    }),
  );
  assert.deepEqual(waiting.pendingSuggestion, {
    id: "prop1",
    baseVersion: 2,
    messageId: "m9",
    summary: "You edited this after Juno's last version",
    createdAt: NOW.toISOString(),
  });
  assert.equal("deletedAt" in waiting, false);
});

test("ARTIFACT_CLIENT_INCLUDE carries the newest PENDING suggestion's label, never its payload", async (t) => {
  const mod = await loadSerializers(t);
  if (!mod) return;
  const { versions, proposals } = mod.ARTIFACT_CLIENT_INCLUDE;
  assert.equal(versions, true);
  assert.deepEqual(proposals.where, { status: "PENDING" });
  assert.deepEqual(proposals.orderBy, { createdAt: "desc" });
  assert.equal(proposals.take, 1);
  assert.deepEqual(Object.keys(proposals.select).sort(), ["baseVersion", "createdAt", "id", "messageId", "summary"]);
});
