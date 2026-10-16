import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptedVersionTimes,
  impliedParents,
  isRefusal,
  pathTo,
  planFork,
  planSelect,
  replaceBranchTail,
  restoreImportedBranches,
  shownLeaf,
  shownPath,
  siblingPositions,
  type BranchChange,
  type BranchNode,
} from "@/lib/chat/branch-model";
import { firstArrivalAfterHeld } from "@/lib/chat/transcript-window";

/*
 * BRANCHES IN A CONVERSATION, WITHOUT A DATABASE (G03, G50).
 *
 * Editing a question or regenerating an answer adds a sibling and keeps the old
 * one with everything after it. These are the rules src/lib/chat/branches.ts
 * applies inside one transaction; `apply` below stands in for its writes.
 */

const t0 = Date.UTC(2026, 9, 1);
const node = (id: string, at: number, extra: Partial<BranchNode> = {}): BranchNode => ({
  id,
  parentId: null,
  branchGroupId: null,
  branchSelected: true,
  onActivePath: true,
  createdAt: new Date(t0 + at * 1000),
  ...extra,
});

/** A linear thread written by code that knows nothing about branches: no parent pointers. */
function linear(ids: string[]): BranchNode[] {
  return ids.map((id, i) => node(id, i));
}

/** The writes a plan describes, applied the way branches.ts applies them. */
function apply(nodes: BranchNode[], change: BranchChange, added?: BranchNode): BranchNode[] {
  const out = nodes.map((n) => {
    const next = { ...n };
    if (change.parents.has(n.id)) next.parentId = change.parents.get(n.id)!;
    if (change.groups.has(n.id)) next.branchGroupId = change.groups.get(n.id)!;
    if (change.deactivate.has(n.id)) next.onActivePath = false;
    if (change.activate.has(n.id)) next.onActivePath = true;
    if (change.unselect.has(n.id)) next.branchSelected = false;
    if (change.select.has(n.id)) next.branchSelected = true;
    return next;
  });
  return added ? [...out, added] : out;
}

/** Fork `target` with a new row written at `at`, as the edit route and the regenerate writer do. */
function fork(nodes: BranchNode[], target: string, id: string, at: number): BranchNode[] {
  const plan = planFork(nodes, target);
  assert.ok(!isRefusal(plan), `fork of ${target} refused`);
  return apply(nodes, plan.change, node(id, at, { parentId: plan.parentId, branchGroupId: plan.groupId, branchSelected: plan.shown, onActivePath: plan.shown }));
}

function select(nodes: BranchNode[], id: string): BranchNode[] {
  const plan = planSelect(nodes, id);
  assert.ok(!isRefusal(plan), `select of ${id} refused`);
  return apply(nodes, plan.change);
}

const shown = (nodes: BranchNode[]) => shownPath(nodes).map((n) => n.id);

test("an unwritten parent is the previous shown message; the first one is a root", () => {
  const nodes = linear(["u1", "a1", "u2", "a2"]);
  assert.deepEqual([...impliedParents(nodes)], [["a1", "u1"], ["u2", "a1"], ["a2", "u2"]]);
  // A pointer already written is never rewritten.
  const written = nodes.map((n) => (n.id === "u2" ? { ...n, parentId: "a1" } : n));
  assert.equal(impliedParents(written).has("u2"), false);
});

test("editing a question keeps the old wording and every answer after it, off the shown path", () => {
  const before = linear(["u1", "a1", "u2", "a2", "u3", "a3"]);
  const plan = planFork(before, "u2");
  assert.ok(!isRefusal(plan));
  assert.deepEqual(plan.hidden, ["u2", "a2", "u3", "a3"], "the target and everything after it");
  assert.equal(plan.parentId, "a1", "the new wording follows the same answer");
  assert.equal(plan.groupId, "u2", "the group is named after the first alternative");
  assert.deepEqual([...plan.change.groups], [["u2", "u2"]]);
  assert.deepEqual([...plan.change.unselect], ["u2"]);
  // Pointers are written down before anything leaves the path.
  assert.equal(plan.change.parents.get("a3"), "u3");

  const after = fork(before, "u2", "u2b", 10);
  assert.deepEqual(shown(after), ["u1", "a1", "u2b"]);
  assert.equal(after.length, 7, "nothing is deleted");
});

test("editing the first question makes a root sibling", () => {
  const after = fork(linear(["u1", "a1"]), "u1", "u1b", 10);
  const plan = planFork(linear(["u1", "a1"]), "u1");
  assert.ok(!isRefusal(plan));
  assert.equal(plan.parentId, null);
  assert.deepEqual(shown(after), ["u1b"]);
});

test("switching back shows the old branch whole, and forward again the new one", () => {
  let nodes = fork(linear(["u1", "a1", "u2", "a2", "u3", "a3"]), "u2", "u2b", 10);
  nodes = [...nodes, node("a2b", 11)]; // the answer to the new wording, appended by the pipeline
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2b", "a2b"]);

  const back = planSelect(nodes, "u2");
  assert.ok(!isRefusal(back));
  assert.equal(back.replacedId, "u2b");
  assert.deepEqual(back.path, ["u2", "a2", "u3", "a3"]);
  nodes = apply(nodes, back.change);
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2", "a2", "u3", "a3"]);

  nodes = select(nodes, "u2b");
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2b", "a2b"], "the new branch's answer was recorded under it");
});

test("a branch remembers the choices made inside it while it is hidden", () => {
  let nodes = linear(["u1", "a1", "u2", "a2"]);
  nodes = fork(nodes, "a2", "a2b", 10); // regenerate the newest answer
  nodes = fork(nodes, "a2b", "a2c", 11); // and again
  nodes = select(nodes, "a2b"); // the reader prefers the second answer
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2", "a2b"]);

  nodes = fork(nodes, "u2", "u2x", 12); // edit the question above it
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2x"]);
  nodes = select(nodes, "u2"); // and go back
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2", "a2b"], "the second answer, as it was left");
});

test("regenerating an earlier answer branches at that turn", () => {
  let nodes = linear(["u1", "a1", "u2", "a2", "u3", "a3"]);
  const plan = planFork(nodes, "a1");
  assert.ok(!isRefusal(plan));
  assert.equal(plan.parentId, "u1");
  assert.deepEqual(plan.hidden, ["a1", "u2", "a2", "u3", "a3"]);
  nodes = fork(nodes, "a1", "a1b", 10);
  assert.deepEqual(shown(nodes), ["u1", "a1b"]);
  const positions = siblingPositions(nodes);
  assert.deepEqual(positions.get("a1b"), { index: 1, siblingIds: ["a1", "a1b"] });
  assert.deepEqual(positions.get("a1"), { index: 0, siblingIds: ["a1", "a1b"] });
  assert.equal(positions.has("u1"), false, "a message with no alternatives has no pager");
});

test("a fork of a hidden message is refused unless a late regenerate asks to join hidden", () => {
  const nodes = fork(linear(["u1", "a1", "u2", "a2"]), "u2", "u2b", 10);
  assert.deepEqual(planFork(nodes, "a2"), { refused: "off_path" });
  assert.deepEqual(planFork(nodes, "nope"), { refused: "missing" });
  const late = planFork(nodes, "a2", { allowOffPath: true });
  assert.ok(!isRefusal(late));
  assert.equal(late.shown, false);
  assert.equal(late.change.deactivate.size, 0, "the shown branch is not touched");
  assert.equal(late.parentId, "u2");
});

test("switching is refused for a message with no alternatives or on a hidden branch, and is a no-op for the shown one", () => {
  let nodes = linear(["u1", "a1", "u2", "a2"]);
  const same = planSelect(nodes, "a1");
  assert.ok(!isRefusal(same));
  assert.equal(same.changed, false);
  nodes = fork(nodes, "a2", "a2b", 10);
  nodes = fork(nodes, "u2", "u2b", 11);
  // a2/a2b's group sits on the hidden branch now.
  assert.deepEqual(planSelect(nodes, "a2"), { refused: "off_path" });
  assert.deepEqual(planSelect(nodes, "missing"), { refused: "missing" });
  const hiddenPlain = node("x", 20, { onActivePath: false });
  assert.deepEqual(planSelect([...nodes, hiddenPlain], "x"), { refused: "no_branch" });
});

test("the path to a message follows written pointers on hidden branches and order on the shown one", () => {
  let nodes = linear(["u1", "a1", "u2", "a2"]);
  nodes = fork(nodes, "u2", "u2b", 10);
  nodes = [...nodes, node("a2b", 11)];
  assert.deepEqual(pathTo(nodes, "a2"), ["u1", "a1", "u2", "a2"], "a hidden leaf: its ancestors");
  assert.deepEqual(pathTo(nodes, "a2b"), ["u1", "a1", "u2b", "a2b"], "a shown leaf with no pointer yet");
  assert.equal(pathTo(nodes, "nope"), null);
  assert.equal(shownLeaf(nodes), "a2b");
});

test("older wordings adopted as siblings read oldest first, before the current one and after its parent", () => {
  const target = new Date(t0 + 10_000);
  const times = adoptedVersionTimes(target, new Date(t0), 3);
  assert.deepEqual(times.map((d) => d.getTime() - t0), [9_997, 9_998, 9_999]);
  // Never before the parent: a branch made of one still reads in thread order.
  const tight = adoptedVersionTimes(new Date(t0 + 2), new Date(t0), 3);
  assert.ok(tight.every((d) => d.getTime() > t0));
  const positions = siblingPositions([
    { id: "live", branchGroupId: "live", createdAt: target },
    ...times.map((createdAt, i) => ({ id: `v${i}`, branchGroupId: "live", createdAt })),
  ]);
  assert.deepEqual(positions.get("live")?.siblingIds, ["v0", "v1", "v2", "live"]);
});

test("the client keeps every row above the switched turn and replaces the rest", () => {
  const rows = ["u1", "a1", "u2", "a2"].map((id) => ({ id }));
  assert.deepEqual(replaceBranchTail(rows, "u2", [{ id: "u2b" }, { id: "a2b" }]), [{ id: "u1" }, { id: "a1" }, { id: "u2b" }, { id: "a2b" }]);
  assert.equal(replaceBranchTail(rows, "gone", []), null, "not loaded: the caller reads the newest page");
});

test("rows of a new branch rise in; history paged in above and a freshly opened list do not", () => {
  const held = new Set(["u1", "a1", "u2", "a2"]);
  assert.equal(firstArrivalAfterHeld(["u1", "a1", "u2b", "a2b"], held), 2);
  assert.equal(firstArrivalAfterHeld(["u0", "a0", "u1", "a1", "u2", "a2"], held), Number.POSITIVE_INFINITY);
  assert.equal(firstArrivalAfterHeld(["x", "y"], new Set()), Number.POSITIVE_INFINITY);
  assert.equal(firstArrivalAfterHeld(["u1", "a1", "u2", "a2", "u3"], held), 4, "an appended turn");
});

test("an import rebuilds the exported tree in the new rows' ids, and stays linear when it cannot", () => {
  // The export of: u1 a1 u2 a2 (old wording, hidden) and u2' a2' (shown), with
  // a re-exported import's row whose stable id differs from its export id.
  const exported = [
    { sourceId: "x-u1", parentSourceId: null, branchGroupSourceId: null, onActivePath: true },
    { sourceId: "x-a1", parentSourceId: "x-u1", branchGroupSourceId: null, onActivePath: true },
    { sourceId: "x-u2", parentSourceId: "x-a1", branchGroupSourceId: "x-u2", onActivePath: false, branchSelected: false },
    { sourceId: "x-a2", parentSourceId: "x-u2", branchGroupSourceId: null, onActivePath: false },
    { sourceId: "x-u2b", parentSourceId: "x-a1", branchGroupSourceId: "x-u2", onActivePath: true, branchSelected: true },
    { sourceId: "x-a2b", parentSourceId: "x-u2b", branchGroupSourceId: null, onActivePath: true },
  ];
  const rows = exported.map((row, i) => ({ ...row, id: `new-${i}`, createdAt: new Date(t0 + i * 1000) }));
  const restored = restoreImportedBranches(rows)!;
  assert.ok(restored, "a consistent tree is restored");
  const byId = new Map(restored.map((row) => [row.id, row]));
  assert.equal(byId.get("new-2")?.parentId, "new-1");
  assert.equal(byId.get("new-2")?.branchGroupId, "new-2");
  assert.equal(byId.get("new-4")?.branchGroupId, "new-2", "pointers land on the new ids");
  assert.deepEqual(restored.filter((row) => row.onActivePath).map((row) => row.id), ["new-0", "new-1", "new-4", "new-5"]);
  assert.equal(byId.get("new-2")?.branchSelected, false);
  // Switching back works on what was restored, as on a chat made here.
  const nodes = restored.map((row) => ({ ...row, createdAt: rows.find((r) => r.id === row.id)!.createdAt }));
  assert.deepEqual(shown(select(nodes, "new-2")), ["new-0", "new-1", "new-2", "new-3"]);

  assert.equal(restoreImportedBranches(rows.map(({ id, createdAt }) => ({ id, createdAt }))), null, "a linear export has nothing to restore");
  const dangling = rows.map((row) => (row.id === "new-3" ? { ...row, parentSourceId: "not-in-the-file" } : row));
  assert.equal(restoreImportedBranches(dangling), null, "a pointer to a message the file lacks");
  const backwards = rows.map((row) => (row.id === "new-1" ? { ...row, parentSourceId: "x-a2b" } : row));
  assert.equal(restoreImportedBranches(backwards), null, "a child older than its parent");
  const broken = rows.map((row) => (row.id === "new-3" ? { ...row, onActivePath: true } : row));
  assert.equal(restoreImportedBranches(broken), null, "two shown branches are not one line");
});

test("edits, an earlier regenerate and rows written without pointers switch back and forth and keep one line shown", () => {
  /** The shown path in thread order is one chain of parents (an unwritten one means the row before). */
  const oneLine = (nodes: BranchNode[]) => {
    const path = shownPath(nodes);
    if (path.length) assert.equal(path[0].parentId, null, "the path starts at a root");
    for (let i = 1; i < path.length; i++) {
      assert.ok(path[i].parentId === null || path[i].parentId === path[i - 1].id, `${path[i].id} follows ${path[i].parentId}, not ${path[i - 1].id}`);
    }
  };
  // A new question is written with no parent (accept.ts); its answer names it (persist.ts).
  const add = (nodes: BranchNode[], id: string, at: number, parentId: string | null = null) => [...nodes, node(id, at, { parentId })];
  let nodes = linear(["u1", "a1", "u2", "a2"]);
  nodes = fork(nodes, "u2", "u2b", 10);
  nodes = add(nodes, "a2b", 11, "u2b");
  nodes = add(nodes, "u3b", 12);
  nodes = add(nodes, "a3b", 13, "u3b");
  nodes = fork(nodes, "a2b", "a2c", 14);
  oneLine(nodes);
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2b", "a2c"]);
  nodes = select(nodes, "u2");
  oneLine(nodes);
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2", "a2"]);
  nodes = select(nodes, "u2b");
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2b", "a2c"], "the regenerated answer was the one chosen there");
  nodes = select(nodes, "a2b");
  oneLine(nodes);
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2b", "a2b", "u3b", "a3b"]);
  nodes = add(nodes, "u4b", 20);
  nodes = add(nodes, "a4b", 21, "u4b");
  nodes = select(nodes, "u2");
  nodes = select(nodes, "u2b");
  oneLine(nodes);
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2b", "a2b", "u3b", "a3b", "u4b", "a4b"]);
  assert.deepEqual(pathTo(nodes, "a4b"), shown(nodes));
  // An edit of the first question after all that is a third root.
  nodes = fork(nodes, "u1", "u1b", 30);
  oneLine(nodes);
  assert.deepEqual(siblingPositions(nodes).get("u1b"), { index: 1, siblingIds: ["u1", "u1b"] });
  nodes = select(nodes, "u1");
  assert.deepEqual(shown(nodes), ["u1", "a1", "u2b", "a2b", "u3b", "a3b", "u4b", "a4b"]);
});

test("an export of a chat that never branched restores nothing: it imports linear as it is", () => {
  const rows = ["x-u1", "x-a1"].map((sourceId, i) => ({ id: `new-${i}`, createdAt: new Date(t0 + i * 1000), sourceId, parentSourceId: null, branchGroupSourceId: null, onActivePath: true, branchSelected: true }));
  assert.equal(restoreImportedBranches(rows), null);
  // An answer that recorded its question still restores (nothing to change, but nothing wrong either).
  const pointed = rows.map((row, i) => (i === 1 ? { ...row, parentSourceId: "x-u1" } : row));
  assert.deepEqual(restoreImportedBranches(pointed)?.map((row) => row.parentId), [null, "new-0"]);
});
