import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_VERSION_WINDOW,
  artifactInProjectWhere,
  artifactProjectId,
  artifactsForInstalledApps,
  isInstalledAppRequest,
  ownedArtifactWhere,
  syncConversationIdFor,
} from "../src/lib/artifact-access";
import type { ClientArtifact } from "../src/types/chat";
import { nextVersionCursor, parseVersionPageQuery } from "../src/lib/artifact-version-pages";
import {
  afterCursorWhere,
  decodeLibraryMadeCursor,
  deliverableType,
  encodeLibraryMadeCursor,
  mergeLibraryPages,
  type LibraryMadeItem,
} from "../src/lib/library-made";
import { publicationSummary, publishTargetValue, versionChoices } from "../src/lib/publication-view";
import { artifactFileName, bundleFiles, isMultiFileType, BUNDLE_HISTORY_BUDGET_CHARS } from "../src/lib/artifact-bundle";
import { copyIdentifier, copyTitle } from "../src/lib/artifact-copy-names";
import { allocatesCheckpoint, CHECKPOINT_WINDOW_MS } from "../src/lib/design/operations";
import { serializeDesignDocument } from "../src/lib/design/migrations";
import { signInDocument, transaction } from "./design-fixtures";

/*
 * The artifact lifecycle's pure rules and its source-level promises
 * (PRODUCT_REFOUNDATION §10). The database behaviour is in
 * tests/artifact-ownership-lifecycle.integration.test.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(rel);
  }
  return out;
}

// ─── Ownership ───────────────────────────────────────────────────────────────

test("an owner read is the artifact's own owner and live rows, or the trash when asked", () => {
  assert.deepEqual(ownedArtifactWhere("u1"), { userId: "u1", deletedAt: null });
  assert.deepEqual(ownedArtifactWhere("u1", { id: "a1" }), { id: "a1", userId: "u1", deletedAt: null });
  assert.deepEqual(ownedArtifactWhere("u1", {}, { trashed: true }), { userId: "u1", deletedAt: { not: null } });
  // The owner cannot be overridden by the extra filter.
  assert.deepEqual(ownedArtifactWhere("u1", { userId: "u2" } as never), { userId: "u1", deletedAt: null });
});

test("a project is the artifact's own, or its chat's for a row written without one", () => {
  assert.deepEqual(artifactInProjectWhere("p1"), { OR: [{ projectId: "p1" }, { projectId: null, conversation: { projectId: "p1" } }] });
  assert.equal(artifactProjectId({ projectId: "own", conversation: { projectId: "chat" } }), "own");
  assert.equal(artifactProjectId({ projectId: null, conversation: { projectId: "chat" } }), "chat");
  assert.equal(artifactProjectId({ projectId: null, conversation: null }), null);
});

test("a detached artifact syncs a stable, non-empty placeholder chat id the installed apps can decode", () => {
  assert.equal(syncConversationIdFor({ id: "a1", conversationId: "c1" }), "c1");
  assert.equal(syncConversationIdFor({ id: "a1", conversationId: null }), "library:a1");
});

test("no artifact read still reaches its owner through the conversation", () => {
  // The chat is a nullable pointer now: a `conversation: { userId }` join would
  // silently hide every detached artifact from its owner.
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const source = read(file);
    for (const match of source.matchAll(/(artifact|artifactVersion)\.(findFirst|findMany|findUnique|count|updateMany)\(\{\s*where:\s*\{[^}]*conversation:\s*\{\s*userId/g)) {
      offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
    }
    for (const match of source.matchAll(/artifact:\s*\{\s*conversation:\s*\{\s*userId/g)) {
      offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.match(read("src/lib/db.ts"), /\["Artifact", "userId"\]/, "the ownership guard checks every artifact query");
  assert.match(read("src/lib/db.ts"), /\["ArtifactDraft", "userId"\]/);
  assert.match(read("src/lib/db.ts"), /\["ArtifactPublication", "userId"\]/);
});

test("New design makes no conversation, and the delete-chat copy says the artifacts stay", () => {
  const design = read("src/app/api/design/route.ts");
  assert.doesNotMatch(design, /conversation\.create/);
  assert.match(design, /conversationId: null,/);
  const sidebar = read("src/components/app/app-sidebar.tsx");
  assert.equal(sidebar.match(/Anything Juno made in it stays in your Library\./g)?.length, 2);
  assert.match(read("src/components/settings/sections/data-privacy.tsx"), /Everything Juno made in them stays in your/);
});

// ─── Immutable versions and drafts ───────────────────────────────────────────

test("nothing in the app rewrites a version", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const source = read(file);
    for (const match of source.matchAll(/artifactVersion\s*\.\s*(update|updateMany|upsert)\s*\(/g)) {
      offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, [], "versions are appended, never rewritten (the database refuses it too)");
});

test("a design gesture folds into the draft only inside the window, and never for Juno or a restore", () => {
  const edit = transaction([{ op: "renameDocument", name: "x" }]);
  const juno = transaction([{ op: "renameDocument", name: "x" }], { author: "juno" });
  const draft = (ageMs: number) => ({ origin: "edit", ageMs });
  assert.equal(allocatesCheckpoint(null, edit, "edit"), true, "no draft: start one");
  assert.equal(allocatesCheckpoint(draft(1_000), edit, "edit"), false, "fold into the draft");
  assert.equal(allocatesCheckpoint(draft(CHECKPOINT_WINDOW_MS), edit, "edit"), true, "a pause seals the draft");
  assert.equal(allocatesCheckpoint(draft(1_000), juno, "edit"), true, "Juno's change stands alone");
  assert.equal(allocatesCheckpoint(draft(1_000), edit, "restore"), true, "a restore stands alone");
});

test("the history API pages by version number, newest first", () => {
  const params = (q: string) => new URLSearchParams(q);
  assert.deepEqual(parseVersionPageQuery(params("")), { before: null, limit: 20, content: false });
  assert.deepEqual(parseVersionPageQuery(params("before=12&limit=5&content=1")), { before: 12, limit: 5, content: true });
  assert.deepEqual(parseVersionPageQuery(params("limit=1000")), { before: null, limit: 100, content: false });
  assert.equal(parseVersionPageQuery(params("before=0")), null);
  assert.equal(parseVersionPageQuery(params("before=abc")), null);
  assert.equal(parseVersionPageQuery(params("limit=-3")), null);
  assert.equal(nextVersionCursor([{ version: 9 }, { version: 8 }], 2), 8);
  assert.equal(nextVersionCursor([{ version: 2 }, { version: 1 }], 2), null, "version 1 is the start of history");
  assert.equal(nextVersionCursor([{ version: 9 }], 2), null, "a short page is the last");
  assert.ok(ARTIFACT_VERSION_WINDOW >= 20);
});

// ─── The migration ───────────────────────────────────────────────────────────

const MIGRATION = "prisma/migrations/20260930120000_artifact_ownership_lifecycle/migration.sql";

test("the migration is additive (expand step) and keeps every change-capture branch", () => {
  const sql = read(MIGRATION).replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, /DROP\s+(COLUMN|TABLE)/i);
  assert.doesNotMatch(sql, /SET NOT NULL/i, "userId stays nullable until a later release");
  assert.match(sql, /ALTER COLUMN "conversationId" DROP NOT NULL/);
  assert.match(sql, /FOREIGN KEY \("conversationId"\) REFERENCES "Conversation"\("id"\) ON DELETE SET NULL/);
  assert.match(sql, /UPDATE "Artifact" a\s+SET "userId" = c\."userId"/, "the backfill");
  assert.match(sql, /CREATE TRIGGER juno_artifact_fill_owner BEFORE INSERT ON "Artifact"/);
  assert.match(sql, /CREATE TRIGGER juno_artifact_version_immutable BEFORE UPDATE ON "ArtifactVersion"/);
  assert.match(sql, /juno_record_account_change\('artifact', 'artifact_owner'\)/);

  // Every resolution mode of the function it replaces survives, and so does the
  // account-delete guard 20260815140000 once lost (20260815180000).
  const previous = read("prisma/migrations/20260815180000_restore_account_delete_guard/migration.sql");
  const modes = (text: string) => new Set([...text.matchAll(/TG_ARGV\[1\] = '(\w+)'/g)].map((m) => m[1]));
  for (const mode of modes(previous)) assert.ok(modes(sql).has(mode), `branch ${mode} kept`);
  assert.ok(modes(sql).has("artifact_owner"));
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM "User" WHERE id = account_id\) THEN RETURN NULL; END IF;/);
  assert.match(sql, /\$\$ LANGUAGE plpgsql SET search_path = public, pg_temp;\s*CREATE TRIGGER juno_change_artifact/);
  assert.equal(sql.match(/SET search_path = public, pg_temp/g)?.length, 3, "every function this migration defines pins its search_path");
});

// ─── The installed apps ──────────────────────────────────────────────────────

function clientArtifact(overrides: Partial<ClientArtifact> = {}): ClientArtifact {
  return {
    id: "art-1",
    identifier: "hero",
    type: "DESIGN",
    title: "Hero",
    currentVersion: 2,
    content: "v2",
    versions: [
      { version: 1, content: "v1", origin: "generated", createdAt: "2026-09-30T10:00:00.000Z" },
      { version: 2, content: "v2", origin: "edit", createdAt: "2026-09-30T11:00:00.000Z" },
    ],
    messageId: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T11:00:00.000Z",
    ...overrides,
  };
}

test("an installed app is never handed a trashed artifact or a web draft", () => {
  const live = clientArtifact();
  const trashed = clientArtifact({ id: "art-2", deletedAt: "2026-09-30T12:00:00.000Z" });
  const drafted = clientArtifact({
    id: "art-3",
    currentVersion: 3,
    content: "draft",
    versions: [...live.versions, { version: 3, content: "draft", origin: "edit", createdAt: "2026-09-30T12:00:00.000Z", draft: true }],
  });
  const [first, third, ...rest] = artifactsForInstalledApps([live, trashed, drafted]);
  assert.equal(rest.length, 0, "the trashed one is left out");
  assert.equal(first, live, "a plain live artifact passes through untouched");
  assert.equal(third.id, "art-3");
  assert.equal(third.currentVersion, 2, "the sealed head, not the draft's number");
  assert.equal(third.content, "v2");
  assert.deepEqual(third.versions.map((v) => v.version), [1, 2]);
  assert.ok(third.versions.every((v) => !v.draft));

  assert.equal(isInstalledAppRequest(new Request("http://juno.test", { headers: { authorization: "Bearer x" } })), true);
  assert.equal(isInstalledAppRequest(new Request("http://juno.test")), false);
});

test("the chat read and a turn's done frame give the installed apps their projection", () => {
  const thread = read("src/app/api/conversations/[id]/route.ts");
  assert.match(thread, /isInstalledAppRequest\(req\)[\s\S]*artifactsForInstalledApps\(thread\.artifacts\)/);
  const chat = read("src/app/api/chat/route.ts");
  const frames = [...chat.matchAll(/type: "done",[\s\S]*?\n\s*\}\);/g)].map((m) => m[0]).filter((f) => /\bartifacts\b/.test(f) && !/artifacts: \[\]/.test(f));
  assert.ok(frames.length >= 2, "both saved-turn done frames found");
  for (const frame of frames) assert.match(frame, /artifacts: doneArtifacts\(artifacts\)/);
});

// ─── Publish vs Share ────────────────────────────────────────────────────────

test("opening the Share dialog reads; only a button creates", () => {
  const dialog = read("src/components/share/share-dialog.tsx");
  const loaders = [...dialog.matchAll(/const load = React\.useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/g)].map((m) => m[1]);
  assert.equal(loaders.length, 2, "one reader for a chat link, one for a publication");
  for (const body of loaders) assert.doesNotMatch(body, /method: "(POST|DELETE)"/);
  assert.doesNotMatch(dialog, /useEffect\([^)]*createLink/);
});

test("the Publish panel words the state in plain sentences, and offers latest and every recent version", () => {
  const live = { id: "p", url: "u", state: "live" as const, pinnedVersion: null, servedVersion: 4, views: 1, publishedAt: "x" };
  assert.equal(publicationSummary(null, 3), "Not published. Nothing is public until you press Publish.");
  assert.equal(publicationSummary(live, 4), "Published, following the latest version (now v4) · 1 view");
  assert.equal(
    publicationSummary({ ...live, pinnedVersion: 2, servedVersion: 2, views: 3 }, 4),
    "Published, showing version 2 · v4 is newer and stays private · 3 views"
  );
  assert.equal(publicationSummary({ ...live, state: "unpublished" }, 4), "Unpublished. The link is kept and works again when you publish.");
  assert.equal(publishTargetValue(null), "latest");
  assert.equal(publishTargetValue({ pinnedVersion: 3 }), "3");
  const choices = versionChoices(3);
  assert.deepEqual(choices.map((c) => c.value), ["latest", "3", "2", "1"]);
  assert.equal(versionChoices(500).length, 51);
});

test("public pages stay static: publishing does not switch on scripted previews", () => {
  const publication = read("src/lib/artifact-publication.ts");
  assert.doesNotMatch(publication, /JUNO_PREVIEW_ORIGIN_PUBLIC\s*=/);
  assert.match(read("src/app/share/[token]/page.tsx"), /<SandboxProfileProvider profile=\{publicShareProfile\(\)\}>/);
});

// ─── Duplicate, download, Library ────────────────────────────────────────────

test("a copy is named after its source", () => {
  assert.equal(copyTitle("Pricing page"), "Pricing page (copy)");
  assert.equal(copyTitle("   "), "Untitled (copy)");
  assert.equal(copyTitle("x".repeat(300)).length, 200);
  assert.match(copyIdentifier("pricing~abc123", new Date(0)), /^pricing-copy-0$/);
});

test("a download is one file, or a bundle for a design, with provenance and a bounded history", () => {
  const base = { id: "a1", identifier: "pricing", title: "Pricing / page", type: "HTML", language: null };
  assert.equal(artifactFileName(base), "Pricing page.html");
  assert.equal(artifactFileName({ ...base, type: "CODE", language: "python" }), "Pricing page.py");
  assert.equal(artifactFileName({ ...base, type: "DESIGN" }), "Pricing page.juno.design.json");
  assert.equal(isMultiFileType("DESIGN"), true);
  assert.equal(isMultiFileType("HTML"), false);

  const files = bundleFiles({
    artifact: { ...base, derivedFromId: "src", derivedFromVersion: 2 },
    version: 3,
    content: "<p>3</p>",
    history: [
      { version: 1, content: "<p>1</p>", origin: "generated", createdAt: new Date(0) },
      { version: 2, content: "<p>2</p>", origin: "edit", createdAt: new Date(0) },
      { version: 3, content: "<p>3</p>", origin: "edit", createdAt: new Date(0) },
    ],
    now: new Date("2026-09-30T00:00:00Z"),
  });
  assert.deepEqual(files.map((f) => f.path), ["Pricing page.html", "history/v1.html", "history/v2.html", "README.md"]);
  const readme = files.at(-1)!.content;
  assert.match(readme, /Copied from: src \(version 2\)/);
  assert.match(readme, /`history\/` holds versions 1, 2\./);

  const huge = "x".repeat(BUNDLE_HISTORY_BUDGET_CHARS);
  const bounded = bundleFiles({
    artifact: base,
    version: 3,
    content: "<p>3</p>",
    history: [
      { version: 1, content: huge, origin: "generated", createdAt: new Date(0) },
      { version: 2, content: "<p>2</p>", origin: "edit", createdAt: new Date(0) },
    ],
  });
  assert.deepEqual(bounded.map((f) => f.path), ["Pricing page.html", "history/v1.html", "README.md"], "the budget stops the archive");

  const design = bundleFiles({ artifact: { ...base, type: "DESIGN" }, version: 1, content: serializeDesignDocument(signInDocument()) });
  assert.deepEqual(design.map((f) => f.path), ["Pricing page.juno.design.json", "poster.svg", "handoff.json", "README.md"]);
});

test("the Library merges artifacts and deliverables newest first, behind a position cursor", () => {
  const item = (kind: "artifact" | "deliverable", id: string, updatedAt: string): LibraryMadeItem => ({
    kind,
    id,
    type: kind === "artifact" ? "HTML" : "DOCUMENT",
    title: id,
    version: 1,
    projectId: null,
    createdAt: updatedAt,
    updatedAt,
    href: "/",
    conversationId: null,
  });
  const page = mergeLibraryPages(
    [
      [item("artifact", "a2", "2026-09-30T10:00:00.000Z"), item("artifact", "a1", "2026-09-29T10:00:00.000Z")],
      [item("deliverable", "d1", "2026-09-30T12:00:00.000Z"), item("deliverable", "d0", "2026-09-28T10:00:00.000Z")],
    ],
    2
  );
  assert.deepEqual(page.items.map((i) => i.id), ["d1", "a2"]);
  const cursor = decodeLibraryMadeCursor(page.nextCursor);
  assert.deepEqual(cursor, { updatedAt: new Date("2026-09-30T10:00:00.000Z"), id: "a2" });
  assert.deepEqual(afterCursorWhere(cursor), {
    OR: [{ updatedAt: { lt: cursor!.updatedAt } }, { updatedAt: cursor!.updatedAt, id: { lt: "a2" } }],
  });
  assert.equal(mergeLibraryPages([[item("artifact", "a", "2026-01-01T00:00:00.000Z")]], 2).nextCursor, null);
  assert.equal(decodeLibraryMadeCursor("garbage"), null);
  assert.equal(decodeLibraryMadeCursor(encodeLibraryMadeCursor({ updatedAt: new Date(0), id: "x" }))?.id, "x");
  assert.equal(deliverableType("spreadsheet"), "SPREADSHEET");
});

// ─── The serializer (server-only: needs the react-server condition) ─────────

async function loadSerializers(t: TestContext) {
  try {
    return await import("../src/lib/serializers");
  } catch (err) {
    if (/Client Component|server-only|cannot be imported/.test(String(err))) {
      t.skip("needs NODE_OPTIONS=--conditions=react-server");
      return null;
    }
    throw err;
  }
}

test("an artifact read carries a window of versions, a draft as the version it will become, and adds nothing when unset", async (t) => {
  const serializers = await loadSerializers(t);
  if (!serializers) return;
  const at = new Date("2026-09-30T10:00:00Z");
  const row = {
    id: "a1",
    identifier: "plan",
    type: "DESIGN",
    title: "Plan",
    language: null,
    currentVersion: 5,
    messageId: null,
    createdAt: at,
    updatedAt: at,
    versions: [5, 4].map((version) => ({ version, content: `v${version}`, origin: "edit", createdAt: at })),
  };
  const plain = serializers.serializeArtifact(row as never);
  assert.deepEqual(plain.versions.map((v) => v.version), [4, 5]);
  assert.equal(plain.content, "v5");
  assert.equal(plain.hasOlderVersions, true, "versions 1–3 page in on demand");
  assert.equal("deletedAt" in plain || "pendingSuggestion" in plain, false);

  const drafted = serializers.serializeArtifact({ ...row, draft: { content: "working", updatedAt: at } } as never);
  assert.equal(drafted.currentVersion, 6);
  assert.equal(drafted.content, "working");
  assert.deepEqual(drafted.versions.at(-1), { version: 6, content: "working", origin: "edit", createdAt: at.toISOString(), draft: true });
});
