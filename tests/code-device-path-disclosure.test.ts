import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicWorkspaces } from "@/lib/code-workspace-privacy";

/**
 * A host registers its workspaces with a real filesystem path, because that is
 * how it finds them again. Nothing outside the host needs it — a workspace is
 * addressed by its stable `key`, with `name` for display.
 *
 * The device list used to return `device.workspaces` verbatim, which handed the
 * account name, the directory layout and usually the project's real identity to
 * every client, including the phone. These pin that it cannot come back.
 */
describe("publicWorkspaces — no path may escape the host", () => {
  it("drops the absolute path and keeps identity", () => {
    const result = publicWorkspaces([
      { name: "juno", path: "/Users/liammagnier/Desktop/workspace/juno", key: "wk_1" },
    ]);

    assert.deepEqual(result, [{ name: "juno", key: "wk_1" }]);
    assert.equal(JSON.stringify(result).includes("/Users/"), false);
  });

  /** A key-less host keeps working; it just loses the path. */
  it("keeps a key-less workspace addressable by name", () => {
    const result = publicWorkspaces([{ name: "juno", path: "/srv/juno" }]);
    assert.deepEqual(result, [{ name: "juno" }]);
  });

  /** No shape of stored JSON may leak a path through. */
  it("never emits a path key, whatever the input shape", () => {
    const inputs: unknown[] = [
      [{ name: "a", path: "/a" }],
      [{ path: "/only-path" }],
      [{ name: "a", path: "/a", key: "k", extra: { nested: "/deep/path" } }],
      ["not-an-object"],
      [null],
      [],
      null,
      undefined,
      "garbage",
    ];
    for (const input of inputs) {
      const serialized = JSON.stringify(publicWorkspaces(input));
      assert.equal(serialized.includes('"path"'), false, String(serialized));
      assert.equal(serialized.includes("/deep/path"), false, String(serialized));
    }
  });

  /** Non-array stored JSON must not throw — it comes from a JSONB column. */
  it("tolerates malformed stored workspace JSON", () => {
    assert.deepEqual(publicWorkspaces(null), []);
    assert.deepEqual(publicWorkspaces({ not: "an array" }), []);
  });
});
