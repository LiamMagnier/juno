import test from "node:test";
import assert from "node:assert/strict";
import {
  CollaborativeCRDTDocument,
  type CRDTOperation,
} from "../src/lib/collaboration/crdt.js";

test("CRDT converges deterministically with concurrent inserts from 2 peers", () => {
  const docA = new CollaborativeCRDTDocument("doc-1", "peerA", "Hello");
  const docB = new CollaborativeCRDTDocument("doc-1", "peerB", "Hello");

  // Peer A inserts " World" at position 5
  const opsA = docA.localInsert(5, " World");

  // Peer B inserts " Beautiful" at position 5
  const opsB = docB.localInsert(5, " Beautiful");

  // Cross-apply operations
  for (const op of opsB) {
    docA.applyOperation(op);
  }
  for (const op of opsA) {
    docB.applyOperation(op);
  }

  assert.equal(docA.getText(), docB.getText());
  assert.ok(docA.getText().includes("Hello"));
  assert.ok(docA.getText().includes("World"));
  assert.ok(docA.getText().includes("Beautiful"));
});

test("CRDT converges under arbitrary operation reordering and duplicates (3 peers)", () => {
  const docA = new CollaborativeCRDTDocument("doc-1", "peerA", "Start");
  const docB = new CollaborativeCRDTDocument("doc-1", "peerB", "Start");
  const docC = new CollaborativeCRDTDocument("doc-1", "peerC", "Start");

  const opsA = docA.localInsert(5, " [A]");
  const opsB = docB.localInsert(0, "[B] ");
  const opsC = docC.localInsert(5, " [C]");

  const allOps = [...opsA, ...opsB, ...opsC];

  // Shuffle order 1 for peer B
  const order1 = [...allOps].reverse();
  for (const op of order1) {
    docB.applyOperation(op);
  }

  // Interleaved order for peer A with duplicate deliveries
  const order2 = [opsC[0], opsA[0], opsB[0], opsA[0], opsB[1] || opsA[0], ...allOps];
  for (const op of order2) {
    docA.applyOperation(op);
  }

  // In-order for peer C
  for (const op of allOps) {
    docC.applyOperation(op);
  }

  // All three must have identical text
  assert.equal(docA.getText(), docB.getText());
  assert.equal(docB.getText(), docC.getText());
});

test("CRDT handles concurrent inserts and deletes with tombstones", () => {
  const docA = new CollaborativeCRDTDocument("doc-1", "peerA", "ABCDEFG");
  const docB = new CollaborativeCRDTDocument("doc-1", "peerB", "ABCDEFG");

  // Peer A deletes "CD" (index 2, length 2)
  const opsA = docA.localDelete(2, 2);

  // Peer B concurrently inserts "XYZ" after "C" (index 3)
  const opsB = docB.localInsert(3, "XYZ");

  // Exchange ops
  for (const op of opsB) docA.applyOperation(op);
  for (const op of opsA) docB.applyOperation(op);

  assert.equal(docA.getText(), docB.getText());
  assert.ok(!docA.getText().includes("CD"));
  assert.ok(docA.getText().includes("XYZ"));
});

test("CRDT randomized property fuzz test converges across multiple permutations", () => {
  for (let run = 0; run < 10; run++) {
    const doc1 = new CollaborativeCRDTDocument("fuzz", "p1", "Initial");
    const doc2 = new CollaborativeCRDTDocument("fuzz", "p2", "Initial");

    const ops1 = doc1.localInsert(Math.floor(Math.random() * 7), `_X${run}_`);
    const ops2 = doc2.localInsert(Math.floor(Math.random() * 7), `_Y${run}_`);
    const del1 = doc1.localDelete(0, 1);

    const pool: CRDTOperation[] = [...ops1, ...ops2, ...del1];

    // Peer 1 applies pool in random order
    const p1Order = [...pool].sort(() => Math.random() - 0.5);
    for (const op of p1Order) doc1.applyOperation(op);

    // Peer 2 applies pool in different random order
    const p2Order = [...pool].sort(() => Math.random() - 0.5);
    for (const op of p2Order) doc2.applyOperation(op);

    assert.equal(doc1.getText(), doc2.getText(), `Convergence failed on run ${run}`);
  }
});
