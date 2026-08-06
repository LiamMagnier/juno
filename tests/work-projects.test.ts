import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkDefaults,
  resolveWorkDefaults,
  serializeWorkDefaults,
  type WorkAccountDefaults,
  type WorkProjectDefaults,
} from "@/lib/work/projects";
import { WORK_PERMISSION_POLICIES } from "@/lib/work/domain";

/*
 * A project is a folder, not a consent surface.
 *
 * The property under test is the whole reason this module is written field by
 * field instead of as a spread merge: for every pair of account and project
 * settings, the resolved value is never wider than the account's. A spread is
 * one line, takes the project's value for every key, and is correct for a model
 * preference and catastrophic for a permission.
 */

const ACCOUNT: WorkAccountDefaults = {
  target: "automatic",
  model: "anthropic:claude-sonnet-5",
  budget: { maxCostMicroUsd: 2_000_000, maxTokens: 500_000, maxRuntimeMs: 600_000 },
  permissionPolicy: "balanced",
  connectorIds: ["gmail", "drive"],
  grantIds: ["grant_downloads"],
};

// ---------------------------------------------------------------------------
// The escalation property
// ---------------------------------------------------------------------------

test("a project can never widen the account's permission policy", () => {
  for (const accountPolicy of WORK_PERMISSION_POLICIES) {
    for (const projectPolicy of WORK_PERMISSION_POLICIES) {
      const resolved = resolveWorkDefaults(
        { ...ACCOUNT, permissionPolicy: accountPolicy },
        { permissionPolicy: projectPolicy }
      );
      const rank = (p: string) => WORK_PERMISSION_POLICIES.indexOf(p as never);
      assert.ok(
        rank(resolved.permissionPolicy) <= rank(accountPolicy),
        `account ${accountPolicy} + project ${projectPolicy} resolved to ${resolved.permissionPolicy}, ` +
          "which is wider than the account allowed"
      );
    }
  }
});

test("a widening attempt is reported rather than silently dropped", () => {
  const resolved = resolveWorkDefaults(ACCOUNT, { permissionPolicy: "permissive" });
  assert.equal(resolved.permissionPolicy, "balanced");
  const note = resolved.narrowed.find((n) => n.field === "permissionPolicy");
  assert.ok(
    note,
    "a user who cannot see that the account held their setting concludes the setting does not work"
  );
  assert.equal(note?.requested, "permissive");
  assert.equal(note?.applied, "balanced");
});

test("a narrowing request is honoured", () => {
  const resolved = resolveWorkDefaults(ACCOUNT, { permissionPolicy: "conservative" });
  assert.equal(resolved.permissionPolicy, "conservative");
  assert.equal(resolved.narrowed.length, 0, "getting what you asked for is not a narrowing");
});

test("a connector the account has not linked cannot be offered by a project", () => {
  const resolved = resolveWorkDefaults(ACCOUNT, { connectorIds: ["gmail", "slack"] });
  assert.deepEqual(resolved.connectorIds, ["gmail"]);
  assert.ok(resolved.narrowed.some((n) => n.requested === "slack"));
});

test("a folder the account has not granted cannot be used by a project", () => {
  const resolved = resolveWorkDefaults(ACCOUNT, { grantIds: ["grant_documents"] });
  assert.deepEqual(resolved.grantIds, []);
  assert.ok(resolved.narrowed.some((n) => n.field === "grantIds"));
});

test("omitting a list inherits the account's, it does not clear it", () => {
  const resolved = resolveWorkDefaults(ACCOUNT, {});
  assert.deepEqual(resolved.connectorIds, ["gmail", "drive"]);
  assert.deepEqual(resolved.grantIds, ["grant_downloads"]);
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

test("a project may lower a ceiling but not raise one", () => {
  const lower = resolveWorkDefaults(ACCOUNT, { budget: { maxCostMicroUsd: 500_000 } });
  assert.equal(lower.budget.maxCostMicroUsd, 500_000);

  const higher = resolveWorkDefaults(ACCOUNT, { budget: { maxCostMicroUsd: 9_000_000 } });
  assert.equal(higher.budget.maxCostMicroUsd, 2_000_000, "the account's ceiling still binds");
});

test("a ceiling the project leaves unset does not clamp the account's to zero", () => {
  const resolved = resolveWorkDefaults(ACCOUNT, { budget: { maxCostMicroUsd: 500_000 } });
  assert.equal(
    resolved.budget.maxTokens,
    500_000,
    "zero means unlimited at that layer, and a naive Math.min would stop every run instantly"
  );
});

// ---------------------------------------------------------------------------
// Knowledge writes
// ---------------------------------------------------------------------------

test("knowledge writes are off unless the project explicitly says otherwise", () => {
  assert.equal(resolveWorkDefaults(ACCOUNT, {}).allowKnowledgeWrites, false);
  assert.equal(
    resolveWorkDefaults(ACCOUNT, { allowKnowledgeWrites: true }).allowKnowledgeWrites,
    true
  );
});

test("a non-boolean cannot switch knowledge writes on", () => {
  const parsed = parseWorkDefaults({ allowKnowledgeWrites: "yes" });
  assert.equal(
    parsed.allowKnowledgeWrites,
    undefined,
    "an agent that can edit the instructions it is given can quietly rewrite its own future"
  );
  assert.equal(resolveWorkDefaults(ACCOUNT, parsed).allowKnowledgeWrites, false);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("an unrecognised field is discarded rather than failing the whole payload", () => {
  const parsed = parseWorkDefaults({ target: "cloud", somethingNewer: { a: 1 } });
  assert.equal(parsed.target, "cloud");
  assert.equal((parsed as Record<string, unknown>).somethingNewer, undefined);
});

test("a value outside the vocabulary is discarded", () => {
  assert.equal(parseWorkDefaults({ target: "quantum" }).target, undefined);
  assert.equal(parseWorkDefaults({ permissionPolicy: "godmode" }).permissionPolicy, undefined);
});

test("a negative budget is dropped, not clamped", () => {
  const parsed = parseWorkDefaults({ budget: { maxCostMicroUsd: -1 } });
  assert.equal(
    parsed.budget,
    undefined,
    "zero already means unlimited, so clamping a typo to zero turns it into unlimited spend"
  );
});

test("non-objects and arrays parse to empty defaults", () => {
  for (const value of [null, undefined, 3, "x", [1, 2]]) {
    assert.deepEqual(parseWorkDefaults(value), {});
  }
});

test("serialising round-trips through the parser", () => {
  const stored = serializeWorkDefaults({
    target: "cloud",
    permissionPolicy: "conservative",
    // A field the reader would ignore must not be storable, or the setting
    // looks saved and has no effect.
    ...({ bogus: true } as Partial<WorkProjectDefaults>),
  });
  assert.equal(stored.target, "cloud");
  assert.equal(stored.bogus, undefined);
});

test("target is a preference and is taken from the project as written", () => {
  // Deliberately NOT narrowed: asking for local grants the Mac nothing, and
  // selectTarget still decides whether it can be served.
  assert.equal(resolveWorkDefaults(ACCOUNT, { target: "local" }).target, "local");
  assert.equal(resolveWorkDefaults(ACCOUNT, {}).target, "automatic");
});
