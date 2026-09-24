import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAT_SKILL_REFUSAL_MESSAGES,
  CHAT_SKILL_TOOLS,
  applyChatSkill,
  chatSkillGrantLayer,
  narrowRuntimeToolsForSkill,
  withheldCapabilityCount,
  type ChatSkillCapabilities,
  type ChatSkillVersionRow,
} from "@/lib/chat/skills";
import { chatRuntimeToolAllowlist } from "@/lib/chat/tool-policy";
import { emptySkillContract, type SkillCandidate } from "@/lib/work/skills";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapUntrusted } from "@/lib/untrusted-content";

/*
 * A skill applied to a chat turn.
 *
 * Three properties are load-bearing and each is tested against its opposite,
 * because each has a plausible wrong version that a reader would not notice:
 *
 *   1. The grant NARROWS. A skill asking for web search on a turn with search
 *      off must not get it, and the wrong version of this — an empty grant list
 *      handed to `narrowestGrant` — is mathematically "everything".
 *   2. An IMPORTED skill is enveloped, and the caller is told so. Markers with
 *      no rule above them look like a boundary and are not one, so `untrusted`
 *      has to travel back out of this module rather than being an internal
 *      detail.
 *   3. A skill that declares NO tools narrows nothing. The empty declaration is
 *      the common shape — `allowed-tools` is experimental in the spec and most
 *      authors omit it — and reading it as "wants nothing" would silently strip
 *      web search from every turn that invoked a skill.
 */

const FULL: ChatSkillCapabilities = {
  webSearch: true,
  canvas: true,
  documents: true,
  images: true,
  connectors: ["github", "notion"],
};

const BARE: ChatSkillCapabilities = {
  webSearch: false,
  canvas: false,
  documents: false,
  images: false,
  connectors: [],
};

function candidate(over: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    id: "skill_1",
    slug: "tidy-inbox",
    name: "Tidy inbox",
    description: "Sorts an inbox.",
    enabled: true,
    trust: "user_authored",
    autoSelect: false,
    currentVersion: 2,
    projectId: null,
    ...over,
  };
}

function version(over: Partial<ChatSkillVersionRow> = {}): ChatSkillVersionRow {
  return {
    version: 2,
    instructions: "Archive anything older than a month.",
    contract: emptySkillContract(),
    requestedTools: [],
    securityStatus: "clear",
    requiresConsent: false,
    ...over,
  };
}

const apply = (
  over: {
    slug?: string;
    candidates?: SkillCandidate[];
    version?: ChatSkillVersionRow | null;
    capabilities?: ChatSkillCapabilities;
  } = {}
) =>
  applyChatSkill({
    slug: over.slug ?? "tidy-inbox",
    candidates: over.candidates ?? [candidate()],
    version: over.version === undefined ? version() : over.version,
    capabilities: over.capabilities ?? FULL,
    wrapUntrusted,
  });

// ---------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------

test("the grant is what the turn has, and nothing else", () => {
  const full = chatSkillGrantLayer(FULL);
  assert.deepEqual([...full.tools].sort(), [
    CHAT_SKILL_TOOLS.webFetch,
    CHAT_SKILL_TOOLS.canvas,
    CHAT_SKILL_TOOLS.documents,
    CHAT_SKILL_TOOLS.images,
    CHAT_SKILL_TOOLS.webSearch,
  ].sort());
  assert.deepEqual(full.connectors, ["github", "notion"]);
  // Chat has no app surface and no per-domain allowlist to intersect against,
  // so a skill asking to reach example.com is told it did not get it — which
  // is true — rather than granted something Juno cannot enforce.
  assert.deepEqual(full.apps, []);
  assert.deepEqual(full.domains, []);
  // The narrowest policy in the vocabulary: a chat turn grants no approval
  // authority at all.
  assert.equal(full.policy, "conservative");

  const bare = chatSkillGrantLayer(BARE);
  assert.deepEqual(bare.tools, []);
  assert.deepEqual(bare.connectors, []);
});

test("a skill cannot reach what the turn does not have", () => {
  const contract = emptySkillContract();
  contract.requestedConnectors = ["github", "slack"];
  contract.requestedDomains = ["example.com"];

  const outcome = apply({
    version: version({
      contract,
      requestedTools: [CHAT_SKILL_TOOLS.webSearch, CHAT_SKILL_TOOLS.canvas],
    }),
    capabilities: { ...FULL, webSearch: false },
  });
  assert.equal(outcome.applied, true);
  if (!outcome.applied) return;

  const { resolved } = outcome.application;
  assert.deepEqual(resolved.tools, [CHAT_SKILL_TOOLS.canvas]);
  assert.deepEqual(resolved.withheld.tools, [CHAT_SKILL_TOOLS.webSearch]);
  assert.deepEqual(resolved.connectors, ["github"]);
  assert.deepEqual(resolved.withheld.connectors, ["slack"]);
  assert.deepEqual(resolved.withheld.domains, ["example.com"]);
  assert.equal(withheldCapabilityCount(resolved), 3);
});

test("what was withheld is said to the model, outside the envelope", () => {
  const outcome = apply({
    candidates: [candidate({ trust: "untrusted" })],
    version: version({ requestedTools: ["Bash", "Read", "Write"] }),
    capabilities: BARE,
  });
  assert.equal(outcome.applied, true);
  if (!outcome.applied) return;

  const suffix = outcome.application.systemSuffix;
  assert.match(suffix, /Bash, Read, Write/);
  assert.match(suffix, /this is a chat turn/);
  // The caveat is Juno speaking ABOUT the skill. Inside the markers it would be
  // text the model is told is never an instruction — a warning written where it
  // is explicitly disregarded.
  assert.ok(suffix.indexOf(UNTRUSTED_CLOSE) < suffix.indexOf("this is a chat turn"));
});

test("a skill that asked for nothing produces no withheld note", () => {
  const outcome = apply();
  assert.equal(outcome.applied, true);
  if (!outcome.applied) return;
  assert.equal(withheldCapabilityCount(outcome.application.resolved), 0);
  assert.doesNotMatch(outcome.application.systemSuffix, /does not have/);
});

// ---------------------------------------------------------------------------
// Trust and the envelope
// ---------------------------------------------------------------------------

test("an imported skill is enveloped and says so; one the user wrote is not", () => {
  const imported = apply({ candidates: [candidate({ trust: "untrusted" })] });
  assert.equal(imported.applied, true);
  if (imported.applied) {
    assert.equal(imported.application.untrusted, true);
    assert.ok(imported.application.systemSuffix.includes(UNTRUSTED_OPEN));
    assert.ok(imported.application.systemSuffix.includes(UNTRUSTED_CLOSE));
  }

  const authored = apply();
  assert.equal(authored.applied, true);
  if (authored.applied) {
    // Enveloping a skill the user typed themselves would be telling the model
    // to disregard its own author.
    assert.equal(authored.application.untrusted, false);
    assert.ok(!authored.application.systemSuffix.includes(UNTRUSTED_OPEN));
  }
});

test("the block says the user named the skill, because in chat they always did", () => {
  const outcome = apply();
  assert.equal(outcome.applied, true);
  if (!outcome.applied) return;
  assert.match(outcome.application.systemSuffix, /The user invoked this skill by name\./);
  // Chat has no automatic selection, so the sentence that tells a model the
  // user may not know the skill exists must never appear here.
  assert.doesNotMatch(outcome.application.systemSuffix, /Juno matched this skill/);
  assert.match(outcome.application.systemSuffix, /# Skill: tidy-inbox \(version 2\)/);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("every refusal is a reason, and the version-level ones produce no text at all", () => {
  assert.deepEqual(apply({ slug: "nope" }), { applied: false, reason: "unknown_slug" });
  assert.deepEqual(apply({ candidates: [candidate({ enabled: false })] }), {
    applied: false,
    reason: "disabled",
  });
  // A head row pointing at a version that is not there: the skill exists, so
  // `unknown_slug` would be the wrong sentence.
  assert.deepEqual(apply({ version: null }), { applied: false, reason: "no_candidate" });
  // Work clamps `enabled` on write when the scanner refuses a version, but a
  // later PATCH can switch it back on — so chat checks the version it is about
  // to read rather than trusting a column written earlier.
  assert.deepEqual(apply({ version: version({ securityStatus: "blocked" }) }), {
    applied: false,
    reason: "blocked",
  });
  assert.deepEqual(apply({ version: version({ requiresConsent: true }) }), {
    applied: false,
    reason: "consent_required",
  });
});

test("every refusal has a sentence the reader can be shown", () => {
  for (const [reason, message] of Object.entries(CHAT_SKILL_REFUSAL_MESSAGES)) {
    assert.match(message, /^[A-Z].*\.$/, reason);
    assert.doesNotMatch(message, /[—–]/, reason);
  }
});

test("a refused skill is said to the reader on both paths, once the stream is open", () => {
  // The composer showed the skill armed, so a refusal that only reached the
  // audit log left the reader believing it ran. Pinned on the source because
  // both call sites sit inside stream bodies no unit test can reach.
  const route = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  const privateBranch = route.slice(route.indexOf("if (input.privateMode) {"), route.indexOf("const durableFirstSubmission"));
  const savedStream = route.slice(route.indexOf("const generate = async ("));
  const refusalRow = (outcome: string) =>
    new RegExp(
      `if \\(${outcome} && !${outcome}\\.applied\\) \\{\\s*sendActivity\\(\\{\\s*kind: "warning",\\s*title: "Skill not applied",\\s*detail: CHAT_SKILL_REFUSAL_MESSAGES\\[${outcome}\\.reason\\],`
    );

  assert.match(privateBranch, refusalRow("privateSkill"));
  assert.ok(
    privateBranch.indexOf('title: "Skill not applied"') > privateBranch.indexOf("createSseSender(controller)"),
    "the private row is sent inside the stream, not before it exists"
  );
  assert.match(savedStream, refusalRow("skillOutcome"));
  // One row per turn: a path that sent it twice would read as two skills.
  assert.equal(route.split('title: "Skill not applied"').length - 1, 2);
});

test("trust does not gate explicit invocation — the user typed the name", () => {
  const outcome = apply({ candidates: [candidate({ trust: "untrusted", autoSelect: false })] });
  assert.equal(outcome.applied, true);
});

test("a skill filed in another project is still reachable by name", () => {
  // `skillIsOfferedTo` governs AUTOMATIC selection only. Refusing here would
  // teach people to keep every skill at the account level, which empties the
  // filing out.
  const outcome = apply({ candidates: [candidate({ projectId: "project_other" })] });
  assert.equal(outcome.applied, true);
});

// ---------------------------------------------------------------------------
// Runtime tools
// ---------------------------------------------------------------------------

test("a skill narrows the runtime tools and can never widen them", () => {
  const allowlist = chatRuntimeToolAllowlist({ webSearch: true, documents: true, images: true });
  const outcome = apply({ version: version({ requestedTools: [CHAT_SKILL_TOOLS.documents] }) });
  assert.equal(outcome.applied, true);
  if (!outcome.applied) return;

  assert.deepEqual(narrowRuntimeToolsForSkill(allowlist, outcome.application), [
    CHAT_SKILL_TOOLS.documents,
  ]);

  // A tool the turn never had cannot appear, however the skill declares it: the
  // filter runs over the allowlist, not over the request.
  const greedy = apply({
    version: version({ requestedTools: [CHAT_SKILL_TOOLS.webFetch, CHAT_SKILL_TOOLS.documents] }),
    capabilities: { ...FULL, webSearch: false },
  });
  assert.equal(greedy.applied, true);
  if (!greedy.applied) return;
  assert.deepEqual(
    narrowRuntimeToolsForSkill(chatRuntimeToolAllowlist({ documents: true, webSearch: false }), greedy.application),
    [CHAT_SKILL_TOOLS.documents]
  );
});

test("a skill declaring no tools leaves the turn's own tools alone", () => {
  const allowlist = chatRuntimeToolAllowlist({ webSearch: true, documents: true, images: true });
  const outcome = apply();
  assert.equal(outcome.applied, true);
  if (!outcome.applied) return;
  // The alternative reading — empty means "wants nothing" — would silently take
  // web search away from every turn that invoked a skill, and a skill is not a
  // way to remove capabilities from a conversation the reader configured.
  assert.deepEqual(narrowRuntimeToolsForSkill(allowlist, outcome.application), allowlist);
  assert.deepEqual(narrowRuntimeToolsForSkill(allowlist, null), allowlist);
});

// ---------------------------------------------------------------------------
// The chat rework's tools and the old names (SPEC §3.5, INV-23)
// ---------------------------------------------------------------------------

test("the grant names every chat tool the turn carries, and the page reader rides web search", () => {
  const all = chatSkillGrantLayer({ ...FULL, code: true, chats: true, time: true, calculate: true, research: true });
  assert.deepEqual([...all.tools].sort(), [
    "calculate", "canvas", "current_time", "inspect_image", "read_document", "run_code",
    "search_chats", "suggest_research", "web_fetch", "web_search",
  ]);
  // Absent new capabilities are not granted; web_fetch follows web search unless said otherwise.
  assert.deepEqual(chatSkillGrantLayer({ ...BARE, webSearch: true }).tools, ["web_search", "web_fetch"]);
  assert.deepEqual(chatSkillGrantLayer({ ...BARE, webSearch: true, webFetch: false }).tools, ["web_search"]);
  assert.deepEqual(Object.keys(CHAT_SKILL_TOOLS).sort(), [
    "calculate", "canvas", "chats", "code", "documents", "images", "research", "time", "webFetch", "webSearch",
  ], "the deprecated `browser` key is gone: nothing reads it");
});

test("a skill stored with browser_agent or code_interpreter still means web_fetch and run_code", () => {
  const outcome = apply({
    version: version({ requestedTools: ["browser_agent", "code_interpreter"] }),
    capabilities: { ...FULL, code: true },
  });
  assert.equal(outcome.applied, true);
  if (!outcome.applied) return;
  assert.deepEqual([...outcome.application.resolved.tools].sort(), ["run_code", "web_fetch"]);
  assert.deepEqual(outcome.application.resolved.withheld.tools, []);
  // Narrowing reads the old names the same way, on either side.
  assert.deepEqual(
    narrowRuntimeToolsForSkill(["read_document", "code_interpreter", "run_code"], outcome.application),
    ["code_interpreter", "run_code"],
  );
});
