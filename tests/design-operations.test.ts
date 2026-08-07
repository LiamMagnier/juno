import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTransaction,
  DesignOperationError,
  invertTransaction,
  transactionIsScopedTo,
  type DesignOperation,
} from "../src/lib/design/operations";
import { parseDesignDocument, validateHierarchy } from "../src/lib/design/schema";
import { serializeDesignDocument } from "../src/lib/design/migrations";
import { PAGE_ID, run, signInDocument, transaction } from "./design-fixtures";

test("a created node lands in its parent, in order, and validates", () => {
  const doc = signInDocument();
  const card = doc.nodes["card"];
  assert.equal(card.type, "frame");
  assert.deepEqual("children" in card ? card.children : [], ["title", "email", "button"]);
  assert.equal(doc.nodes["title"].parentId, "card");
  assert.deepEqual(validateHierarchy(doc), []);
  assert.equal(doc.revision, 1);
});

test("updateNode inverts exactly, and only the named fields move", () => {
  const doc = signInDocument();
  const before = { ...doc.nodes["button"] };

  const result = run(doc, [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }]);
  assert.equal(result.document.nodes["button"].cornerRadius, 12);
  assert.equal(result.document.nodes["button"].width, before.width, "width must not move");
  assert.deepEqual(result.touchedNodeIds, ["button"]);

  const undone = applyTransaction(
    result.document,
    invertTransaction(result, transaction([{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }], { baseRevision: 0 }), "2026-01-01T00:00:01.000Z")
  );
  assert.equal(undone.document.nodes["button"].cornerRadius, before.cornerRadius);
});

test("undo/redo round-trips a multi-operation transaction byte for byte", () => {
  const doc = signInDocument();
  const operations: DesignOperation[] = [
    { op: "updateNode", nodeId: "button", patch: { cornerRadius: 12, height: 56 } },
    { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "Continue" } },
    { op: "setConstraints", nodeIds: ["button"], constraints: { horizontal: "stretch", vertical: "min" } },
  ];
  const source = transaction(operations, { baseRevision: doc.revision, summary: "Restyle the button" });
  const applied = applyTransaction(doc, source);
  const undone = applyTransaction(applied.document, invertTransaction(applied, source, "2026-01-01T00:00:02.000Z"));

  // Revision and timestamp legitimately differ; the scene must not.
  const strip = (d: typeof doc) => serializeDesignDocument({ ...d, revision: 0, updatedAt: "" });
  assert.equal(strip(undone.document), strip(doc));

  const redone = applyTransaction(undone.document, { ...source, baseRevision: undone.document.revision, id: "redo" });
  assert.equal(redone.document.nodes["button"].cornerRadius, 12);
  const relabelled = redone.document.nodes["buttonLabel"];
  assert.equal(relabelled.type === "text" ? relabelled.characters : null, "Continue");
});

test("deleting a subtree restores the whole subtree, in order, on undo", () => {
  const doc = signInDocument();
  const source = transaction([{ op: "deleteNodes", nodeIds: ["card"] }], { baseRevision: doc.revision });
  const deleted = applyTransaction(doc, source);

  assert.equal(deleted.document.nodes["card"], undefined);
  assert.equal(deleted.document.nodes["buttonLabel"], undefined, "descendants go with the root");
  assert.deepEqual(deleted.document.nodes["screen"].type === "frame" ? deleted.document.nodes["screen"].children : null, []);

  const restored = applyTransaction(deleted.document, invertTransaction(deleted, source, "2026-01-01T00:00:03.000Z"));
  const card = restored.document.nodes["card"];
  assert.ok(card);
  assert.deepEqual("children" in card ? card.children : [], ["title", "email", "button"]);
  assert.equal(restored.document.nodes["buttonLabel"].parentId, "button");
  assert.deepEqual(validateHierarchy(restored.document), []);
});

test("a transaction is atomic: a failing operation leaves nothing behind", () => {
  const doc = signInDocument();
  assert.throws(
    () =>
      run(doc, [
        { op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } },
        { op: "updateNode", nodeId: "does-not-exist", patch: { cornerRadius: 4 } },
      ]),
    DesignOperationError
  );
  assert.equal(doc.nodes["button"].cornerRadius, 8, "the first operation must not have landed");
  assert.equal(doc.revision, 1);
});

test("a stale baseRevision is refused as a conflict, not rebased", () => {
  const doc = signInDocument();
  const first = run(doc, [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }]);
  assert.throws(
    () =>
      applyTransaction(
        first.document,
        transaction([{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 20 } }], { baseRevision: doc.revision })
      ),
    (err: unknown) => err instanceof DesignOperationError && err.code === "conflict"
  );
});

test("locked nodes refuse writes", () => {
  const doc = run(signInDocument(), [{ op: "updateNode", nodeId: "email", patch: { locked: true } }]).document;
  assert.throws(
    () => run(doc, [{ op: "updateNode", nodeId: "email", patch: { width: 10 } }]),
    (err: unknown) => err instanceof DesignOperationError && err.code === "locked"
  );
});

test("a patch naming a field the node type has not is rejected", () => {
  const doc = signInDocument();
  assert.throws(
    () => run(doc, [{ op: "updateNode", nodeId: "email", patch: { characters: "nope" } }]),
    /rectangle nodes have no/
  );
});

test("reparenting into a descendant is refused as a cycle", () => {
  const doc = signInDocument();
  assert.throws(
    () => run(doc, [{ op: "reparentNodes", nodeIds: ["card"], newParentId: "button", pageId: PAGE_ID }]),
    (err: unknown) => err instanceof DesignOperationError && err.code === "cycle"
  );
});

test("reorder moves z-order within the parent and inverts to the original index", () => {
  const doc = signInDocument();
  const source = transaction([{ op: "reorderNodes", nodeIds: ["title"], to: "front" }], { baseRevision: doc.revision });
  const moved = applyTransaction(doc, source);
  const card = moved.document.nodes["card"];
  assert.deepEqual("children" in card ? card.children : [], ["email", "button", "title"]);

  const undone = applyTransaction(moved.document, invertTransaction(moved, source, "2026-01-01T00:00:04.000Z"));
  const back = undone.document.nodes["card"];
  assert.deepEqual("children" in back ? back.children : [], ["title", "email", "button"]);
});

test("reorder keeps a multi-selection stable and restores exact order on undo", () => {
  for (const to of ["front", "back", "forward", "backward"] as const) {
    const doc = signInDocument();
    const source = transaction([{ op: "reorderNodes", nodeIds: ["button", "title"], to }], { baseRevision: doc.revision });
    const moved = applyTransaction(doc, source);
    const children = moved.document.nodes["card"];
    assert.equal(children.type, "frame");

    const expected = {
      front: ["email", "title", "button"],
      back: ["title", "button", "email"],
      forward: ["email", "title", "button"],
      backward: ["title", "button", "email"],
    }[to];
    assert.deepEqual(children.children, expected, `${to} preserves document order inside the selection`);

    const undone = applyTransaction(moved.document, invertTransaction(moved, source, "2026-01-01T00:00:05.000Z"));
    const restored = undone.document.nodes["card"];
    assert.equal(restored.type, "frame");
    assert.deepEqual(restored.children, ["title", "email", "button"], `${to} undo restores every sibling`);
  }
});

test("a boundary reorder has a valid no-op inverse", () => {
  const doc = signInDocument();
  const source = transaction([{ op: "reorderNodes", nodeIds: ["title"], to: "back" }], { baseRevision: doc.revision });
  const moved = applyTransaction(doc, source);
  const undone = applyTransaction(moved.document, invertTransaction(moved, source, "2026-01-01T00:00:06.000Z"));
  const card = undone.document.nodes["card"];
  assert.equal(card.type, "frame");
  assert.deepEqual(card.children, ["title", "email", "button"]);
});

test("group then ungroup returns the original geometry", () => {
  const doc = signInDocument();
  const grouped = run(doc, [{ op: "groupNodes", nodeIds: ["title", "email"], groupId: "grp" }]);
  const group = grouped.document.nodes["grp"];
  assert.ok(group);
  assert.equal(grouped.document.nodes["title"].parentId, "grp");

  const ungrouped = run(grouped.document, [{ op: "ungroupNodes", nodeIds: ["grp"] }]);
  assert.equal(ungrouped.document.nodes["grp"], undefined);
  assert.equal(ungrouped.document.nodes["title"].parentId, "card");
  assert.equal(ungrouped.document.nodes["title"].x, doc.nodes["title"].x);
  assert.equal(ungrouped.document.nodes["title"].y, doc.nodes["title"].y);
});

test("duplicate mints fresh ids for the whole subtree and leaves the original alone", () => {
  const doc = signInDocument();
  const result = run(doc, [{ op: "duplicateNodes", nodeIds: ["button"] }]);
  const copyId = result.selection?.[0];
  assert.ok(copyId && copyId !== "button");
  const copy = result.document.nodes[copyId];
  assert.equal(copy.parentId, "card");
  assert.equal(copy.name, "Sign in button copy");
  const copiedLabelId = "children" in copy ? copy.children[0] : null;
  assert.ok(copiedLabelId && copiedLabelId !== "buttonLabel");
  assert.equal(result.document.nodes["buttonLabel"].parentId, "button", "the original is untouched");
  assert.deepEqual(validateHierarchy(result.document), []);
});

test("replaying the same transaction produces identical ids", () => {
  const doc = signInDocument();
  const source = transaction([{ op: "duplicateNodes", nodeIds: ["email"] }], { baseRevision: doc.revision, id: "fixed-id" });
  const a = applyTransaction(doc, source);
  const b = applyTransaction(doc, source);
  assert.deepEqual(a.selection, b.selection);
  assert.equal(serializeDesignDocument(a.document), serializeDesignDocument(b.document));
});

test("selection scoping catches a transaction that wandered outside the selection", () => {
  const doc = signInDocument();
  const inScope = run(doc, [
    { op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } },
    { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "Go" } },
  ]);
  assert.deepEqual(transactionIsScopedTo(doc, inScope, ["button"]), { ok: true });

  const outOfScope = run(doc, [
    { op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } },
    { op: "updateNode", nodeId: "email", patch: { height: 60 } },
  ]);
  const verdict = transactionIsScopedTo(doc, outOfScope, ["button"]);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.ok === false ? verdict.strayIds : [], ["email"]);
});

test("a node created under the selection counts as in scope", () => {
  const doc = signInDocument();
  const result = run(doc, [
    { op: "createNode", parentId: "button", pageId: PAGE_ID, node: { type: "ellipse", id: "spinner", name: "Spinner" } },
  ]);
  assert.deepEqual(transactionIsScopedTo(doc, result, ["button"]), { ok: true });
});

test("setSelection changes selection and writes nothing", () => {
  const doc = signInDocument();
  const result = run(doc, [{ op: "setSelection", nodeIds: ["title", "email", "ghost"] }]);
  assert.deepEqual(result.selection, ["title", "email"], "unknown ids are dropped, not invented");
  assert.deepEqual(result.touchedNodeIds, []);
});

test("component creation converts the node and inverts back to a frame", () => {
  const doc = signInDocument();
  const source = transaction([{ op: "createComponent", nodeId: "button", componentId: "cmp1", name: "Primary button" }], {
    baseRevision: doc.revision,
  });
  const made = applyTransaction(doc, source);
  assert.equal(made.document.nodes["button"].type, "component");
  assert.equal(made.document.components["cmp1"].rootNodeId, "button");

  const undone = applyTransaction(made.document, invertTransaction(made, source, "2026-01-01T00:00:05.000Z"));
  assert.equal(undone.document.nodes["button"].type, "frame");
  assert.equal(undone.document.components["cmp1"], undefined);
});

test("instances copy the main component's subtree with fresh ids", () => {
  let doc = run(signInDocument(), [{ op: "createComponent", nodeId: "button", componentId: "cmp1", name: "Primary button" }]).document;
  const result = run(doc, [{ op: "createInstance", componentId: "cmp1", parentId: "screen", pageId: PAGE_ID, instanceId: "inst1", x: 24, y: 600 }]);
  doc = result.document;
  const instance = doc.nodes["inst1"];
  assert.equal(instance.type, "instance");
  assert.equal(instance.type === "instance" ? instance.componentId : null, "cmp1");
  const childId = "children" in instance ? instance.children[0] : null;
  assert.ok(childId && childId !== "buttonLabel");
  assert.equal(doc.nodes[childId!].type, "text");
  assert.deepEqual(validateHierarchy(doc), []);
});

test("a document survives a JSON round trip through the schema", () => {
  const doc = signInDocument();
  const round = parseDesignDocument(JSON.parse(serializeDesignDocument(doc)));
  assert.equal(serializeDesignDocument(round), serializeDesignDocument(doc));
});

test("a locked layer can be unlocked, and hidden and shown while locked", () => {
  // Locking used to be one-way and therefore destructive. `updateNode` refused
  // every patch to a locked node, including the patch that clears `locked` —
  // so the flag gated itself, and because the canvas cannot hit-test a locked
  // layer, nothing could select it either. The layer was gone with no way back.
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "button", patch: { locked: true } },
  ]).document;

  assert.equal(
    run(doc, [{ op: "updateNode", nodeId: "button", patch: { locked: false } }]).document.nodes
      .button.locked,
    false,
    "the padlock has to be able to come off"
  );
  assert.equal(
    run(doc, [{ op: "updateNode", nodeId: "button", patch: { visible: false } }]).document.nodes
      .button.visible,
    false,
    "visibility is the other field that decides reachability"
  );

  // The exemption is exactly two fields. Anything else riding along with them
  // would be a way to move or restyle a layer past its own lock.
  assert.throws(
    () => run(doc, [{ op: "updateNode", nodeId: "button", patch: { locked: false, x: 10 } }]),
    /is locked/
  );
});

test("undoing an unlock passes the same gate it did", () => {
  // The inverse of `{locked:false}` is `{locked:true}`, which names only the
  // exempt fields — so undo cannot be the thing that gets stuck.
  const locked = run(signInDocument(), [
    { op: "updateNode", nodeId: "button", patch: { locked: true } },
  ]).document;
  const unlock = run(locked, [{ op: "updateNode", nodeId: "button", patch: { locked: false } }]);
  assert.deepEqual(unlock.inverse, [{ op: "updateNode", nodeId: "button", patch: { locked: true } }]);
  const redone = run(unlock.document, unlock.inverse).document;
  assert.equal(redone.nodes.button.locked, true);
});
