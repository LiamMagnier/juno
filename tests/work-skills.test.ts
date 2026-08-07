import test from "node:test";
import assert from "node:assert/strict";
import type { Prisma, WorkSkill, WorkSkillVersion } from "@prisma/client";
import {
  CLIENT_SKILL_TRUST_LEVELS,
  SKILL_AUTO_SELECT_MIN_CONFIDENCE,
  SKILL_MATCH_MIN_MATCHES,
  SKILL_NAME_WEIGHT,
  WORK_SKILL_TRUST_LEVELS,
  createSkillSchema,
  emptySkillContract,
  evaluateSkillExamples,
  mintSkillVersionSchema,
  narrowestGrant,
  nextSkillVersion,
  normalizeSkillSlug,
  parseRequestedTools,
  parseSkillContract,
  parseSkillInvocation,
  parseSkillListQuery,
  patchSkillSchema,
  resolveSkillPermissions,
  scoreSkillForGoal,
  scoreSkillsForGoal,
  selectSkillAutomatically,
  selectSkillBySlug,
  selectSkillVersion,
  serializeSkill,
  serializeSkillVersion,
  skillContractToJson,
  skillContractTerms,
  skillRequestFromRow,
  skillSlugFromName,
  skillVersionRunReference,
  skillWasFullyGranted,
  trustForOrigin,
  trustPermitsAutoSelection,
  type SkillCandidate,
  type SkillProfile,
  type WorkSkillExample,
  type WorkSkillGrantLayer,
  type WorkSkillRequest,
} from "@/lib/work/skills";
import { WORK_PERMISSION_POLICIES, type WorkPermissionPolicy } from "@/lib/work/domain";

/*
 * Skills are the one Work feature a user acquires from somebody else.
 *
 * They are pasted out of a message, imported from a repository, shared between
 * two people who trust each other about spreadsheets and not about their
 * Downloads folder — and then they run against real files with real tools. So
 * the property that matters here is not that the resolver is correct on the
 * examples somebody thought of, but that it cannot widen anything on ANY input.
 * The cross-product test below is written to make the widening mistake
 * unreintroducible rather than merely absent: a union in place of the
 * intersection, an early return that skips the filter, a "no request means all
 * tools" convenience — each of them fails on hundreds of the generated pairs.
 *
 * Nothing in this file opens a database.
 */

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Every subset, as a list, in a stable order. 2^n of them. */
function subsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++) {
    const subset: T[] = [];
    for (let index = 0; index < items.length; index++) {
      if (mask & (1 << index)) subset.push(items[index]);
    }
    out.push(subset);
  }
  return out;
}

const TOOLS = ["work.file.read", "work.file.move", "gmail_send", "sheets_read", "work.shell.run"];
const POLICY_RANK: Record<WorkPermissionPolicy, number> = {
  conservative: 0,
  balanced: 1,
  permissive: 2,
};

function requestOf(overrides: Partial<WorkSkillRequest> = {}): WorkSkillRequest {
  return {
    tools: [],
    connectors: [],
    apps: [],
    domains: [],
    policy: null,
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    ...overrides,
  };
}

function layerOf(overrides: Partial<WorkSkillGrantLayer> = {}): WorkSkillGrantLayer {
  return {
    tools: [],
    connectors: [],
    apps: [],
    domains: [],
    policy: "permissive",
    ...overrides,
  };
}

/** The same name list in all four categories, so one loop covers all of them. */
function everyCategory(names: readonly string[]) {
  return { tools: names, connectors: names, apps: names, domains: names };
}

// ---------------------------------------------------------------------------
// The escalation property
// ---------------------------------------------------------------------------

test("a skill can never resolve a permission it was not granted", () => {
  const all = subsets(TOOLS);
  let pairs = 0;

  for (const requested of all) {
    for (const granted of all) {
      const resolved = resolveSkillPermissions({
        request: requestOf(everyCategory(requested)),
        granted: [layerOf(everyCategory(granted))],
      });
      pairs++;

      const expectedKept = requested.filter((name) => granted.includes(name));
      const expectedWithheld = requested.filter((name) => !granted.includes(name));

      for (const [category, resolvedNames, withheldNames] of [
        ["tools", resolved.tools, resolved.withheld.tools],
        ["connectors", resolved.connectors, resolved.withheld.connectors],
        ["apps", resolved.apps, resolved.withheld.apps],
        ["domains", resolved.domains, resolved.withheld.domains],
      ] as const) {
        for (const name of resolvedNames) {
          assert.ok(
            granted.includes(name),
            `resolved ${category} ${name} was never granted (requested ${JSON.stringify(requested)}, granted ${JSON.stringify(granted)})`
          );
          assert.ok(
            requested.includes(name),
            `resolved ${category} ${name} was never requested (requested ${JSON.stringify(requested)}, granted ${JSON.stringify(granted)})`
          );
        }
        // Exactly the intersection, not merely a subset of the grant: a
        // resolver that dropped something it was entitled to keep is a
        // different bug, and one that reported it as granted anyway is this one.
        assert.deepEqual(resolvedNames, expectedKept);
        assert.deepEqual(withheldNames, expectedWithheld);
        assert.ok(resolvedNames.length <= Math.min(requested.length, granted.length));
      }
    }
  }

  assert.equal(pairs, 32 * 32);
});

test("resolution narrows against every grant layer, not just the last one", () => {
  const universe = TOOLS.slice(0, 3);
  const layerSets = subsets(universe);

  for (const requested of layerSets) {
    for (const first of layerSets) {
      for (const second of layerSets) {
        for (const third of layerSets) {
          const layers = [first, second, third].map((tools) => layerOf(everyCategory(tools)));
          const resolved = resolveSkillPermissions({
            request: requestOf(everyCategory(requested)),
            granted: layers,
          });

          for (const tool of resolved.tools) {
            assert.ok(first.includes(tool), `${tool} is not in the first layer`);
            assert.ok(second.includes(tool), `${tool} is not in the second layer`);
            assert.ok(third.includes(tool), `${tool} is not in the third layer`);
            assert.ok(requested.includes(tool), `${tool} was not requested`);
          }
          assert.equal(
            resolved.tools.length,
            requested.filter(
              (tool) => first.includes(tool) && second.includes(tool) && third.includes(tool)
            ).length
          );
        }
      }
    }
  }
});

test("no requested policy or budget can loosen the granted one", () => {
  for (const grantedPolicy of WORK_PERMISSION_POLICIES) {
    for (const requestedPolicy of [...WORK_PERMISSION_POLICIES, null]) {
      const resolved = resolveSkillPermissions({
        request: requestOf({ policy: requestedPolicy }),
        granted: [layerOf({ policy: grantedPolicy })],
      });
      assert.ok(
        POLICY_RANK[resolved.policy] <= POLICY_RANK[grantedPolicy],
        `${requestedPolicy ?? "no"} request widened ${grantedPolicy} to ${resolved.policy}`
      );
      if (requestedPolicy !== null) {
        assert.ok(POLICY_RANK[resolved.policy] <= POLICY_RANK[requestedPolicy]);
      }
    }
  }

  // Zero means "no ceiling at this layer", so it must not be able to erase one
  // that another layer set — nor to be raised by a skill asking for more.
  const budgets = [
    { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    { maxCostMicroUsd: 500, maxTokens: 1_000, maxRuntimeMs: 60_000 },
    { maxCostMicroUsd: 5_000, maxTokens: 10, maxRuntimeMs: 600_000 },
  ];
  for (const granted of budgets) {
    for (const requested of budgets) {
      const resolved = resolveSkillPermissions({
        request: requestOf({ budget: requested }),
        granted: [layerOf({ budget: granted })],
      });
      for (const key of ["maxCostMicroUsd", "maxTokens", "maxRuntimeMs"] as const) {
        if (granted[key] > 0) assert.ok(resolved.budget[key] <= granted[key]);
        if (requested[key] > 0) assert.ok(resolved.budget[key] <= requested[key]);
      }
    }
  }
});

test("an empty request asks for nothing rather than for everything", () => {
  const resolved = resolveSkillPermissions({
    request: requestOf(),
    granted: [layerOf(everyCategory(TOOLS))],
  });
  assert.deepEqual(resolved.tools, []);
  assert.deepEqual(resolved.connectors, []);
  assert.deepEqual(resolved.apps, []);
  assert.deepEqual(resolved.domains, []);
  assert.equal(skillWasFullyGranted(resolved), true);
});

test("an empty list of grant layers grants nothing", () => {
  // The trap this pins: the intersection of no sets is everything, so a fold
  // that starts from "all tools" hands back the full toolset the first time a
  // caller passes a layer list it had not populated — a host whose capabilities
  // have not loaded, a project with no row.
  const empty = narrowestGrant([]);
  assert.deepEqual(empty.tools, []);
  assert.equal(empty.policy, "conservative");

  const resolved = resolveSkillPermissions({
    request: requestOf(everyCategory(TOOLS)),
    granted: [],
  });
  assert.deepEqual(resolved.tools, []);
  assert.deepEqual(resolved.withheld.tools, TOOLS);
  assert.equal(resolved.policy, "conservative");
  assert.equal(skillWasFullyGranted(resolved), false);
});

test("narrowestGrant returns a fresh grant each call", () => {
  const first = narrowestGrant([]);
  first.tools.push("work.shell.run");
  assert.deepEqual(narrowestGrant([]).tools, []);
});

test("the request keeps its declared order and drops duplicates", () => {
  const resolved = resolveSkillPermissions({
    request: requestOf({ tools: ["gmail_send", "work.file.read", "gmail_send"] }),
    granted: [layerOf({ tools: ["work.file.read", "gmail_send", "work.shell.run"] })],
  });
  // Request order, not grant order: a skill lists its tools in the order it
  // means to reach for them.
  assert.deepEqual(resolved.tools, ["gmail_send", "work.file.read"]);
});

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

test("an imported skill starts untrusted and an authored one does not", () => {
  assert.equal(trustForOrigin("imported"), "untrusted");
  assert.equal(trustForOrigin("authored"), "user_authored");
});

test("automatic selection is permitted only by a trust level this build knows", () => {
  assert.equal(trustPermitsAutoSelection("untrusted"), false);
  assert.equal(trustPermitsAutoSelection("user_authored"), true);
  assert.equal(trustPermitsAutoSelection("verified"), true);
  // A level written by a newer deployment must not authorise anything here.
  assert.equal(trustPermitsAutoSelection("community_reviewed"), false);
  assert.equal(trustPermitsAutoSelection(""), false);
});

test("a client may not claim the verified badge", () => {
  assert.deepEqual([...CLIENT_SKILL_TRUST_LEVELS], ["untrusted", "user_authored"]);
  assert.ok((WORK_SKILL_TRUST_LEVELS as readonly string[]).includes("verified"));
  assert.equal(patchSkillSchema.safeParse({ trust: "verified" }).success, false);
  assert.equal(patchSkillSchema.safeParse({ trust: "user_authored" }).success, true);
});

// ---------------------------------------------------------------------------
// Slugs and slash invocation
// ---------------------------------------------------------------------------

test("slugs are lowercase hyphenated words and nothing else", () => {
  assert.equal(normalizeSkillSlug("  Tidy-Downloads "), "tidy-downloads");
  assert.equal(normalizeSkillSlug("weekly-report-2"), "weekly-report-2");
  assert.equal(normalizeSkillSlug("tidy downloads"), null);
  assert.equal(normalizeSkillSlug("tidy--downloads"), null);
  assert.equal(normalizeSkillSlug("-tidy"), null);
  assert.equal(normalizeSkillSlug(""), null);
  assert.equal(normalizeSkillSlug("a".repeat(65)), null);
});

test("a slug derived from a name never ends in a separator", () => {
  assert.equal(skillSlugFromName("Tidy my Downloads!"), "tidy-my-downloads");
  assert.equal(skillSlugFromName("  Q3   Report  "), "q3-report");
  const long = skillSlugFromName(`${"ab ".repeat(40)}`);
  assert.ok(long !== null && long.length <= 64 && !long.endsWith("-"));
  // Nothing usable survives, so there is no slug — rather than a made-up one
  // the user has no reason to remember.
  assert.equal(skillSlugFromName("！！！"), null);
});

test("a leading path is not a slash invocation", () => {
  assert.deepEqual(parseSkillInvocation("/tidy-downloads please do it"), {
    slug: "tidy-downloads",
    remainder: "please do it",
  });
  assert.deepEqual(parseSkillInvocation("  /weekly-report"), {
    slug: "weekly-report",
    remainder: "",
  });
  // The near misses, which is where this goes wrong in practice.
  assert.equal(parseSkillInvocation("/Users/liam/Downloads is a mess"), null);
  assert.equal(parseSkillInvocation("/"), null);
  assert.equal(parseSkillInvocation("//tidy-downloads"), null);
  assert.equal(parseSkillInvocation("tidy-downloads"), null);
  assert.equal(parseSkillInvocation("please run /tidy-downloads"), null);
});

// ---------------------------------------------------------------------------
// Reading stored columns
// ---------------------------------------------------------------------------

test("an unreadable contract asks for nothing", () => {
  const empty = emptySkillContract();
  assert.deepEqual(parseSkillContract(null), empty);
  assert.deepEqual(parseSkillContract({}), empty);
  assert.deepEqual(parseSkillContract("not an object"), empty);
  // One bad field fails the whole contract closed rather than granting the
  // half of it that parsed.
  assert.deepEqual(parseSkillContract({ requestedPolicy: "godmode" }), empty);
  assert.equal(parseSkillContract({ requestedConnectors: ["gmail"] }).requestedConnectors[0], "gmail");
});

test("requested tools drop entries that are not names", () => {
  assert.deepEqual(
    parseRequestedTools(["gmail_send", 7, null, "  work.file.read  ", "gmail_send", "not a name"]),
    ["gmail_send", "work.file.read"]
  );
  assert.deepEqual(parseRequestedTools("gmail_send"), []);
  assert.equal(parseRequestedTools(new Array(200).fill(0).map((_, i) => `tool${i}`)).length, 64);
});

test("a request is read straight from the two stored columns", () => {
  const request = skillRequestFromRow({
    requestedTools: ["gmail_send", "work.file.read"],
    contract: { requestedConnectors: ["gmail"], requestedPolicy: "permissive" },
  });
  assert.deepEqual(request.tools, ["gmail_send", "work.file.read"]);
  assert.deepEqual(request.connectors, ["gmail"]);
  assert.equal(request.policy, "permissive");

  // And that permissive request still cannot beat a conservative grant.
  const resolved = resolveSkillPermissions({
    request,
    granted: [layerOf({ tools: ["gmail_send"], policy: "conservative" })],
  });
  assert.deepEqual(resolved.tools, ["gmail_send"]);
  assert.deepEqual(resolved.withheld.tools, ["work.file.read"]);
  assert.equal(resolved.policy, "conservative");
});

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

test("a new version is numbered from the highest, not from the pointer", () => {
  // Five versions, restored to three. `currentVersion + 1` would be 4, which
  // already exists, and the unique index would fail every later edit.
  assert.equal(nextSkillVersion(5), 6);
  assert.equal(nextSkillVersion(0), 1);
});

test("a pinned version is honoured and its absence is refused", () => {
  const available = [1, 2, 3, 4, 5];

  const followed = selectSkillVersion({ slug: "tidy", currentVersion: 5, availableVersions: available });
  assert.deepEqual(followed, { ok: true, version: 5, pinned: false, degradation: [] });

  const pinned = selectSkillVersion({
    slug: "tidy",
    currentVersion: 5,
    availableVersions: available,
    pinnedVersion: 3,
  });
  assert.equal(pinned.ok && pinned.version, 3);
  assert.equal(pinned.ok && pinned.pinned, true);
  assert.equal(pinned.ok && pinned.degradation[0]?.kind, "skill_version_pinned");
  assert.ok(pinned.ok && pinned.degradation[0].explanation.includes("version 3"));

  // Pinning the version that is already current is not a degradation: nothing
  // about the run differs from the unpinned one.
  const pinnedToCurrent = selectSkillVersion({
    slug: "tidy",
    currentVersion: 5,
    availableVersions: available,
    pinnedVersion: 5,
  });
  assert.deepEqual(pinnedToCurrent, { ok: true, version: 5, pinned: true, degradation: [] });

  // A pin naming a version that is gone is refused rather than resolved to the
  // current one — running version 5 is exactly what the pin existed to prevent.
  assert.deepEqual(
    selectSkillVersion({
      slug: "tidy",
      currentVersion: 5,
      availableVersions: available,
      pinnedVersion: 9,
    }),
    { ok: false, reason: "no_such_version" }
  );

  // A head pointing at a row that is not there is a data fault, not licence to
  // run the newest instructions instead.
  assert.deepEqual(
    selectSkillVersion({ slug: "tidy", currentVersion: 7, availableVersions: available }),
    { ok: false, reason: "no_such_version" }
  );
});

test("a run records the version row, not the skill", () => {
  const reference = skillVersionRunReference({
    versionRowId: "wsv_3",
    skillId: "skl_1",
    slug: "tidy-downloads",
    version: 3,
    trust: "community_reviewed",
    pinned: true,
    via: "slash",
  });
  assert.equal(reference.refKind, "skill_version");
  // The version row, so the answer does not change when the skill is edited.
  assert.equal(reference.refId, "wsv_3");
  assert.equal(reference.label, "tidy-downloads v3");
  assert.equal(reference.detail.skillId, "skl_1");
  assert.equal(reference.detail.version, 3);
  // An unreadable trust level is recorded as untrusted rather than passed on.
  assert.equal(reference.detail.trust, "untrusted");
});

test("a run records whether the user asked for the skill or Juno matched it", () => {
  // "Which skill ran" is answerable without this; "did I ask for that" is not,
  // and automatic selection is what makes it a question worth asking.
  const named = skillVersionRunReference({
    versionRowId: "wsv_3",
    skillId: "skl_1",
    slug: "tidy-downloads",
    version: 3,
    trust: "user_authored",
    pinned: false,
    via: "slash",
  });
  const matched = { ...named, detail: { ...named.detail, via: "automatic" as const } };
  assert.equal(named.detail.via, "slash");
  assert.equal(
    skillVersionRunReference({
      versionRowId: "wsv_3",
      skillId: "skl_1",
      slug: "tidy-downloads",
      version: 3,
      trust: "user_authored",
      pinned: false,
      via: "automatic",
    }).detail.via,
    "automatic"
  );
  // The two are otherwise the same row, so nothing else has to be read
  // differently depending on how the skill was chosen.
  assert.deepEqual({ ...matched.detail, via: "slash" }, named.detail);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id: "skl_1",
    slug: "tidy-downloads",
    enabled: true,
    trust: "user_authored",
    autoSelect: true,
    currentVersion: 1,
    ...overrides,
  };
}

test("slash invocation works on an untrusted skill and not on a disabled one", () => {
  const untrusted = candidate({ trust: "untrusted", autoSelect: false });
  const chosen = selectSkillBySlug("tidy-downloads", [untrusted]);
  // The user typed the name. Refusing here would make an imported skill
  // unusable rather than un-suggested, and the user's workaround would be to
  // mark it trusted — which would hand it automatic selection too.
  assert.equal(chosen.selected, true);
  assert.equal(chosen.selected && chosen.via, "slash");

  assert.deepEqual(selectSkillBySlug("nope", [untrusted]), {
    selected: false,
    reason: "unknown_slug",
  });
  assert.deepEqual(selectSkillBySlug("tidy-downloads", [candidate({ enabled: false })]), {
    selected: false,
    reason: "disabled",
  });
});

test("automatic selection refuses an untrusted skill however confident it is", () => {
  for (const confidence of [0.8, 0.95, 1, 1_000]) {
    assert.deepEqual(
      selectSkillAutomatically({
        scored: [{ candidate: candidate({ trust: "untrusted" }), confidence }],
      }),
      { selected: false, reason: "untrusted" }
    );
  }
});

test("automatic selection is opt-in and confidence-gated", () => {
  assert.deepEqual(
    selectSkillAutomatically({ scored: [{ candidate: candidate({ autoSelect: false }), confidence: 1 }] }),
    { selected: false, reason: "auto_select_disabled" }
  );
  assert.deepEqual(
    selectSkillAutomatically({ scored: [{ candidate: candidate({ enabled: false }), confidence: 1 }] }),
    { selected: false, reason: "disabled" }
  );
  assert.deepEqual(
    selectSkillAutomatically({
      scored: [{ candidate: candidate(), confidence: SKILL_AUTO_SELECT_MIN_CONFIDENCE - 0.01 }],
    }),
    { selected: false, reason: "low_confidence" }
  );
  assert.deepEqual(selectSkillAutomatically({ scored: [] }), {
    selected: false,
    reason: "no_candidate",
  });

  const ok = selectSkillAutomatically({
    scored: [{ candidate: candidate(), confidence: SKILL_AUTO_SELECT_MIN_CONFIDENCE }],
  });
  assert.equal(ok.selected, true);
  assert.equal(ok.selected && ok.via, "automatic");

  // A confidence that is not a number never clears the threshold.
  assert.deepEqual(
    selectSkillAutomatically({ scored: [{ candidate: candidate(), confidence: Number.NaN }] }),
    { selected: false, reason: "low_confidence" }
  );
});

test("an untrusted skill cannot block a trusted one from being selected", () => {
  // If ineligible candidates were merely refused at the top of the ranking,
  // importing one untrusted skill that matched a request well would switch
  // automatic selection off for everything it resembled.
  const chosen = selectSkillAutomatically({
    scored: [
      { candidate: candidate({ id: "skl_bad", slug: "imported", trust: "untrusted" }), confidence: 0.99 },
      { candidate: candidate({ id: "skl_good", slug: "authored" }), confidence: 0.9 },
    ],
  });
  assert.equal(chosen.selected, true);
  assert.equal(chosen.selected && chosen.candidate.id, "skl_good");
});

test("two equally confident skills are a refusal, not a coin toss", () => {
  assert.deepEqual(
    selectSkillAutomatically({
      scored: [
        { candidate: candidate({ id: "skl_a", slug: "alpha" }), confidence: 0.9 },
        { candidate: candidate({ id: "skl_b", slug: "beta" }), confidence: 0.9 },
      ],
    }),
    { selected: false, reason: "ambiguous" }
  );
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/*
 * The tests above hand `selectSkillAutomatically` confidences chosen to exercise
 * one branch each, which pins the gate and says nothing about whether a real
 * goal can ever get through it. Everything below goes in the other end — a goal
 * somebody might type, and a skill somebody might have written — so that the
 * selecting branch is reached by the scorer rather than by a literal.
 *
 * The property under test is not "the scorer ranks well". It is that the scorer
 * and the gate agree on where 0.75 is: strong evidence gets through, evidence
 * that is merely topical does not, and neither answer moves between runs.
 */

function profile(overrides: Partial<SkillProfile> = {}): SkillProfile {
  return {
    candidate: candidate(),
    name: "Tidy Downloads",
    description: "",
    contractTerms: [],
    ...overrides,
  };
}

/** The skill and the goal a reader of this module would expect to work. */
const TIDY_DOWNLOADS = profile({
  candidate: candidate({ id: "skl_tidy", slug: "tidy-downloads" }),
  name: "Tidy Downloads",
  description: "Sorts the Downloads folder by file type and moves installers to the bin.",
});

test("a real goal reaches the selecting branch through the scorer", () => {
  const scored = scoreSkillsForGoal({
    goal: "tidy my downloads folder",
    profiles: [
      TIDY_DOWNLOADS,
      profile({
        candidate: candidate({ id: "skl_weekly", slug: "weekly-report" }),
        name: "Weekly Report",
        description: "Writes the Monday summary from last week's sessions.",
      }),
    ],
  });

  const selection = selectSkillAutomatically({ scored });
  assert.equal(selection.selected, true);
  assert.equal(selection.selected && selection.candidate.id, "skl_tidy");
  assert.equal(selection.selected && selection.via, "automatic");
  // The confidence the run records is the scorer's own number, not a rounding
  // of it: the audit event and the threshold have to be reading one value.
  assert.equal(selection.selected && selection.confidence, scored[0].confidence);
  assert.ok(scored[0].confidence >= SKILL_AUTO_SELECT_MIN_CONFIDENCE);

  // The unrelated skill contributed nothing rather than a small amount, so it
  // cannot creep up on the leader as descriptions get longer.
  assert.equal(scored[1].confidence, 0);
  assert.deepEqual(scored[1].matched, []);
  // Naming evidence is reported before corroborating evidence.
  assert.deepEqual(scored[0].matched, ["tidy", "download", "folder"]);
});

test("a goal about nothing in particular selects nothing", () => {
  const scored = scoreSkillsForGoal({
    goal: "summarise this idea for me",
    profiles: [TIDY_DOWNLOADS],
  });
  assert.equal(scored[0].confidence, 0);
  assert.deepEqual(selectSkillAutomatically({ scored }), {
    selected: false,
    reason: "low_confidence",
  });
});

test("a goal on the skill's topic that does not name it is refused", () => {
  // The conservative half of the design, and the one worth a test: this goal is
  // unmistakably what the skill is for, and every corroborating term matches.
  // Half the skill's name is still missing, and half a name is not enough to
  // act on unasked.
  const expenses = profile({
    candidate: candidate({ id: "skl_expenses", slug: "expense-report" }),
    name: "Expense Report",
    description: "Reconciles the monthly spreadsheet totals against receipts.",
  });
  const scored = scoreSkillsForGoal({
    goal: "reconcile the monthly spreadsheet totals against my receipts and expenses",
    profiles: [expenses],
  });

  assert.ok(scored[0].confidence > 0, "the topical overlap is visible");
  assert.ok(scored[0].confidence < SKILL_AUTO_SELECT_MIN_CONFIDENCE);
  assert.deepEqual(selectSkillAutomatically({ scored }), {
    selected: false,
    reason: "low_confidence",
  });

  // And it stays refused however much corroboration is piled on, because the
  // description can only ever be worth `1 - SKILL_NAME_WEIGHT`.
  const saturated = scoreSkillsForGoal({
    goal: "reconcile the monthly spreadsheet totals against my receipts and expenses",
    profiles: [{ ...expenses, contractTerms: ["reconcile", "monthly", "spreadsheet", "receipts"] }],
  });
  assert.ok(saturated[0].confidence <= SKILL_NAME_WEIGHT / 2 + (1 - SKILL_NAME_WEIGHT));
  assert.ok(saturated[0].confidence < SKILL_AUTO_SELECT_MIN_CONFIDENCE);
});

test("one matched term is never enough on its own", () => {
  const invoices = profile({
    candidate: candidate({ id: "skl_inv", slug: "invoices" }),
    name: "Invoices",
    description: "",
  });
  const scored = scoreSkillForGoal({ goal: "file the invoices", profile: invoices });
  // Its whole name matched, so coverage alone would report full confidence —
  // there was only ever one thing to match.
  assert.deepEqual(scored.matched, ["invoice"]);
  assert.ok(scored.matched.length < SKILL_MATCH_MIN_MATCHES);
  assert.equal(scored.confidence, 0);
});

test("a plural in the goal meets a singular in the skill, and the reverse", () => {
  const archive = profile({
    candidate: candidate({ id: "skl_arch", slug: "invoice-archive" }),
    name: "Invoice Archive",
  });
  for (const goal of ["archive my invoices", "archive my invoice"]) {
    const scored = scoreSkillForGoal({ goal, profile: archive });
    assert.ok(
      scored.confidence >= SKILL_AUTO_SELECT_MIN_CONFIDENCE,
      `${goal} did not reach the threshold`
    );
  }

  // Folding is applied to both sides, so it does not have to be right about
  // English to work: `analysis` folds to a non-word, and meets itself there.
  const analysis = profile({
    candidate: candidate({ id: "skl_an", slug: "analysis-notes" }),
    name: "Analysis Notes",
  });
  assert.ok(
    scoreSkillForGoal({ goal: "write up the analysis notes", profile: analysis }).confidence >=
      SKILL_AUTO_SELECT_MIN_CONFIDENCE
  );

  // `ss` and short words are left whole, so `address` is not folded to `addres`
  // and then missed by a goal that spells it correctly.
  const addresses = profile({
    candidate: candidate({ id: "skl_ad", slug: "address-book" }),
    name: "Address Book",
  });
  assert.ok(
    scoreSkillForGoal({ goal: "update the address book", profile: addresses }).confidence >=
      SKILL_AUTO_SELECT_MIN_CONFIDENCE
  );
});

test("function words carry no evidence on either side", () => {
  // Every word here is a stopword or too short, so there is nothing to match
  // however many of them the goal and the skill have in common.
  const scored = scoreSkillForGoal({
    goal: "please can you do this for me and then also do that",
    profile: profile({ description: "Please do this for me." }),
  });
  assert.equal(scored.confidence, 0);
  assert.deepEqual(scored.matched, []);
});

test("the contract corroborates what the name already suggested", () => {
  const base = profile({
    candidate: candidate({ id: "skl_mail", slug: "mailbox-triage" }),
    name: "Mailbox Triage",
    description: "",
  });
  const goal = "triage the gmail label";

  const without = scoreSkillForGoal({ goal, profile: base });
  const with_ = scoreSkillForGoal({
    goal,
    profile: {
      ...base,
      contractTerms: skillContractTerms(
        parseSkillContract({
          inputs: [{ name: "label", kind: "string", description: "The Gmail label to read." }],
          requestedConnectors: ["gmail"],
        })
      ),
    },
  });

  assert.ok(with_.confidence > without.confidence);
  assert.ok(with_.matched.includes("gmail"));
  // Corroboration only. Half the name is still missing, so this does not become
  // a second route past the threshold.
  assert.ok(with_.confidence < SKILL_AUTO_SELECT_MIN_CONFIDENCE);
});

test("contract terms are what the skill is for, not where it may go", () => {
  const terms = skillContractTerms(
    parseSkillContract({
      inputs: [{ name: "folder", kind: "file", description: "The folder to sort." }],
      outputs: [{ name: "report", kind: "string", description: "What moved." }],
      requestedConnectors: ["gmail"],
      requestedApps: ["Finder"],
      // Excluded: these tokenise to `example` and `com`, and `com` would match
      // every goal that mentions a URL.
      requestedDomains: ["example.com"],
    })
  );
  assert.ok(terms.includes("folder"));
  assert.ok(terms.includes("The folder to sort."));
  assert.ok(terms.includes("report"));
  assert.ok(terms.includes("gmail"));
  assert.ok(terms.includes("Finder"));
  assert.equal(
    terms.some((term) => term.includes("example.com")),
    false
  );
});

test("a strong match still cannot get an untrusted skill selected", () => {
  // The trust gate is the one that matters most here, because this is the path
  // an imported skill reaches without anybody typing its name.
  const scored = scoreSkillsForGoal({
    goal: "tidy my downloads folder",
    profiles: [
      {
        ...TIDY_DOWNLOADS,
        candidate: candidate({ id: "skl_tidy", slug: "tidy-downloads", trust: "untrusted" }),
      },
    ],
  });
  assert.ok(scored[0].confidence >= SKILL_AUTO_SELECT_MIN_CONFIDENCE);
  assert.deepEqual(selectSkillAutomatically({ scored }), {
    selected: false,
    reason: "untrusted",
  });

  // Same for a skill the user has not opted in, at the same score.
  assert.deepEqual(
    selectSkillAutomatically({
      scored: scoreSkillsForGoal({
        goal: "tidy my downloads folder",
        profiles: [
          {
            ...TIDY_DOWNLOADS,
            candidate: candidate({ id: "skl_tidy", slug: "tidy-downloads", autoSelect: false }),
          },
        ],
      }),
    }),
    { selected: false, reason: "auto_select_disabled" }
  );
});

test("two skills matched equally compare exactly equal, so the tie is seen", () => {
  // A goal that asks for two things and names both skills. The refusal depends
  // on `===`, so equal evidence has to produce the same double and not two
  // values a hair apart — which it does because the arithmetic is the same
  // operations on the same rationals for every candidate.
  const scored = scoreSkillsForGoal({
    goal: "tidy my downloads and archive the invoices",
    profiles: [
      profile({
        candidate: candidate({ id: "skl_tidy", slug: "tidy-downloads" }),
        name: "Tidy Downloads",
      }),
      profile({
        candidate: candidate({ id: "skl_arch", slug: "archive-invoices" }),
        name: "Archive Invoices",
      }),
    ],
  });

  assert.equal(scored[0].confidence, scored[1].confidence);
  assert.ok(scored[0].confidence >= SKILL_AUTO_SELECT_MIN_CONFIDENCE);
  assert.deepEqual(selectSkillAutomatically({ scored }), {
    selected: false,
    reason: "ambiguous",
  });
});

test("confidence measures the skill's terms, not how much the user typed", () => {
  // Scoring the goal's coverage instead would make the threshold a measure of
  // brevity: the same skill would clear it for a terse request and miss it for
  // a chatty one describing the identical job.
  const terse = scoreSkillForGoal({ goal: "tidy downloads", profile: profile() });
  const rambling = scoreSkillForGoal({
    goal: "tidy downloads, and while you are at it could you have a look at the spare room, the garage, and anything else that has piled up over the past several months",
    profile: profile(),
  });
  assert.equal(terse.confidence, rambling.confidence);
  assert.ok(terse.confidence >= SKILL_AUTO_SELECT_MIN_CONFIDENCE);
});

test("the same goal scores the same way twice", () => {
  // The property a planner pass would have given up, and the reason this is a
  // pure function: a user who reruns a task gets the skill they got last time,
  // and the composer can show the answer before the run starts.
  const input = {
    goal: "tidy my downloads folder",
    profiles: [TIDY_DOWNLOADS, profile({ candidate: candidate({ id: "skl_b", slug: "beta" }) })],
  };
  assert.deepEqual(scoreSkillsForGoal(input), scoreSkillsForGoal(input));
});

test("a skill whose name yields no terms is never selected automatically", () => {
  // The tokeniser reads `[a-z0-9]` and nothing else, so a name written in
  // another script has no terms to match. It fails in the safe direction: the
  // skill is un-suggested rather than unusable, and typing its slug still runs
  // it.
  const scored = scoreSkillForGoal({
    goal: "整理する",
    profile: profile({ candidate: candidate({ slug: "id" }), name: "識別", description: "整理" }),
  });
  assert.equal(scored.confidence, 0);
  assert.deepEqual(
    selectSkillAutomatically({ scored: [scored] }),
    { selected: false, reason: "low_confidence" }
  );
});

// ---------------------------------------------------------------------------
// Example evaluation
// ---------------------------------------------------------------------------

function example(overrides: Partial<WorkSkillExample> = {}): WorkSkillExample {
  return {
    name: "moves the invoices",
    input: "tidy the folder",
    expectTools: ["work.file.move"],
    forbidTools: ["work.shell.run"],
    expectContains: ["moved"],
    ...overrides,
  };
}

test("an example passes only when it ran and met every expectation", () => {
  const evaluation = evaluateSkillExamples({
    examples: [example()],
    outcomes: [
      { name: "moves the invoices", output: "Moved 14 files.", toolsUsed: ["work.file.move"] },
    ],
  });
  assert.equal(evaluation.passed, 1);
  assert.equal(evaluation.allPassed, true);
  assert.equal(evaluation.results[0].verdict, "passed");
});

test("a forbidden tool fails the example even when everything else is right", () => {
  const evaluation = evaluateSkillExamples({
    examples: [example()],
    outcomes: [
      {
        name: "moves the invoices",
        output: "Moved 14 files.",
        toolsUsed: ["work.file.move", "work.shell.run"],
      },
    ],
  });
  assert.equal(evaluation.results[0].verdict, "failed");
  assert.ok(evaluation.results[0].detail.includes("work.shell.run"));
  assert.equal(evaluation.allPassed, false);
});

test("a missing tool and missing text are both failures, reported in that order", () => {
  const missingTool = evaluateSkillExamples({
    examples: [example()],
    outcomes: [{ name: "moves the invoices", output: "Moved 14 files.", toolsUsed: [] }],
  });
  assert.equal(missingTool.results[0].verdict, "failed");
  assert.ok(missingTool.results[0].detail.includes("Did not use work.file.move"));

  const missingText = evaluateSkillExamples({
    examples: [example()],
    outcomes: [{ name: "moves the invoices", output: "Nothing to do.", toolsUsed: ["work.file.move"] }],
  });
  assert.equal(missingText.results[0].verdict, "failed");
  assert.ok(missingText.results[0].detail.includes("moved"));
});

test("expected text is matched without regard to capitalisation", () => {
  // A model's capitalisation varies between runs of the same prompt; a
  // case-sensitive check reports a working skill as broken.
  const evaluation = evaluateSkillExamples({
    examples: [example({ expectContains: ["Moved"] })],
    outcomes: [{ name: "moves the invoices", output: "moved 14 files", toolsUsed: ["work.file.move"] }],
  });
  assert.equal(evaluation.results[0].verdict, "passed");
});

test("an example nobody ran is not an example that failed", () => {
  const evaluation = evaluateSkillExamples({ examples: [example()], outcomes: [] });
  assert.equal(evaluation.results[0].verdict, "not_run");
  assert.equal(evaluation.notRun, 1);
  assert.equal(evaluation.failed, 0);
  assert.equal(evaluation.allPassed, false);
});

test("an example needing a withheld tool is not permitted, not failed", () => {
  // The skill is fine and a connector was revoked. Filing that as a failure
  // sends whoever reads the report to rewrite instructions that were never the
  // problem.
  const evaluation = evaluateSkillExamples({
    examples: [example()],
    outcomes: [{ name: "moves the invoices", output: "Moved 14 files.", toolsUsed: [] }],
    permitted: ["work.file.read"],
  });
  assert.equal(evaluation.results[0].verdict, "not_permitted");
  assert.equal(evaluation.notPermitted, 1);
  assert.equal(evaluation.failed, 0);
});

test("a version with no examples has not passed its tests", () => {
  const evaluation = evaluateSkillExamples({ examples: [], outcomes: [] });
  assert.equal(evaluation.allPassed, false);
  assert.equal(evaluation.passed, 0);
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

test("creating a skill states where it came from and cannot state its trust", () => {
  const ok = createSkillSchema.safeParse({
    name: "Tidy Downloads",
    instructions: "Sort by type.",
    origin: "imported",
    trust: "verified",
  });
  assert.equal(ok.success, true);
  // `trust` is not a key of the schema, so zod strips it: an importer cannot
  // arrive already vouched for.
  assert.equal("trust" in (ok.data ?? {}), false);
  assert.equal(ok.data?.autoSelect, false);

  // Origin is required rather than defaulted; it decides the starting trust.
  assert.equal(
    createSkillSchema.safeParse({ name: "x", instructions: "y" }).success,
    false
  );
  assert.equal(
    createSkillSchema.safeParse({ name: "x", instructions: "   ", origin: "authored" }).success,
    false
  );
});

test("a patch that changes nothing is refused", () => {
  assert.equal(patchSkillSchema.safeParse({}).success, false);
  // Unknown keys are stripped, so `{ slug: "x" }` arrives as `{}` and is
  // refused — which is the point, since the slug is deliberately not patchable.
  assert.equal(patchSkillSchema.safeParse({ slug: "renamed" }).success, false);
  assert.equal(patchSkillSchema.safeParse({ enabled: false }).success, true);
});

test("minting a version is either new content or a restore, never both", () => {
  assert.equal(mintSkillVersionSchema.safeParse({ instructions: "Do it better." }).success, true);
  assert.equal(mintSkillVersionSchema.safeParse({ restoreVersion: 3 }).success, true);
  assert.equal(
    mintSkillVersionSchema.safeParse({ instructions: "Do it better.", restoreVersion: 3 }).success,
    false
  );
  assert.equal(mintSkillVersionSchema.safeParse({}).success, false);
  assert.equal(mintSkillVersionSchema.safeParse({ restoreVersion: 0 }).success, false);
});

test("an omitted contract field means this version asks for less, never more", () => {
  const parsed = mintSkillVersionSchema.safeParse({ instructions: "Sort by type." });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.contract, undefined);
  assert.equal(parsed.data?.requestedTools, undefined);
  // Which the route turns into the empty contract — a version that asks for
  // nothing, rather than one that inherits its predecessor's request.
  assert.deepEqual(emptySkillContract().requestedConnectors, []);
});

test("the skill list filters reject a parameter they cannot read", () => {
  const ok = parseSkillListQuery(new URLSearchParams("enabled=true&trust=verified&limit=1000"));
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.query.enabled, true);
  assert.equal(ok.ok && ok.query.trust, "verified");
  assert.equal(ok.ok && ok.query.limit, 200);

  assert.deepEqual(parseSkillListQuery(new URLSearchParams("enabled=maybe")), {
    ok: false,
    parameter: "enabled",
  });
  assert.deepEqual(parseSkillListQuery(new URLSearchParams("trust=godmode")), {
    ok: false,
    parameter: "trust",
  });
  // Unparseable limits fall back rather than 400ing, per the repo's idiom.
  assert.equal(
    parseSkillListQuery(new URLSearchParams("limit=abc")).ok &&
      parseSkillListQuery(new URLSearchParams("limit=abc")).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

function skillRow(overrides: Partial<WorkSkill> = {}): WorkSkill {
  return {
    id: "skl_1",
    userId: "usr_1",
    projectId: null,
    slug: "tidy-downloads",
    name: "Tidy Downloads",
    description: "Sorts the folder by type.",
    currentVersion: 3,
    enabled: true,
    trust: "user_authored",
    autoSelect: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

test("an unreadable trust level serialises as untrusted", () => {
  assert.equal(serializeSkill(skillRow()).trust, "user_authored");
  // Written by a newer deployment. The safe reading of a level we cannot
  // interpret is that it vouches for nothing.
  assert.equal(serializeSkill(skillRow({ trust: "community_reviewed" })).trust, "untrusted");
  assert.equal("deletedAt" in serializeSkill(skillRow()), false);
});

test("a version serialises its request, never a grant", () => {
  // Prisma types the write side and the read side of a JSONB column
  // differently — `InputJsonValue` also admits Date and Uint8Array, which
  // `JsonValue` does not — so a row assembled from what the writer produces has
  // to say which side of that it is standing on.
  const contract = skillContractToJson(
    parseSkillContract({ requestedConnectors: ["gmail"], requestedPolicy: "permissive" })
  ) as Prisma.JsonObject;
  const row: WorkSkillVersion = {
    id: "wsv_3",
    skillId: "skl_1",
    version: 3,
    instructions: "Sort by type.",
    contract,
    contractVersion: 1,
    requestedTools: ["work.file.move", 42],
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  };
  const serialized = serializeSkillVersion(row);
  assert.deepEqual(serialized.requestedTools, ["work.file.move"]);
  assert.deepEqual(serialized.contract.requestedConnectors, ["gmail"]);
  assert.equal(serialized.contract.requestedPolicy, "permissive");
  assert.equal(serialized.createdAt, "2026-01-02T00:00:00.000Z");
});

test("the contract survives a round trip through the JSON column", () => {
  const original = parseSkillContract({
    inputs: [{ name: "folder", kind: "file", required: true }],
    requestedApps: ["Finder"],
    requestedDomains: ["example.com"],
    preferredTarget: "local",
    requestedBudget: { maxCostMicroUsd: 500 },
    examples: [{ name: "one", input: "tidy", expectTools: ["work.file.move"] }],
  });
  assert.deepEqual(parseSkillContract(skillContractToJson(original)), original);
});
