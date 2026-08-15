import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkspaceConfig,
  writeWorkspaceConfig,
  workspacePermits,
  type WorkspaceConfig,
} from "../src/lib/projects/workspace-config";

/*
 * Every test here is about one distinction: ABSENT IS NOT EMPTY.
 *
 * A workspace with no `allowedTools` key inherits whatever the account allows.
 * A workspace with `allowedTools: []` may reach for nothing. Those are opposite
 * instructions, they are one keystroke apart in JSON, and every layer between
 * the Mac and the phone has a natural way of collapsing them — a Zod default, a
 * `?? []`, a Prisma patch that reads an omitted field as unchanged. The native
 * client already carries tests for this because it was got wrong there once;
 * these are the same properties, asserted on the wire format.
 */

test("an absent tool whitelist and an empty one are different configurations", () => {
  assert.equal(parseWorkspaceConfig({}).allowedTools, undefined);
  assert.deepEqual(parseWorkspaceConfig({ allowedTools: [] }).allowedTools, []);
});

test("an absent whitelist inherits; an empty one permits nothing", () => {
  assert.equal(workspacePermits({}, "webSearch"), true);
  assert.equal(workspacePermits({ allowedTools: [] }, "webSearch"), false);
  assert.equal(workspacePermits({ allowedTools: ["canvas"] }, "webSearch"), false);
  assert.equal(workspacePermits({ allowedTools: ["canvas"] }, "canvas"), true);
});

test("a project narrows and never widens", () => {
  // The account is the ceiling. A workspace naming a tool the account has
  // turned off does not turn it back on — a project is a folder, not a consent
  // surface.
  const accountAllows = (tool: string) => tool !== "mediaGeneration";
  assert.equal(workspacePermits({ allowedTools: ["mediaGeneration"] }, "mediaGeneration", accountAllows), false);
  assert.equal(workspacePermits({}, "mediaGeneration", accountAllows), false);
});

test("an unknown tool is dropped without discarding the restriction", () => {
  // Configure on a newer build, read on an older one. Dropping the whole key
  // would silently widen the assistant back to the account's full tool set,
  // which is the opposite of what the user asked for.
  const parsed = parseWorkspaceConfig({ allowedTools: ["webSearch", "timeTravel"] });
  assert.deepEqual(parsed.allowedTools, ["webSearch"]);
  assert.equal(workspacePermits(parsed, "canvas"), false);
});

test("every recognised tool surviving still leaves a restriction, not an inherit", () => {
  // The degenerate case of the test above: if a newer build restricts to tools
  // this build has NEVER heard of, the result is `[]` — restricted to nothing —
  // not `undefined`. Locking down harder than intended is recoverable; quietly
  // unlocking is not.
  const parsed = parseWorkspaceConfig({ allowedTools: ["timeTravel", "mindReading"] });
  assert.deepEqual(parsed.allowedTools, []);
  assert.equal(workspacePermits(parsed, "webSearch"), false);
});

test("an empty instructions override is a real override, not an absent one", () => {
  // "" means this assistant deliberately has no instructions. Absent means use
  // the project's own. Emptiness checks on strings are where these merge.
  assert.equal(parseWorkspaceConfig({ instructionsOverride: "" }).instructionsOverride, "");
  assert.equal(parseWorkspaceConfig({}).instructionsOverride, undefined);
  assert.equal("instructionsOverride" in writeWorkspaceConfig({ instructionsOverride: "" }), true);
});

test("writing omits keys rather than writing nulls", () => {
  const written = writeWorkspaceConfig({ personaName: "Reviewer" });
  assert.deepEqual(Object.keys(written), ["personaName"]);
  assert.equal("allowedTools" in written, false);
  assert.equal("preferredModelId" in written, false);
});

test("an unchanged config serialises identically twice", () => {
  // Not cosmetic. The stored bytes are what the change trigger versions: a save
  // that reorders a set bumps EntityRevision and makes every other device fetch
  // a change that contains nothing new.
  const config: WorkspaceConfig = {
    allowedTools: ["webSearch", "canvas"],
    allowedConnectorIds: ["gmail", "calendar", "gmail"],
  };
  const once = JSON.stringify(writeWorkspaceConfig(config));
  const twice = JSON.stringify(writeWorkspaceConfig(parseWorkspaceConfig(JSON.parse(once))));
  assert.equal(once, twice);
  // Same members in a different input order must produce the same bytes.
  const reordered = JSON.stringify(
    writeWorkspaceConfig({
      allowedTools: ["canvas", "webSearch"],
      allowedConnectorIds: ["calendar", "gmail"],
    })
  );
  assert.equal(once, reordered);
});

test("knowledge file order is preserved, because it is context order", () => {
  // Unlike the whitelists, this list is not a set — it is the order the files
  // are laid into the prompt. Sorting it would silently reorder the model's
  // context.
  const parsed = parseWorkspaceConfig({ knowledgeFileIds: ["z", "a", "m", "a"] });
  assert.deepEqual(parsed.knowledgeFileIds, ["z", "a", "m"]);
});

test("a corrupt or foreign payload reads as no opinion rather than throwing", () => {
  // A workspace written by a newer build, or a column that somehow holds a
  // scalar, must not take a project's whole configuration down with it.
  assert.deepEqual(parseWorkspaceConfig(null), {});
  assert.deepEqual(parseWorkspaceConfig("nonsense"), {});
  assert.deepEqual(parseWorkspaceConfig([1, 2, 3]), {});
  assert.deepEqual(parseWorkspaceConfig({ futureField: { nested: true } }), {});
});

test("a non-array whitelist is no opinion, not an empty restriction", () => {
  // The failure mode this guards: garbage in the column reading as "restricted
  // to nothing" would turn a corrupt row into an assistant with no tools, which
  // looks like a deliberate lockdown and is impossible to tell apart from one.
  assert.equal(parseWorkspaceConfig({ allowedTools: "webSearch" }).allowedTools, undefined);
  assert.equal(parseWorkspaceConfig({ allowedConnectorIds: null }).allowedConnectorIds, undefined);
});
