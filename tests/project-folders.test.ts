import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  MAX_PROJECT_DEPTH,
  ancestorIds,
  buildProjectForest,
  depthOf,
  descendantIds,
  flattenProjectForest,
  mergeInheritedProjectContext,
  planFolderDelete,
  subtreeHeight,
  validateNewChild,
  validateProjectMove,
  type ProjectTreeNode,
} from "../src/lib/projects/project-tree";
import { buildProjectContext, buildProjectReferenceFiles } from "../src/lib/chat/context-assembly";

/*
 * PROJECT FOLDERS: projects nest inside projects (Project.parentId). The rules
 * live in src/lib/projects/project-tree.ts; the routes apply them.
 *
 *   atlas
 *   ├── research
 *   │   └── interviews
 *   │       └── transcripts      (depth 4: the limit)
 *   └── launch
 *   home
 */
const TREE: ProjectTreeNode[] = [
  { id: "atlas", parentId: null },
  { id: "research", parentId: "atlas" },
  { id: "interviews", parentId: "research" },
  { id: "transcripts", parentId: "interviews" },
  { id: "launch", parentId: "atlas" },
  { id: "home", parentId: null },
];

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("ancestors, descendants, depth and height", () => {
  assert.deepEqual(ancestorIds(TREE, "transcripts"), ["interviews", "research", "atlas"]);
  assert.deepEqual(ancestorIds(TREE, "atlas"), []);
  assert.deepEqual(new Set(descendantIds(TREE, "atlas")), new Set(["research", "interviews", "transcripts", "launch"]));
  assert.equal(depthOf(TREE, "atlas"), 1);
  assert.equal(depthOf(TREE, "transcripts"), 4);
  assert.equal(subtreeHeight(TREE, "atlas"), 4);
  assert.equal(subtreeHeight(TREE, "launch"), 1);
});

test("a corrupt cycle already in the data cannot hang the walkers", () => {
  const looped: ProjectTreeNode[] = [
    { id: "a", parentId: "b" },
    { id: "b", parentId: "a" },
  ];
  assert.deepEqual(ancestorIds(looped, "a"), ["b"]);
  assert.deepEqual(descendantIds(looped, "a"), ["b"]);
  assert.equal(subtreeHeight(looped, "a"), 2);
  // Neither is drawn twice, and nothing is lost to the loop.
  const flat = flattenProjectForest(buildProjectForest(looped)).map((row) => row.node.id);
  assert.deepEqual(flat.sort(), ["a", "b"], "a loop is drawn once, at the top level, not lost");
});

test("cycle prevention: never into itself or its own descendants", () => {
  assert.deepEqual(validateProjectMove(TREE, "atlas", "atlas"), { ok: false, reason: "self" });
  assert.deepEqual(validateProjectMove(TREE, "atlas", "research"), { ok: false, reason: "cycle" });
  assert.deepEqual(validateProjectMove(TREE, "atlas", "transcripts"), { ok: false, reason: "cycle" });
  assert.deepEqual(validateProjectMove(TREE, "research", "interviews"), { ok: false, reason: "cycle" });
});

test("move semantics: into a sibling, out to the top level, refused past the depth limit", () => {
  assert.deepEqual(validateProjectMove(TREE, "launch", "research"), { ok: true });
  assert.deepEqual(validateProjectMove(TREE, "research", null), { ok: true });
  assert.deepEqual(validateProjectMove(TREE, "home", "atlas"), { ok: true });
  // home (height 1) under interviews (depth 3) lands at depth 4: allowed.
  assert.deepEqual(validateProjectMove(TREE, "home", "interviews"), { ok: true });
  // home under transcripts (depth 4) would be depth 5.
  assert.deepEqual(validateProjectMove(TREE, "home", "transcripts"), { ok: false, reason: "depth" });
  // research carries a subtree of height 3; under launch (depth 2) it would reach 5.
  assert.deepEqual(validateProjectMove(TREE, "research", "launch"), { ok: false, reason: "depth" });
  // A parent outside the owner's tree (another account's project) is not found.
  assert.deepEqual(validateProjectMove(TREE, "home", "someone-elses"), { ok: false, reason: "parent_not_found" });
  assert.deepEqual(validateProjectMove(TREE, "missing", null), { ok: false, reason: "not_found" });
  assert.equal(MAX_PROJECT_DEPTH, 4);
});

test("a new subfolder respects the same limit", () => {
  assert.deepEqual(validateNewChild(TREE, null), { ok: true });
  assert.deepEqual(validateNewChild(TREE, "interviews"), { ok: true });
  assert.deepEqual(validateNewChild(TREE, "transcripts"), { ok: false, reason: "depth" });
  assert.deepEqual(validateNewChild(TREE, "nope"), { ok: false, reason: "parent_not_found" });
});

test("deleting a folder lifts its children to its own parent by default", () => {
  const lift = planFolderDelete(TREE, "research");
  assert.deepEqual(lift, { reparent: { ids: ["interviews"], parentId: "atlas" }, deleteIds: ["research"] });

  const top = planFolderDelete(TREE, "atlas");
  assert.deepEqual(top.reparent, { ids: ["research", "launch"], parentId: null });
  assert.deepEqual(top.deleteIds, ["atlas"]);

  assert.deepEqual(planFolderDelete(TREE, "launch"), { reparent: null, deleteIds: ["launch"] });
  assert.deepEqual(planFolderDelete(TREE, "missing"), { reparent: null, deleteIds: [] });
});

test("cascade deletes the subtree deepest first", () => {
  const plan = planFolderDelete(TREE, "research", "cascade");
  assert.equal(plan.reparent, null);
  assert.deepEqual(plan.deleteIds, ["transcripts", "interviews", "research"]);
});

test("forest: nesting, order, and a dangling parent drawn at the top level", () => {
  const rows = [...TREE, { id: "orphan", parentId: "gone" }].map((node) => ({ ...node, name: node.id }));
  const forest = buildProjectForest(rows, (a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(forest.map((entry) => entry.node.id), ["atlas", "home", "orphan"]);
  const flat = flattenProjectForest(forest).map(({ node, depth }) => `${depth}:${node.id}`);
  assert.deepEqual(flat, ["1:atlas", "2:launch", "2:research", "3:interviews", "4:transcripts", "1:home", "1:orphan"]);
});

test("inheritance: a lone project is exactly itself", () => {
  const merged = mergeInheritedProjectContext([{ name: "Home", instructions: "Budget in euros.", files: [{ fileName: "a.txt" }] }]);
  assert.deepEqual(merged, { name: "Home", instructions: "Budget in euros.", files: [{ fileName: "a.txt" }] });
  assert.equal(mergeInheritedProjectContext([]), null);
});

test("inheritance: parent instructions and files come first, the folder's own last", () => {
  const merged = mergeInheritedProjectContext([
    { name: "Atlas", instructions: "Answer as a staff engineer.", files: [{ fileName: "architecture.pdf", extractedText: "A" }] },
    { name: "Research", instructions: "", files: [] },
    { name: "Interviews", instructions: "Quote people exactly.", files: [{ fileName: "notes.md", extractedText: "N" }] },
  ]);
  assert.ok(merged);
  assert.equal(merged.name, "Interviews");
  const atlas = merged.instructions.indexOf("Answer as a staff engineer.");
  const own = merged.instructions.indexOf("Quote people exactly.");
  assert.ok(atlas >= 0 && own > atlas, "the parent's rule is read before the folder's own");
  assert.match(merged.instructions, /From the folder "Atlas"/);
  assert.doesNotMatch(merged.instructions, /Research/, "a level with no instructions adds no heading");
  assert.deepEqual(merged.files.map((file) => file.fileName), ["architecture.pdf", "notes.md"]);

  // And the prompt the chat route builds from it carries both, in that order.
  const prompt = buildProjectContext(merged);
  assert.ok(prompt.indexOf("staff engineer") < prompt.indexOf("Quote people"));
  const files = buildProjectReferenceFiles(merged);
  assert.ok(files.indexOf("architecture.pdf") < files.indexOf("notes.md"));
});

test("inheritance: a folder with no instructions of its own still gets its parent's", () => {
  const merged = mergeInheritedProjectContext([
    { name: "Atlas", instructions: "Prefer Postgres.", files: [] },
    { name: "Launch", instructions: "  ", files: [] },
  ]);
  assert.match(merged!.instructions, /Prefer Postgres\./);
});

test("the routes apply the rules (moves validated, deletes planned, chats inherit)", () => {
  const detail = read("src/app/api/projects/[id]/route.ts");
  assert.match(detail, /validateProjectMove\(/, "PATCH parentId is cycle- and depth-checked");
  assert.match(detail, /deleteProjectFolder\(/, "DELETE plans the children");
  assert.match(detail, /children"\) === "cascade"/, "cascade only when asked");
  const list = read("src/app/api/projects/route.ts");
  assert.match(list, /validateNewChild\(/, "a new subfolder is depth-checked");
  const chat = read("src/app/api/chat/route.ts");
  assert.match(chat, /loadProjectLineage\(/, "a chat in a folder inherits its lineage");
  const sync = read("src/app/api/v1/mutations/route.ts");
  assert.match(sync, /where: \{ parentId: op\.entityId, userId: accountId \}/, "sync deletes lift children too");
  const migration = read("prisma/migrations/20261003150000_project_subfolders/migration.sql");
  assert.match(migration, /ON DELETE SET NULL/);
  assert.match(migration, /"parentId" <> "id"/);
});
