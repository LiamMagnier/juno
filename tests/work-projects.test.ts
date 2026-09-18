import test from "node:test";
import assert from "node:assert/strict";
import {
  inheritFromProjectDefaults,
  parseWorkDefaults,
  resolveSessionFields,
  resolveWorkDefaults,
  serializeWorkDefaults,
  workDefaultsSchema,
  type WorkAccountDefaults,
  type WorkProjectDefaults,
} from "@/lib/work/projects";
import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_PERMISSION_POLICIES,
} from "@/lib/work/domain";

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

// ---------------------------------------------------------------------------
// Absent is not empty
// ---------------------------------------------------------------------------

test("a project that names no app is not the same as one that names none", () => {
  assert.equal(
    parseWorkDefaults({}).connectorIds,
    undefined,
    "a missing key is 'no opinion', and the task's own answer stands"
  );
  assert.deepEqual(
    parseWorkDefaults({ connectorIds: [] }).connectorIds,
    [],
    "a reader who switched every app off said 'reaches nothing'; collapsing that to " +
      "'no opinion' hands the project back every app the account has linked"
  );
  assert.deepEqual(
    resolveWorkDefaults(ACCOUNT, parseWorkDefaults({ connectorIds: [] })).connectorIds,
    []
  );
  assert.deepEqual(serializeWorkDefaults({ connectorIds: [] }).connectorIds, []);
});

// ---------------------------------------------------------------------------
// The write shape
// ---------------------------------------------------------------------------

test("the write schema takes the whole bundle and refuses a field nobody reads", () => {
  const full = workDefaultsSchema.safeParse({
    target: "local",
    preferredHostId: "host_1",
    model: ACCOUNT.model,
    reasoningEffort: "high",
    budget: { maxCostMicroUsd: 500_000 },
    permissionPolicy: "conservative",
    connectorIds: ["gmail"],
    grantIds: ["grant_downloads"],
    skillIds: ["skill_1"],
    allowKnowledgeWrites: true,
  });
  assert.ok(full.success);
  assert.ok(workDefaultsSchema.safeParse({}).success, "an empty bundle means 'inherit everything'");
  // Strict, for the reason the mutation union is: a field name the server does
  // not know is a client bug, and accepting it stores a setting that looks
  // saved and has no effect.
  assert.ok(!workDefaultsSchema.safeParse({ permissionPolicy: "godmode" }).success);
  assert.ok(!workDefaultsSchema.safeParse({ somethingNewer: true }).success);
  assert.ok(!workDefaultsSchema.safeParse({ budget: { maxCostMicroUsd: -1 } }).success);
});

// ---------------------------------------------------------------------------
// What one session inherits
// ---------------------------------------------------------------------------

const LINKED = ["gmail", "drive"];

test("a project can never make a task ask LESS than the product default", () => {
  for (const projectPolicy of WORK_PERMISSION_POLICIES) {
    const inherited = inheritFromProjectDefaults({
      requestedTarget: "automatic",
      linkedConnectorIds: LINKED,
      defaults: { permissionPolicy: projectPolicy },
    });
    const rank = (policy: string) => WORK_PERMISSION_POLICIES.indexOf(policy as never);
    assert.ok(
      rank(inherited.permissionPolicy ?? DEFAULT_WORK_PERMISSION_POLICY) <=
        rank(DEFAULT_WORK_PERMISSION_POLICY),
      `a project set to ${projectPolicy} resolved to ${inherited.permissionPolicy}, which is ` +
        "wider than every task in the product has ever been composed with"
    );
  }
});

test("a project that says nothing about approvals contributes nothing", () => {
  const inherited = inheritFromProjectDefaults({
    requestedTarget: "automatic",
    linkedConnectorIds: LINKED,
    defaults: {},
  });
  assert.equal(
    inherited.permissionPolicy,
    null,
    "reading the account layer back here would hand every task a mode nobody chose for it"
  );
  assert.equal(
    inherited.connectorIds,
    null,
    "a project with no connector opinion must not switch every linked app on"
  );
});

test("a project's app list is intersected with what the account has linked", () => {
  const inherited = inheritFromProjectDefaults({
    requestedTarget: "automatic",
    linkedConnectorIds: LINKED,
    defaults: { connectorIds: ["gmail", "slack"] },
  });
  assert.deepEqual(inherited.connectorIds, ["gmail"], "naming Slack does not thereby link Slack");
});

// ---------------------------------------------------------------------------
// Folding the project's answers into the request's
// ---------------------------------------------------------------------------

const NOTHING_INHERITED = {
  model: null,
  reasoningEffort: null,
  permissionPolicy: null,
  connectorIds: null,
  preferredHostId: null,
};

test("a task filed nowhere is composed exactly as it always was", () => {
  const resolved = resolveSessionFields({}, NOTHING_INHERITED);
  assert.equal(resolved.permissionPolicy, DEFAULT_WORK_PERMISSION_POLICY);
  assert.equal(resolved.model, null);
  assert.equal(resolved.connectorIds, null, "no list means no connector rows are written");
});

test("the project's approval mode binds a client that states its own", () => {
  // The browser composer always sends the mode it is showing, so a fall-through
  // would make a project's approval setting a control that visibly does
  // nothing on the surface most people reach it from.
  const resolved = resolveSessionFields(
    { permissionPolicy: "balanced" },
    { ...NOTHING_INHERITED, permissionPolicy: "conservative" }
  );
  assert.equal(resolved.permissionPolicy, "conservative");
});

test("a task may still ask to be interrupted more often than its project", () => {
  const resolved = resolveSessionFields(
    { permissionPolicy: "conservative" },
    { ...NOTHING_INHERITED, permissionPolicy: "balanced" }
  );
  assert.equal(resolved.permissionPolicy, "conservative", "the meet goes both ways");
});

test("a task cannot reach an app its project did not offer", () => {
  const resolved = resolveSessionFields(
    { connectorIds: ["gmail", "drive"] },
    { ...NOTHING_INHERITED, connectorIds: ["gmail"] }
  );
  assert.deepEqual(resolved.connectorIds, ["gmail"]);
});

test("a client with no app control gets the project's list, and one with none keeps its own", () => {
  assert.deepEqual(
    resolveSessionFields({}, { ...NOTHING_INHERITED, connectorIds: ["gmail"] }).connectorIds,
    ["gmail"],
    "the native composer sends no list at all, and the project's is the next-best answer"
  );
  assert.deepEqual(
    resolveSessionFields({ connectorIds: [] }, { ...NOTHING_INHERITED, connectorIds: ["gmail"] })
      .connectorIds,
    [],
    "an empty list is a reader who switched every app off, not a silence"
  );
  assert.deepEqual(
    resolveSessionFields({ connectorIds: ["gmail"] }, NOTHING_INHERITED).connectorIds,
    ["gmail"],
    "a project with no opinion leaves the task's own answer whole"
  );
});

test("the scalars fall through only where the task was silent", () => {
  const inherited = {
    ...NOTHING_INHERITED,
    model: ACCOUNT.model ?? null,
    reasoningEffort: "low",
    preferredHostId: "host_project",
  };
  assert.equal(resolveSessionFields({}, inherited).model, ACCOUNT.model);
  assert.equal(
    resolveSessionFields({ model: "provider:chosen-for-this-task" }, inherited).model,
    "provider:chosen-for-this-task",
    "a model somebody chose for this one task stands"
  );
  assert.equal(resolveSessionFields({}, inherited).reasoningEffort, "low");
  assert.equal(
    resolveSessionFields({ preferredHostId: "host_task" }, inherited).preferredHostId,
    "host_task"
  );
});
