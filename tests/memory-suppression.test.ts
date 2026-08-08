import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findSuppression,
  guardedMemoryWrite,
  normalizeStatement,
  screenMemoryWrite,
} from "@/lib/memory-suppression";
import {
  backgroundDenialMessage,
  resolveBackgroundCandidates,
  type UtilityCandidate,
} from "@/lib/background-provider-policy";

/*
 * Three defects, one file, because they share a victim: the user who told Juno
 * to forget something and was not obeyed, or who asked it to tidy their memory
 * and was told a lie about why nothing happened.
 *
 * 1. Suppression was enforced by exactly one writer. `saveCandidates()` checked
 *    the block-list; the manual add, the entry PATCH, the applied
 *    natural-language edit and the native sync mutations did not. So "forget my
 *    old job" held against the extractor and failed against a keyboard.
 * 2. `consolidateMemories()` had two paths and only one was policy-checked —
 *    and production always took the other, sending distilled memory to a
 *    provider the account's policy forbade.
 * 3. `/api/memory/edit` could not tell a policy denial from a provider failure
 *    and reported both as a rate limit, which for the default policy was false
 *    100% of the time.
 *
 * No database: the rule lives in a Prisma-free module and the door takes its
 * writer as an argument. The parts that are wiring rather than rule are checked
 * by reading the route sources, the way tests/ownership-guard.test.ts does.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const FORGET_JOB = "The user works at Acme as a staff designer.";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("matching ignores case, punctuation and spacing", () => {
  // A block-list that a full stop could defeat would be theatre.
  assert.equal(normalizeStatement("The user works at ACME!"), "the user works at acme");
  assert.equal(
    findSuppression("the user works at acme", ["The user works at ACME!"]),
    "The user works at ACME!"
  );
});

test("a suppression catches both the longer fact and the shorter paraphrase", () => {
  // Containment runs both ways on purpose: the model rephrases, and a
  // suppression that only caught verbatim repeats would catch almost nothing.
  assert.equal(findSuppression(FORGET_JOB, ["works at Acme"]), "works at Acme");
  assert.equal(findSuppression("works at Acme", [FORGET_JOB]), FORGET_JOB);
  assert.equal(findSuppression("The user lives in Lisbon.", ["works at Acme"]), null);
});

test("an empty suppression matches nothing", () => {
  // Otherwise one blank row in the table would silence the entire memory.
  assert.equal(findSuppression("The user lives in Lisbon.", ["", "   "]), null);
});

test("a suppression write is not screened against the block-list", () => {
  // Suppressions ARE the block-list. Screening them would make "forget my old
  // job" refuse itself the second time, and would make un-forget/re-forget
  // impossible from the memory editor.
  const decision = screenMemoryWrite({
    content: FORGET_JOB,
    kind: "SUPPRESSION",
    suppressions: [FORGET_JOB],
  });
  assert.equal(decision.ok, true);
});

test("a refusal names the suppression it is honouring", () => {
  const decision = screenMemoryWrite({ content: FORGET_JOB, suppressions: ["works at Acme"] });
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.reason, "suppressed");
  if (decision.ok) return;
  assert.equal(decision.reason === "suppressed" && decision.suppression, "works at Acme");
  // The UI shows this verbatim, so it has to say what was honoured and what to
  // do about it — "Invalid input" would look like a bug in Juno.
  assert.match(decision.reason === "suppressed" ? decision.message : "", /forget/i);
  assert.match(decision.reason === "suppressed" ? decision.message : "", /works at Acme/);
});

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

/** Stands in for one write path: records whether the table was touched. */
function fakeWriter() {
  const written: string[] = [];
  return { written, write: async (content: string) => (written.push(content), { id: "m1" }) };
}

test("the door does not run the write when the content is suppressed", async () => {
  const w = fakeWriter();
  const outcome = await guardedMemoryWrite({
    content: FORGET_JOB,
    loadSuppressions: async () => ["works at Acme"],
    write: w.write,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "suppressed");
  // The point of the callback shape: no call site can reach the table except
  // through `write`, and `write` never ran.
  assert.deepEqual(w.written, []);
});

test("the door runs the write, trimmed and capped, when nothing covers it", async () => {
  const w = fakeWriter();
  const outcome = await guardedMemoryWrite({
    content: `  ${"x".repeat(600)}  `,
    loadSuppressions: async () => ["works at Acme"],
    write: w.write,
  });
  assert.equal(outcome.ok, true);
  assert.equal(w.written.length, 1);
  assert.equal(w.written[0].length, 500);
});

test("blank content is refused as empty, not as suppressed", async () => {
  const w = fakeWriter();
  const outcome = await guardedMemoryWrite({
    content: "   …   ",
    loadSuppressions: async () => {
      throw new Error("the block-list must not be read for content that cannot be written");
    },
    write: w.write,
  });
  assert.equal(outcome.ok === false && outcome.reason, "empty");
  assert.deepEqual(w.written, []);
});

test("a suppression write skips the block-list read entirely", async () => {
  const w = fakeWriter();
  const outcome = await guardedMemoryWrite({
    content: FORGET_JOB,
    kind: "SUPPRESSION",
    loadSuppressions: async () => {
      throw new Error("suppressions must not be screened against themselves");
    },
    write: w.write,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(w.written, [FORGET_JOB]);
});

test("every write path refuses the suppressed statement", async () => {
  // One case per production writer. Each supplies the same shape the real call
  // site does; what is being asserted is that the decision is identical no
  // matter which door handle you pull — which is exactly what was not true.
  const paths = [
    { name: "extractor (saveCandidates)", kind: "FACT" as const },
    { name: "manual add (POST /api/memory)", kind: "FACT" as const },
    { name: "entry rewrite (PATCH /api/memory/[id])", kind: "FACT" as const },
    { name: "applied edit (POST /api/memory/edit/apply)", kind: "FACT" as const },
    { name: "native sync (memory.create / memory.update)", kind: "FACT" as const },
  ];
  for (const path of paths) {
    const w = fakeWriter();
    const outcome = await guardedMemoryWrite({
      content: FORGET_JOB,
      kind: path.kind,
      loadSuppressions: async () => ["works at Acme"],
      write: w.write,
    });
    assert.equal(outcome.ok, false, `${path.name} wrote a suppressed statement`);
    assert.deepEqual(w.written, [], `${path.name} touched the table`);
  }
});

// ---------------------------------------------------------------------------
// Wiring: no writer may reach MemoryEntry around the door
// ---------------------------------------------------------------------------

/**
 * Every path that writes MemoryEntry must screen the statement against the
 * block-list first. There are three sanctioned ways to do that, and the second
 * test below proves they all resolve to ONE rule — findSuppression — so this is
 * not three chances to get it subtly different.
 *
 *  - guardedMemoryWrite(): the callback door. The write is an argument, so it
 *    cannot run on refusal. Preferred wherever the write is a single create.
 *  - screenMemoryWrite(): the same rule as a plain check plus an early return.
 *    Used where the write is a partial update the door's shape cannot wrap.
 *  - planFactIngestion(): the lifecycle planner. It screens before deciding
 *    whether a fact is created, refreshed, or supersedes an older one, so it
 *    subsumes the door rather than skipping it.
 *
 * A file that writes MemoryEntry and names none of these is a writer that never
 * asked — which is precisely the defect this suite exists to prevent recurring.
 */
const SCREENED_BY = new Map<string, string>([
  ["src/lib/memory.ts", "planFactIngestion"],
  ["src/app/api/memory/route.ts", "guardedMemoryWrite"],
  ["src/app/api/memory/[id]/route.ts", "screenMemoryWrite"],
  ["src/app/api/memory/edit/apply/route.ts", "guardedMemoryWrite"],
  ["src/app/api/v1/mutations/route.ts", "guardedMemoryWrite"],
]);

const SCREENING_MECHANISMS = ["guardedMemoryWrite", "screenMemoryWrite", "planFactIngestion"];

test("every memory write site screens against the block-list first", () => {
  // The defect was not a wrong rule, it was writers that never asked. This
  // fails the moment one is added the old way.
  for (const [file, mechanism] of SCREENED_BY) {
    const text = src(file);
    const writes = [...text.matchAll(/memoryEntry\.(create|update|updateMany|upsert)\b/g)];
    if (writes.length === 0) continue;
    assert.ok(
      text.includes(mechanism),
      `${file} writes MemoryEntry but does not screen with ${mechanism}`
    );
    assert.ok(
      SCREENING_MECHANISMS.some((m) => text.includes(m)),
      `${file} writes MemoryEntry with no recognised screening mechanism`
    );
  }
});

test("the door leaves no unscreened write behind it", () => {
  // Stronger than "the symbol appears": for the files that use the callback
  // door, strip every guardedMemoryWrite({...}) block and assert nothing is
  // left writing. Brace-matched rather than regex-greedy so a nested object
  // literal cannot swallow the rest of the file.
  for (const [file, mechanism] of SCREENED_BY) {
    if (mechanism !== "guardedMemoryWrite") continue;
    const text = src(file);
    let stripped = "";
    for (let i = 0; i < text.length; ) {
      const start = text.indexOf("guardedMemoryWrite(", i);
      if (start === -1) {
        stripped += text.slice(i);
        break;
      }
      stripped += text.slice(i, start);
      let depth = 0;
      let j = text.indexOf("(", start);
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      i = j + 1;
    }
    // Only writes that can SET CONTENT matter here. Suppression is a rule about
    // statements, so a write whose data cannot carry one — clearing a
    // supersededById back-pointer, stamping lastVerifiedAt — has nothing to
    // screen and is deliberately allowed outside the door. Narrowing this to
    // content-bearing writes is what keeps the assertion true AND meaningful;
    // widening it back would make the test fail for writes that are safe by
    // construction, and the usual fix for that is to delete the test.
    const escaped = [...stripped.matchAll(/memoryEntry\.(create|update|updateMany|upsert)\b/g)].filter((m) => {
      const open = stripped.indexOf("(", m.index! + m[0].length);
      if (open === -1) return true;
      let depth = 0;
      let end = open;
      for (; end < stripped.length; end++) {
        if (stripped[end] === "(") depth++;
        else if (stripped[end] === ")" && --depth === 0) break;
      }
      return /\bcontent\s*:/.test(stripped.slice(open, end));
    });
    assert.deepEqual(
      escaped.map((m) => m[0]),
      [],
      `${file} writes MemoryEntry content without going through guardedMemoryWrite`
    );
  }
});

test("all three screening mechanisms resolve to the same suppression rule", () => {
  // Memory v2's lifecycle arrived with its own suppression matcher built on a
  // SORTED token set — right for asking "is this the same fact reworded", wrong
  // for "does this suppression cover it", because substring containment over a
  // sorted set is not containment of a phrase. Two rules would drift, and the
  // one users rely on when they say "forget my address" is the phrase one.
  const lifecycle = src("src/lib/memory-lifecycle.ts");
  assert.ok(
    lifecycle.includes("findSuppression"),
    "memory-lifecycle must delegate suppression matching, not reimplement it"
  );
  assert.equal(
    (lifecycle.match(/normalizedSuppression/g) ?? []).length,
    0,
    "memory-lifecycle still carries its own suppression matcher"
  );
});

// ---------------------------------------------------------------------------
// Defect 2: consolidation may not have an unchecked path
// ---------------------------------------------------------------------------

/**
 * The CODE of one top-level `export async function <name>`, comments removed.
 *
 * Stripping comments matters: this file's assertions are about what the
 * function does, and the comments in memory.ts name the removed constructs
 * (`opts.model`, `streamChat`) precisely because they explain why they went.
 * Without this, the prose describing the fix would fail the test for the fix.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — this test is reading the wrong thing`);
  const next = source.indexOf("\nexport ", start + 1);
  return source
    .slice(start, next === -1 ? source.length : next)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("consolidateMemories has no path that streams a model directly", () => {
  // The removed branch: `if (opts.llm || !opts.model)` went through
  // runUtilityPrompt (policy-checked) and the else called streamChat() with no
  // resolveBackgroundCandidates at all. maybeConsolidate() always passes a
  // model, so the unchecked branch was the one that ran in production, after
  // nearly every chat turn.
  const body = functionBody(src("src/lib/memory.ts"), "consolidateMemories");
  assert.equal(/\bstreamChat\s*\(/.test(body), false, "consolidateMemories streams a model directly again");
  assert.equal(/\brunUtilityPrompt\s*\(/.test(body), true);
});

test("consolidation never matches the policy against the background model's own provider", () => {
  // The subtler second version of defect 2, caught while fixing the first:
  // maybeConsolidate() received `utilityModelCandidates()[0]`, chosen with no
  // reference to the conversation at all. Feeding that model's provider in as
  // the conversationProvider makes `same_provider` a tautology — the worker
  // vouching for itself — so consolidateMemories no longer takes a model, and
  // the chat route contributes only the provider the USER picked for the turn.
  const body = functionBody(src("src/lib/memory.ts"), "consolidateMemories");
  assert.equal(/opts\.model/.test(body), false, "consolidateMemories reads a caller-supplied model again");
  assert.match(body, /accountBackgroundProvider\(/);

  const chat = src("src/app/api/chat/route.ts");
  assert.match(chat, /maybeConsolidate\(user\.id, modelInfo\.provider\)/);
  assert.equal(/maybeConsolidate\([^)]*cheapModel/.test(chat), false, "the chat route feeds back the worker's own model");
});

test("a single permitted candidate is filtered like any other", () => {
  // Narrowing the field never grants an exemption: a local_only account offered
  // one cloud model gets nothing, rather than a quiet cross-provider send.
  const chosen: UtilityCandidate = { id: "gpt-mini", provider: "openai" };
  const denied = resolveBackgroundCandidates({
    policy: { mode: "local_only" },
    conversationProvider: "openai",
    candidates: [chosen],
  });
  assert.deepEqual(denied.candidates, []);
  assert.equal(denied.deniedReason, "no_local_model");

  const allowed = resolveBackgroundCandidates({
    policy: { mode: "same_provider" },
    conversationProvider: "openai",
    candidates: [chosen],
  });
  assert.deepEqual(allowed.candidates.map((c) => c.id), ["gpt-mini"]);
});

// ---------------------------------------------------------------------------
// Defect 3: a denial is not an outage
// ---------------------------------------------------------------------------

const CANDIDATES: UtilityCandidate[] = [
  { id: "claude-haiku", provider: "anthropic" },
  { id: "gpt-mini", provider: "openai" },
];

test("the default policy denies memory work when no provider is named", () => {
  // This is defect 3's cause, not a hypothetical: /api/memory/edit passed no
  // conversationProvider, and same_provider is the mode every account is
  // migrated to. Every draft on a stock account was denied.
  const decision = resolveBackgroundCandidates({
    policy: { mode: "same_provider" },
    conversationProvider: null,
    candidates: CANDIDATES,
  });
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.deniedReason, "no_candidate_for_conversation_provider");
});

test("naming the account's own provider makes the same request succeed", () => {
  // The fix: the account's default chat model names the provider the user has
  // already chosen to trust with this content.
  const decision = resolveBackgroundCandidates({
    policy: { mode: "same_provider" },
    conversationProvider: "anthropic",
    candidates: CANDIDATES,
  });
  assert.deepEqual(decision.candidates.map((c) => c.id), ["claude-haiku"]);
  assert.equal(decision.deniedReason, undefined);
});

test("a denial message states the rule and never blames a rate limit", () => {
  const message = backgroundDenialMessage("no_candidate_for_conversation_provider");
  assert.match(message, /provider you chat with/);
  // The shipped copy said "The AI providers are rate-limited right now — wait a
  // minute and try again." for a condition that waiting cannot change.
  assert.equal(/rate.?limit|out of credits|try again in a moment/i.test(message), false);
  // And it has to say where to change it, or the user is stuck.
  assert.match(message, /Settings/);
});

test("every denial reason has its own honest explanation", () => {
  const reasons = [
    "no_candidate_for_conversation_provider",
    "selected_provider_unavailable",
    "no_local_model",
    "excluded_by_allowlist",
    "no_candidates",
  ] as const;
  const seen = new Set<string>();
  for (const reason of reasons) {
    const message = backgroundDenialMessage(reason);
    assert.equal(/rate.?limit/i.test(message), false, `${reason} blames a rate limit`);
    assert.equal(seen.has(message), false, `${reason} reuses another reason's wording`);
    seen.add(message);
  }
  // "nothing is configured" is a deployment fact, not a setting the user can
  // change — pointing them at one would be its own small lie.
  assert.equal(/Settings/.test(backgroundDenialMessage("no_candidates")), false);
});

test("the memory routes answer a denial and a provider failure differently", () => {
  // Same-status, same-prose was the whole bug. The client has to be able to
  // tell "a rule refused" from "upstream broke" without parsing English.
  for (const file of ["src/app/api/memory/edit/route.ts", "src/app/api/memory/consolidate/route.ts"]) {
    const text = src(file);
    assert.match(text, /background_policy_denied/, `${file} does not report policy denials distinctly`);
    assert.match(text, /status:\s*409/, `${file} does not answer a denial with 409`);
    assert.match(text, /provider_failed/, `${file} does not report provider failures distinctly`);
  }
  // And the false claim itself is gone.
  assert.equal(
    /The AI providers are rate-limited/.test(src("src/app/api/memory/edit/route.ts")),
    false
  );
});

test("the memory edit route hands the policy a real provider", () => {
  const body = src("src/app/api/memory/edit/route.ts");
  assert.match(body, /accountBackgroundProvider\(/);
  assert.match(body, /loadBackgroundProviderPolicy\(/);
  assert.match(body, /conversationProvider/);
});
