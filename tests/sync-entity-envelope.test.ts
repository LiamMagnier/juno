import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildEntityEnvelopes, type EntityRevisionRow } from "@/lib/sync-entity-envelope";

/**
 * Regression tests for the real-device blocker: an authenticated iPhone could
 * not complete its initial synchronization and reported "Juno returned malformed
 * synchronization data".
 *
 * The production cause, confirmed by a read-only query against the real account:
 * ten EntityRevision rows (4 artifact, 6 artifact_version) were live
 * (`deletedAt: null`) while their underlying rows no longer existed. Artifacts
 * cascade-delete with their Conversation at the database level, which never runs
 * the application code that would tombstone the revision.
 *
 * Hydration then emitted `data: null` together with `deletedAt: null` — an
 * envelope that is neither live nor tombstoned. The OpenAPI contract says
 * "Tombstoned entities carry deletedAt with data null", and
 * NativeSyncAPIClient.swift:222 enforces exactly that:
 *
 *     guard (item.data == nil) == (deletedAt != nil)
 *
 * so the client was right to refuse it. The server was wrong to send it.
 */
describe("buildEntityEnvelopes — data/deletedAt invariant", () => {
  const revision = (over: Partial<EntityRevisionRow> = {}): EntityRevisionRow => ({
    entityId: "cmrqlaev0000artifact",
    revision: 1,
    deletedAt: null,
    updatedAt: new Date("2026-07-19T09:14:22.000Z"),
    ...over,
  });

  /** The exact production shape that stalled the real device. */
  it("emits a tombstone when a live revision outlives its row", () => {
    const envelopes = buildEntityEnvelopes(
      "artifact",
      ["cmrqlaev0000artifact"],
      new Map(), // the artifact row is gone — cascade-deleted with its conversation
      [revision()],
    );

    assert.equal(envelopes.length, 1);
    const [envelope] = envelopes;
    assert.equal(envelope.data, null);
    assert.notEqual(
      envelope.deletedAt,
      null,
      "data null with deletedAt null is the malformed shape the device rejected",
    );
    assert.equal(envelope.deletedAt, "2026-07-19T09:14:22.000Z");
    assert.equal(envelope.revision, 1);
  });

  it("the invariant holds for every envelope in a mixed production-shaped batch", () => {
    const envelopes = buildEntityEnvelopes(
      "artifact",
      ["live-1", "orphaned-1", "tombstoned-1", "orphaned-2"],
      new Map([["live-1", { id: "live-1", title: "Kept" }]]),
      [
        revision({ entityId: "live-1", revision: 4 }),
        revision({ entityId: "orphaned-1", revision: 1 }),
        revision({
          entityId: "tombstoned-1",
          revision: 2,
          deletedAt: new Date("2026-07-20T10:00:00.000Z"),
        }),
        revision({ entityId: "orphaned-2", revision: 3 }),
      ],
    );

    assert.equal(envelopes.length, 4);
    for (const envelope of envelopes) {
      assert.equal(
        (envelope.data === null),
        (envelope.deletedAt !== null),
        `envelope ${envelope.id} violates (data === null) === (deletedAt !== null)`,
      );
    }
  });

  it("prefers a real deletion time over the fallback", () => {
    const deletedAt = new Date("2026-07-20T10:00:00.000Z");
    const [envelope] = buildEntityEnvelopes(
      "artifact",
      ["gone"],
      new Map(),
      [revision({ entityId: "gone", deletedAt })],
    );

    assert.equal(envelope.deletedAt, deletedAt.toISOString());
  });

  /** Live entities must be unaffected — this fix must not tombstone real data. */
  it("leaves a live entity with data and a null deletedAt", () => {
    const [envelope] = buildEntityEnvelopes(
      "artifact",
      ["live"],
      new Map([["live", { id: "live", title: "Present" }]]),
      [revision({ entityId: "live", revision: 7 })],
    );

    assert.equal(envelope.deletedAt, null);
    assert.notEqual(envelope.data, null);
    assert.equal(envelope.revision, 7);
  });

  /**
   * A live row whose revision was also tombstoned still reports as live: the row
   * is really there, and claiming otherwise would delete real data on the client.
   */
  it("treats a present row as live even when its revision carries deletedAt", () => {
    const [envelope] = buildEntityEnvelopes(
      "artifact",
      ["resurrected"],
      new Map([["resurrected", { id: "resurrected", title: "Back" }]]),
      [revision({ entityId: "resurrected", deletedAt: new Date("2026-07-01T00:00:00.000Z") })],
    );

    assert.equal(envelope.deletedAt, null);
    assert.notEqual(envelope.data, null);
  });

  /** Strictness preserved: unknown ids stay omitted rather than invented. */
  it("omits ids with neither a row nor a revision", () => {
    const envelopes = buildEntityEnvelopes("artifact", ["ghost"], new Map(), []);
    assert.equal(envelopes.length, 0);
  });

  it("preserves requested order and reports revision 0 when only a row exists", () => {
    const envelopes = buildEntityEnvelopes(
      "artifact",
      ["b", "a"],
      new Map([
        ["a", { id: "a" }],
        ["b", { id: "b" }],
      ]),
      [],
    );

    assert.deepEqual(envelopes.map((e) => e.id), ["b", "a"]);
    assert.equal(envelopes[0].revision, 0);
    assert.equal(envelopes[0].deletedAt, null);
  });
});
