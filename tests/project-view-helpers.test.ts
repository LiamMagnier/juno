import test from "node:test";
import assert from "node:assert/strict";
import { estimateKnowledgeTokens, knowledgeUsage, PROJECT_KNOWLEDGE_CAPACITY_TOKENS } from "@/lib/projects/knowledge-capacity";
import {
  describeSource,
  driveWebUrl,
  safeReturnPath,
  sourcesBusy,
  syncedAgo,
  type ProjectSourceView,
} from "@/lib/projects/project-sources-shared";
import { activityLabel, lastActivityOf, visibleProjects, type ProjectListEntry } from "@/lib/projects/project-view";

/*
 * The project pages' pure helpers: the knowledge meter, what a Drive source's
 * row says and offers in each sync state, where the connect flow may send the
 * person back to, and which projects the list shows in which order.
 */

const NOW = Date.parse("2026-11-16T12:00:00Z");

function source(overrides: Partial<ProjectSourceView> = {}): ProjectSourceView {
  return {
    id: "s1",
    provider: "google-drive",
    kind: "folder",
    externalId: "folder-1",
    name: "Q4 Planning",
    includeSubfolders: true,
    state: "ready",
    syncing: false,
    errorCode: null,
    error: null,
    fileCount: 24,
    skippedCount: 0,
    truncated: false,
    lastSyncedAt: "2026-11-16T11:57:00Z",
    lastAttemptAt: "2026-11-16T11:57:00Z",
    skipped: [],
    ...overrides,
  };
}

test("the knowledge meter counts indexed tokens, estimates the rest, and says it plainly", () => {
  assert.equal(estimateKnowledgeTokens({ size: 4000, mimeType: "text/markdown" }), 1000);
  assert.equal(estimateKnowledgeTokens({ size: 4000, mimeType: "application/pdf" }), 400);
  assert.equal(estimateKnowledgeTokens({ size: 4000, mimeType: "application/pdf", tokenCount: 1234 }), 1234, "the index's own count wins");
  assert.equal(estimateKnowledgeTokens({ size: 9_000_000, mimeType: "image/png" }), 0, "pictures are not read as text");

  assert.equal(knowledgeUsage([]).label, "No knowledge added yet");
  const tiny = knowledgeUsage([{ size: 400, mimeType: "text/plain" }]);
  assert.equal(tiny.label, "Less than 1% of project capacity used");
  assert.equal(tiny.percent, 1, "a project with something in it never draws an empty bar");
  const some = knowledgeUsage([{ size: 0, mimeType: "application/pdf", tokenCount: PROJECT_KNOWLEDGE_CAPACITY_TOKENS * 0.42 }]);
  assert.equal(some.label, "42% of project capacity used");
  assert.equal(some.nearlyFull, false);
  const near = knowledgeUsage([{ size: 0, mimeType: "text/plain", tokenCount: PROJECT_KNOWLEDGE_CAPACITY_TOKENS * 0.95 }]);
  assert.equal(near.nearlyFull, true);
  assert.equal(near.full, false);
  const full = knowledgeUsage([{ size: 0, mimeType: "text/plain", tokenCount: PROJECT_KNOWLEDGE_CAPACITY_TOKENS * 1.3 }]);
  assert.deepEqual([full.full, full.percent, full.fraction, full.label], [true, 100, 1, "Project knowledge is full"]);
});

test("a source's row says how many files and when it last synced", () => {
  assert.deepEqual(describeSource(source(), NOW), { tone: "neutral", text: "24 files · Synced 3 min ago", action: null });
  assert.equal(describeSource(source({ kind: "file", fileCount: 1 }), NOW).text, "Synced 3 min ago");
  assert.equal(describeSource(source({ skippedCount: 2 }), NOW).text, "24 files · 2 skipped · Synced 3 min ago");
  assert.equal(describeSource(source({ skippedCount: 2 }), NOW).tone, "attention");
  assert.equal(describeSource(source({ truncated: true }), NOW).tone, "attention");
});

test("a syncing source says it is working, first sync or not", () => {
  assert.deepEqual(describeSource(source({ state: "pending", lastSyncedAt: null, fileCount: 0 }), NOW), { tone: "busy", text: "Reading the folder…", action: null });
  assert.equal(describeSource(source({ kind: "file", state: "pending", lastSyncedAt: null }), NOW).text, "Adding the file…");
  assert.equal(describeSource(source({ syncing: true }), NOW).text, "24 files · Syncing…");
  assert.equal(sourcesBusy([source(), source({ id: "s2", syncing: true })]), true);
  assert.equal(sourcesBusy([source()]), false);
});

test("each sync error offers the one fix the person can make", () => {
  const error = (errorCode: ProjectSourceView["errorCode"]) =>
    describeSource(source({ state: "error", errorCode, error: `sentence for ${errorCode}` }), NOW);
  assert.deepEqual(error("reconnect").action, { kind: "reconnect", label: "Reconnect Drive" });
  assert.deepEqual(error("forbidden").action, { kind: "reconnect", label: "Reconnect Drive" });
  assert.deepEqual(error("not_connected").action, { kind: "connect", label: "Connect Drive" });
  assert.deepEqual(error("provider_error").action, { kind: "retry", label: "Try again" });
  assert.deepEqual(error("rate_limited").action, { kind: "retry", label: "Try again" });
  assert.equal(error("not_found").action, null, "nothing here brings a deleted folder back");
  assert.equal(error("reconnect").tone, "error");
  assert.equal(error("reconnect").text, "sentence for reconnect");
  assert.equal(error("capacity").tone, "attention", "a full project is partial, not broken");
  assert.equal(error("capacity").action, null);
});

test("synced-ago reads like a person", () => {
  assert.equal(syncedAgo("2026-11-16T11:59:40Z", NOW), "just now");
  assert.equal(syncedAgo("2026-11-16T09:00:00Z", NOW), "3 hr ago");
  assert.equal(syncedAgo("2026-11-15T10:00:00Z", NOW), "yesterday");
  assert.equal(syncedAgo("2026-11-12T10:00:00Z", NOW), "4 days ago");
  assert.equal(syncedAgo("not a date", NOW), "");
});

test("Open in Google Drive goes to the folder or the file", () => {
  assert.equal(driveWebUrl({ kind: "folder", externalId: "abc_1" }), "https://drive.google.com/drive/folders/abc_1");
  assert.equal(driveWebUrl({ kind: "file", externalId: "f-2" }), "https://drive.google.com/file/d/f-2/view");
});

test("the connect flow may only send the person back to a page on this site", () => {
  assert.equal(safeReturnPath("/projects/abc?drive=1"), "/projects/abc?drive=1");
  for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "projects/abc", "", "/a\nb", null, 42, `/${"x".repeat(600)}`]) {
    assert.equal(safeReturnPath(bad), null, String(bad));
  }
  assert.equal(safeReturnPath("/projects/../connections#x"), "/connections", "normalised, the fragment dropped");
});

test("the list shows the top level by default and searches every level by name and description", () => {
  const projects: ProjectListEntry[] = [
    { id: "a", name: "Atlas launch", parentId: null, description: "Ship the launch", instructions: "secret prompt", lastActivityAt: "2026-11-15T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", starred: true },
    { id: "b", name: "Research", parentId: "a", description: "Interviews", lastActivityAt: "2026-11-16T00:00:00Z", createdAt: "2026-11-01T00:00:00Z" },
    { id: "c", name: "budget", parentId: null, description: "", updatedAt: "2026-11-10T00:00:00Z", createdAt: "2026-11-05T00:00:00Z" },
    { id: "d", name: "Orphan", parentId: "gone", lastActivityAt: "2026-11-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z" },
  ];
  const ids = (list: ProjectListEntry[]) => list.map((p) => p.id);
  assert.deepEqual(ids(visibleProjects(projects, { query: "", filter: "all", sort: "activity" })), ["a", "c", "d"], "a folder whose parent is gone is top level");
  assert.deepEqual(ids(visibleProjects(projects, { query: "", filter: "all", sort: "name" })), ["a", "c", "d"]);
  assert.deepEqual(ids(visibleProjects(projects, { query: "", filter: "all", sort: "created" })), ["c", "a", "d"]);
  assert.deepEqual(ids(visibleProjects(projects, { query: "interview", filter: "all", sort: "activity" })), ["b"], "a search finds a folder by its description");
  assert.deepEqual(ids(visibleProjects(projects, { query: "secret", filter: "all", sort: "activity" })), [], "instructions are not searched");
  assert.deepEqual(ids(visibleProjects(projects, { query: "", filter: "pinned", sort: "activity" })), ["a"]);
});

test("a card's time is its last activity: a chat in it counts as much as an edit", () => {
  const project: ProjectListEntry = { id: "a", name: "A", parentId: null, updatedAt: "2026-10-01T00:00:00Z", lastActivityAt: "2026-11-15T00:00:00Z" };
  assert.equal(lastActivityOf(project), "2026-11-15T00:00:00Z");
  assert.equal(activityLabel(project, NOW), "Updated yesterday");
  assert.equal(activityLabel({ ...project, lastActivityAt: "2026-11-16T08:00:00Z" }, NOW), "Updated today");
  assert.equal(activityLabel({ ...project, lastActivityAt: "2026-11-06T00:00:00Z" }, NOW), "Updated 10 days ago");
  assert.equal(activityLabel({ ...project, lastActivityAt: undefined, updatedAt: "2026-08-01T00:00:00Z" }, NOW), "Updated 3 months ago");
  assert.equal(activityLabel({ id: "x", name: "X", parentId: null }, NOW), null);
});
