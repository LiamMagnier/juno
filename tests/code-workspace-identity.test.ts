import assert from "node:assert/strict";
import test from "node:test";
import { planWorkspaceMirror, type ExistingWorkspaceRow } from "../src/lib/code-workspaces";

/*
 * W5 — workspace identity vs. local paths. The mirror-sync reconciliation is
 * the contract's core: (userId, key) matches first, path is the fallback, and
 * pre-key clients must observe EXACTLY the historical path-based behavior.
 */

const row = (id: string, path: string, key: string | null = null, name = id): ExistingWorkspaceRow => ({
  id,
  name,
  path,
  key,
});

test("key-less snapshot keeps the historical path-based mirror semantics", () => {
  const existing = [row("a", "/Users/x/juno"), row("b", "/Users/x/old")];
  const plan = planWorkspaceMirror(existing, [
    { id: "a2", name: "Juno", path: "/Users/x/juno" },
    { id: "c", name: "Fresh", path: "/Users/x/fresh" },
  ]);

  // /old is not in the snapshot → pruned; /juno updates in place; /fresh is new.
  assert.deepEqual(plan.deleteIds, ["b"]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "a"); // matched by path — keeps its row id
  assert.equal(plan.updates[0].pathChanged, false);
  assert.equal(plan.updates[0].data.key, undefined); // no key invented
  assert.equal(plan.creates.length, 1);
  assert.deepEqual(
    { id: plan.creates[0].id, path: plan.creates[0].path, key: plan.creates[0].key },
    { id: "c", path: "/Users/x/fresh", key: null }
  );
});

test("key match wins over path: a moved folder keeps its server row", () => {
  const existing = [row("a", "/Users/x/juno", "wk-1")];
  const plan = planWorkspaceMirror(existing, [
    { id: "ignored", name: "Juno", path: "/Users/x/projects/juno", key: "wk-1" },
  ]);

  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "a"); // identity preserved across the move
  assert.equal(plan.updates[0].pathChanged, true);
  assert.equal(plan.updates[0].data.path, "/Users/x/projects/juno");
  assert.equal(plan.updates[0].data.key, "wk-1");
});

test("first keyed sync adopts keys onto existing path-matched rows", () => {
  const existing = [row("a", "/Users/x/juno")];
  const plan = planWorkspaceMirror(existing, [{ id: "a", name: "Juno", path: "/Users/x/juno", key: "wk-1" }]);

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "a");
  assert.equal(plan.updates[0].data.key, "wk-1"); // upgraded in place, no fork
  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.creates.length, 0);
});

test("a key-less client never strips keys minted by a newer client", () => {
  const existing = [row("a", "/Users/x/juno", "wk-1")];
  const plan = planWorkspaceMirror(existing, [{ id: "a", name: "Juno", path: "/Users/x/juno" }]);

  assert.equal(plan.updates.length, 1);
  assert.ok(!("key" in plan.updates[0].data)); // key column untouched
  assert.deepEqual(plan.deleteIds, []);
});

test("a keyed row moving onto a stale row's path displaces the stale row", () => {
  // wk-1 moved /old → /new, but an unkeyed leftover row still sits at /new.
  const existing = [row("a", "/Users/x/old", "wk-1"), row("stale", "/Users/x/new")];
  const plan = planWorkspaceMirror(existing, [{ id: "a", name: "Juno", path: "/Users/x/new", key: "wk-1" }]);

  assert.deepEqual(plan.deleteIds, ["stale"]); // deleted BEFORE the path update lands
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "a");
  assert.equal(plan.updates[0].data.path, "/Users/x/new");
});

test("swapped paths mark both updates as pathChanged so the route can vacate first", () => {
  const existing = [row("a", "/x", "ka"), row("b", "/y", "kb")];
  const plan = planWorkspaceMirror(existing, [
    { id: "a", name: "A", path: "/y", key: "ka" },
    { id: "b", name: "B", path: "/x", key: "kb" },
  ]);

  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.updates.length, 2);
  assert.ok(plan.updates.every((u) => u.pathChanged));
});

test("unclaimed rows are pruned regardless of how the survivors matched", () => {
  const existing = [row("a", "/x", "ka"), row("b", "/y", "kb"), row("c", "/z")];
  const plan = planWorkspaceMirror(existing, [{ id: "a", name: "A", path: "/x", key: "ka" }]);

  assert.deepEqual([...plan.deleteIds].sort(), ["b", "c"]);
});

test("duplicate snapshot entries coalesce instead of double-claiming", () => {
  const existing = [row("a", "/x", "ka")];
  const plan = planWorkspaceMirror(existing, [
    { id: "a", name: "A", path: "/x", key: "ka" },
    { id: "a", name: "A again", path: "/x", key: "ka" }, // duplicate — first wins
    { id: "n", name: "New", path: "/n", key: "kn" },
    { id: "n2", name: "New dup", path: "/n", key: "kn" }, // duplicate create
  ]);

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].data.name, "A");
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].id, "n");
});

test("a different key on the same path forks instead of rewriting identity", () => {
  // Two machines, same absolute path, each with its own minted key. Adopting
  // wk-b onto wk-a's row would mutate a live workspace's identity and orphan
  // every session keyed wk-a. Identity wins: the item forks its own row and
  // the unmatched row is pruned by mirror-replace.
  const existing = [row("a", "/Users/x/app", "wk-a")];
  const plan = planWorkspaceMirror(existing, [{ id: "b", name: "App", path: "/Users/x/app", key: "wk-b" }]);

  assert.equal(plan.updates.length, 0); // wk-a's row is never rewritten
  assert.deepEqual(plan.deleteIds, ["a"]); // deleted BEFORE the create lands
  assert.equal(plan.creates.length, 1);
  assert.deepEqual(
    { id: plan.creates[0].id, path: plan.creates[0].path, key: plan.creates[0].key },
    { id: "b", path: "/Users/x/app", key: "wk-b" }
  );
});

test("the forked snapshot converges: re-pushing it is a no-op key match", () => {
  // Second heartbeat from the same device — the fork above now exists, so the
  // item matches by key and nothing is created or pruned. Without this the two
  // devices ping-pong the key on every sync.
  const existing = [row("b", "/Users/x/app", "wk-b")];
  const plan = planWorkspaceMirror(existing, [{ id: "b", name: "App", path: "/Users/x/app", key: "wk-b" }]);

  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "b");
  assert.equal(plan.updates[0].data.key, "wk-b");
  assert.equal(plan.updates[0].pathChanged, false);
});

test("a keyed item never adopts a path row that already holds another key", () => {
  // The keyed row is claimed by its own item, so the path fallback must not
  // hand it to the second item as well; that item forks at its own path.
  const existing = [row("a", "/x", "wk-a")];
  const plan = planWorkspaceMirror(existing, [
    { id: "a", name: "A", path: "/x", key: "wk-a" },
    { id: "b", name: "B", path: "/y", key: "wk-b" },
  ]);

  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].data.key, "wk-a");
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].key, "wk-b");
});

test("a pre-key client still path-matches a keyed row without touching its key", () => {
  // The narrowed fallback must not regress pre-key clients: key-less items
  // keep matching ANY path row, keyed or not.
  const existing = [row("a", "/x", "wk-a")];
  const plan = planWorkspaceMirror(existing, [{ id: "a", name: "Renamed", path: "/x" }]);

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "a");
  assert.ok(!("key" in plan.updates[0].data));
  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.creates.length, 0);
});

test("keyed items never steal a row another item already claimed by path", () => {
  // Item 1 (key-less) claims /x by path; item 2's unknown key would create a
  // row on the SAME path — a malformed snapshot. First occurrence wins and
  // the colliding create is dropped, so the apply can't trip the path unique.
  const existing = [row("a", "/x")];
  const plan = planWorkspaceMirror(existing, [
    { id: "a", name: "A", path: "/x" },
    { id: "b", name: "B", path: "/x", key: "kb" },
  ]);

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "a");
  assert.equal(plan.creates.length, 0);
});
