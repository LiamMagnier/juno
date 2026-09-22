import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SENSITIVE_TOPICS,
  normalizeSensitiveTopics,
  sensitiveRefusalMessage,
  sensitiveTopicLabel,
  sensitiveTopicOf,
  sensitiveWriteDecision,
} from "@/lib/memory-sensitive";
import { planFactIngestion, type LifecycleEntry } from "@/lib/memory-lifecycle";

/*
 * Two features and three regressions, in one file, because they share a page.
 *
 * THE FEATURE. Juno extracted durable facts from every conversation with no
 * notion that some subjects are not the same as others: a diagnosis mentioned
 * once while drafting an email became a permanent line in the memory profile,
 * on the same terms as a preference for metric units. The gate in
 * `memory-sensitive.ts` refuses six subjects unless the account has asked for
 * them, and the tests below pin both halves of that — what counts as sensitive,
 * and what the gate does about it.
 *
 * THE REGRESSIONS. The memory page had lost its wiring in three ways that no
 * type-checker could see, and each one is a shape a test CAN see:
 *
 *   1. It POSTed to `/api/memory/instruct`, which does not exist. Every
 *      instruction the user typed 404'd and was reported as "Couldn't update
 *      memory". A string URL is invisible to tsc; it is not invisible to a
 *      test that resolves each one against the route tree.
 *   2. `EntryList` and `EditsPanel` were finished components nothing imported,
 *      so the page could show a summary and no rows — nothing to point at when
 *      a fact was wrong. An unused export is not an error either.
 *   3. Pausing memory called the app provider's `setSettings`, which is React
 *      state and no request, so the switch forgot itself on reload.
 *
 * No database and no browser: the rule is a Prisma-free module, and the wiring
 * is checked by reading the sources, the way tests/memory-suppression.test.ts
 * does.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const repoPath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

test("a marker word decides its topic on its own", () => {
  assert.equal(sensitiveTopicOf("The user was diagnosed with type 1 diabetes."), "health");
  assert.equal(sensitiveTopicOf("The user attends a synagogue in Lisbon."), "religion");
  assert.equal(sensitiveTopicOf("The user voted Green in the last election."), "politics");
  assert.equal(sensitiveTopicOf("The user is non-binary and uses they/them."), "sexuality");
  assert.equal(sensitiveTopicOf("The user has £40,000 of student debt."), "finances");
  assert.equal(sensitiveTopicOf("The user's ethnicity is a recurring theme in their writing."), "ethnicity");
});

test("an ordinary durable fact is not sensitive", () => {
  for (const fact of [
    "The user prefers short explanations with code examples.",
    "The user lives in Lisbon and works as a staff designer.",
    "The user is learning Japanese for an exam in March.",
    "The user's main project is a Next.js chat app called Juno.",
    "The user prefers metric units.",
  ]) {
    assert.equal(sensitiveTopicOf(fact), null, fact);
  }
});

test("a field of work is not a fact about the person", () => {
  // The first version accepted a vague "subject word" (clinic, doctor,
  // heritage) whenever the sentence had a verb like "is" — which every
  // extracted fact has. Markers only, now.
  assert.equal(sensitiveTopicOf("Their team builds software for health clinics."), null);
  assert.equal(sensitiveTopicOf("The user is building a doctor appointment app."), null);
  assert.equal(sensitiveTopicOf("The user has a chronic condition."), "health");
});

/*
 * The two lists below are the classifier's contract, and they exist because
 * the first version failed BOTH at once: 9 of 9 plainly sensitive facts went
 * through (every pattern ended in `\b`, so no plural and no open stem could
 * ever match), and 11 of 12 innocent facts were refused — most of them ordinary
 * developer English. A change to TOPIC_RULES that trades one error for the
 * other now has to say so here.
 */
const MUST_FLAG: [string, string][] = [
  // Plurals and stems — the words the first version could never match.
  ["The user gets migraines.", "health"],
  ["The user has food allergies.", "health"],
  ["The user had two surgeries last year.", "health"],
  ["The user has schizophrenia.", "health"],
  ["The user sees a psychiatrist.", "health"],
  ["The user has dyslexia.", "health"],
  ["The user is going through menopause.", "health"],
  ["The user takes medications daily.", "health"],
  ["The user is in therapy for anxiety.", "health"],
  ["The user has two mortgages.", "finances"],
  ["The user earns a salary of 60k.", "finances"],
  ["The user came out as gay last year.", "sexuality"],
  ["The user is a practising Muslim.", "religion"],
  ["The user emigrated from Brazil as a refugee.", "ethnicity"],
  ["The user is of Black Caribbean heritage.", "ethnicity"],
  ["The user is a Labour Party member.", "politics"],
];

const MUST_NOT_FLAG = [
  // Developer English the first version refused to remember.
  "The user writes race-condition-free code.",
  "The user is building a progressive web app.",
  "The user's app came out last week.",
  "The user's new release comes out on Friday.",
  "The user broke the build yesterday.",
  "The user is implementing gradient descent.",
  "The user built a PoC for the payments API.",
  "The user's editor theme is black.",
  "The user prefers white backgrounds and black text.",
  "The user takes a conservative approach to refactoring.",
  "The user is making the spiritual successor to a 90s game.",
  // Everyday English.
  "The user lent their laptop to a colleague.",
  "The user is training for a race.",
  "The user uses visual aids in talks.",
  "The user manages the operations team.",
  "The user has faith in test-driven development.",
  "The user works at a heritage railway.",
  "The user is a Temple University alumnus.",
];

for (const [fact, topic] of MUST_FLAG) {
  test(`flags ${topic}: ${fact}`, () => {
    assert.equal(sensitiveTopicOf(fact), topic);
  });
}

for (const fact of MUST_NOT_FLAG) {
  test(`does not flag: ${fact}`, () => {
    assert.equal(sensitiveTopicOf(fact), null);
  });
}

test("no pattern ends in an open stem that no real word can complete", () => {
  /*
   * The structural form of bug 1. A marker like `psychiatr` followed by `\b`
   * matches nothing, ever, because the next letter of any real word is a word
   * character. Every alternative must be a complete word or end in an
   * explicit inflection group. Checked against the source so a new open stem
   * fails here before it silently fails in production.
   */
  const source = readFileSync(new URL("../src/lib/memory-sensitive.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const TOPIC_RULES"), source.indexOf("export function sensitiveTopicOf"));
  for (const stem of ["schizophreni|", "psychiatr|", "dyslexi|", "menopaus|", "anorexi|", "bulimi|", "alcoholi|", "insolven|", "foreclos|"]) {
    assert.equal(block.includes(stem), false, `open stem ${stem} can never match a word`);
  }
});

test("a marker fires even when the sentence attributes nothing", () => {
  // Markers need no verb: "chemotherapy" has no innocent reading worth
  // preserving, and a gate that waited for "the user has…" would miss the
  // terse note an extractor sometimes writes.
  assert.equal(sensitiveTopicOf("Chemotherapy, weekly, on Tuesdays."), "health");
});

test("empty content is never sensitive", () => {
  assert.equal(sensitiveTopicOf(""), null);
});

test("every topic has copy, and an unknown id still renders", () => {
  for (const topic of SENSITIVE_TOPICS) {
    assert.ok(sensitiveTopicLabel(topic).length > 0);
    assert.match(sensitiveRefusalMessage(topic), /Settings → Memory/);
  }
  assert.equal(sensitiveTopicLabel("astrology"), "Sensitive");
  assert.equal(sensitiveTopicLabel(null), "Sensitive");
});

test("an unrecognised opt-in grants nothing", () => {
  // The column is TEXT[], so a value written by a newer build (or by hand) can
  // name a topic this build has never heard of. Dropping it is the safe read.
  assert.deepEqual(normalizeSensitiveTopics(["health", "astrology"]), ["health"]);
  assert.deepEqual(normalizeSensitiveTopics(null), []);
  assert.deepEqual(normalizeSensitiveTopics(undefined), []);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const DIAGNOSIS = "The user was diagnosed with ADHD in 2019.";

test("a sensitive fact is refused when its topic is off", () => {
  const decision = sensitiveWriteDecision(DIAGNOSIS, []);
  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.topic, "health");
});

test("opting into the topic admits the same fact", () => {
  assert.equal(sensitiveWriteDecision(DIAGNOSIS, ["health"]).ok, true);
});

test("opting into a DIFFERENT topic does not admit it", () => {
  assert.equal(sensitiveWriteDecision(DIAGNOSIS, ["religion", "finances"]).ok, false);
});

test("omitting the opt-in list refuses, rather than defaulting to yes", () => {
  // The caller that forgets to pass the list is exactly the caller that has
  // not thought about the question, so the default has to be the private one.
  assert.equal(sensitiveWriteDecision(DIAGNOSIS, undefined).ok, false);
  assert.equal(sensitiveWriteDecision(DIAGNOSIS, null).ok, false);
});

test("non-sensitive content passes whatever is opted into", () => {
  const fact = "The user prefers short explanations.";
  assert.equal(sensitiveWriteDecision(fact, []).ok, true);
  assert.equal(sensitiveWriteDecision(fact, [...SENSITIVE_TOPICS]).ok, true);
});

// ---------------------------------------------------------------------------
// The gate, inside the ingestion plan
// ---------------------------------------------------------------------------

const emptyContext = { entries: [] as LifecycleEntry[], suppressions: [] as string[], now: new Date() };

test("an extracted sensitive fact is skipped, and says which topic refused it", () => {
  const plan = planFactIngestion({ content: DIAGNOSIS, source: "AUTO" }, emptyContext);
  assert.equal(plan.action, "skip");
  assert.equal(plan.action === "skip" && plan.reason, "sensitive");
  assert.equal(plan.action === "skip" && plan.reason === "sensitive" && plan.topic, "health");
});

test("the same fact is created once the account opts in", () => {
  const plan = planFactIngestion(
    { content: DIAGNOSIS, source: "AUTO" },
    { ...emptyContext, allowedSensitiveTopics: ["health"] }
  );
  assert.equal(plan.action, "create");
});

test("a fact the user typed themselves is never blocked by the gate", () => {
  // The switch answers "may a background model write this down because I
  // mentioned it". A fact the user is looking at as they create it is already
  // consented to, and blocking it would leave them no way to record something
  // they do want kept.
  const plan = planFactIngestion({ content: DIAGNOSIS, source: "MANUAL" }, emptyContext);
  assert.equal(plan.action, "create");
});

test("the gate runs before the duplicate check, so an opted-out fact cannot be refreshed", () => {
  /*
   * The ordering bug this pins: with the check after `findDuplicate`, a
   * sensitive candidate matching a row stored while the topic was ON would
   * take the `refresh` branch and wind that row's clock forward — so opting
   * OUT would stop new sensitive facts while keeping the old ones alive
   * forever, which is the opposite of what the switch says.
   */
  const stored: LifecycleEntry = {
    id: "existing",
    content: DIAGNOSIS,
    normalized: null,
    category: "identity",
    projectId: null,
    sourceRef: null,
    sourceMessageId: null,
    source: "AUTO",
    kind: "FACT",
    confidence: 0.7,
    status: "active",
    expiresAt: null,
    createdAt: new Date(),
    embeddingModel: null,
  };
  const plan = planFactIngestion({ content: DIAGNOSIS, source: "AUTO" }, { ...emptyContext, entries: [stored] });
  assert.equal(plan.action, "skip");
  assert.equal(plan.action === "skip" && plan.reason, "sensitive");
});

test("suppression still outranks the sensitive gate", () => {
  // A statement the user asked to forget is refused as SUPPRESSED, not as
  // sensitive — the two refusals send the reader to different remedies, and
  // "turn the topic on in settings" is the wrong advice for a forgotten fact.
  const plan = planFactIngestion(
    { content: DIAGNOSIS, source: "AUTO" },
    { ...emptyContext, suppressions: [DIAGNOSIS], allowedSensitiveTopics: ["health"] }
  );
  assert.equal(plan.action === "skip" && plan.reason, "suppressed");
});

// ---------------------------------------------------------------------------
// The gate is actually reached
// ---------------------------------------------------------------------------

test("saveCandidates loads the opt-in list rather than defaulting it", () => {
  const body = src("src/lib/memory.ts");
  assert.match(body, /loadAllowedSensitiveTopics/);
  assert.match(body, /allowedSensitiveTopics/);
  // The plan call has to RECEIVE it — a loaded list that is never passed is a
  // query with no effect, and the gate would silently refuse everything.
  assert.match(body, /planFactIngestion\([\s\S]{0,200}allowedSensitiveTopics/);
});

test("the opt-in list fails closed when Settings cannot be read", () => {
  const body = src("src/lib/memory.ts");
  const fn = body.slice(body.indexOf("async function loadAllowedSensitiveTopics"));
  assert.match(fn.slice(0, 700), /catch\s*\{\s*return \[\];/);
});

test("the extractor is told not to ask for the subjects the account refused", () => {
  // The prompt lives in src/lib/memory-extraction.ts so the recall benchmark
  // measures the same one; memory.ts hands it the refused topics' labels.
  const body = src("src/lib/memory.ts");
  assert.match(body, /offLimitsLabels: offLimits\.map\(\(topic\) => SENSITIVE_TOPIC_META\[topic\]\.label\.toLowerCase\(\)\)/);
  const prompt = src("src/lib/memory-extraction.ts");
  assert.match(prompt, /NEVER extract anything touching these subjects/);
});

test("the settings route stores only ids this build recognises", () => {
  const body = src("src/app/api/settings/route.ts");
  assert.match(body, /memorySensitiveTopics: z\.array\(z\.enum\(SENSITIVE_TOPICS\)\)/);
  assert.match(body, /memorySensitiveTopics: \[\.\.\.new Set\(d\.memorySensitiveTopics\)\]/);
});

test("the column defaults to opted into nothing", () => {
  assert.match(src("prisma/schema.prisma"), /memorySensitiveTopics\s+String\[\]\s+@default\(\[\]\)/);
  const migration = src("prisma/migrations/20260922160000_memory_sensitive_topics/migration.sql");
  assert.match(migration, /ADD COLUMN "memorySensitiveTopics" TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\]/);
});

test("a stored row is flagged on read, so rows older than the gate are covered too", () => {
  // The verdict is recomputed rather than stored (see memory-sensitive.ts), and
  // this is the line that makes that reach the page.
  assert.match(src("src/lib/memory-view.ts"), /sensitive: sensitiveTopicOf\(row\.content\)/);
});

// ---------------------------------------------------------------------------
// Regression 1: every route the memory UI calls exists
// ---------------------------------------------------------------------------

/**
 * `/api/memory/edit` → `src/app/api/memory/edit/route.ts`, `${id}` → `[id]`.
 * A query string is not part of the route: `/api/memory/recap?days=${days}`
 * resolves to the recap route, not (as it once did by accident, through the
 * interpolation in its query) to `[id]`.
 */
function routeFileFor(apiPath: string): string | null {
  const segments = apiPath.split("?")[0].replace(/^\//, "").split("/");
  let dir = repoPath("src/app");
  for (const segment of segments) {
    if (!existsSync(dir)) return null;
    const children = readdirSync(dir);
    // A literal segment wins; a `${...}` interpolation resolves to whichever
    // dynamic folder is there, which is how `[id]` is matched.
    const match = segment.includes("${")
      ? children.find((child) => /^\[.+\]$/.test(child))
      : children.find((child) => child === segment);
    if (!match) return null;
    dir = `${dir}/${match}`;
  }
  return existsSync(`${dir}/route.ts`) ? `${dir}/route.ts` : null;
}

/** Every `fetch("/api/…")` in the memory surfaces, as written. */
function memoryApiCalls(): { file: string; path: string }[] {
  const files = readdirSync(repoPath("src/components/memory"))
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => `src/components/memory/${name}`);
  const calls: { file: string; path: string }[] = [];
  for (const file of files) {
    for (const match of src(file).matchAll(/fetch\(\s*[`"'](\/api\/[^`"']*)[`"']/g)) {
      calls.push({ file, path: match[1] });
    }
  }
  return calls;
}

test("the memory page only calls routes that exist", () => {
  const calls = memoryApiCalls();
  // If this drops to zero the test has stopped testing anything — the folder
  // was renamed, or the calls moved somewhere this does not read.
  assert.ok(calls.length >= 6, `expected the memory surfaces to call the API, found ${calls.length}`);
  const missing = calls.filter((call) => routeFileFor(call.path) === null);
  assert.deepEqual(
    missing,
    [],
    `memory UI fetches routes that do not exist: ${missing.map((m) => `${m.path} (${m.file})`).join(", ")}`
  );
});

test("the natural-language editor drafts before it writes", () => {
  const body = src("src/components/memory/use-memory.ts");
  // The draft route writes nothing and returns a reviewable proposal; the
  // apply route commits it and hands back the inverse. Collapsing them would
  // remove the diff the user accepts, which is the point of the feature.
  assert.match(body, /"\/api\/memory\/edit"/);
  assert.match(body, /"\/api\/memory\/edit\/apply"/);
  // Checked against the CALLS rather than the file text: the comment above
  // `useMemory` names the dead route on purpose, so that the next reader knows
  // what broke, and a test that searched the prose would fail on the
  // explanation instead of on the defect.
  assert.equal(
    memoryApiCalls().some((call) => call.path === "/api/memory/instruct"),
    false
  );
});

test("Undo replays the server's inverse, never one derived on the client", () => {
  const body = src("src/components/memory/use-memory.ts");
  // The server knows which rows actually changed — an operation can be refused
  // mid-batch by a suppression added earlier in the same batch — so an inverse
  // computed here would restore a state that never existed.
  assert.match(body, /inverse: data\.inverse/);
  assert.match(body, /applyOperations\(edit\.inverse\)/);
});

// ---------------------------------------------------------------------------
// Regression 2: the rows are on the page
// ---------------------------------------------------------------------------

test("the memory manager renders the summary, the list, the prompt bar and the activity sheet", () => {
  const body = src("src/components/memory/memory-manager.tsx");
  for (const component of [
    "MemoryHeader",
    "SummaryPanel",
    "PromptDock",
    "MemoryList",
    "ActivitySheet",
    "MemoryWelcome",
    "MemoryFooter",
    "ImportDialog",
  ]) {
    assert.match(body, new RegExp(`<${component}\\b`), `${component} is imported but never rendered`);
  }
  // The rows are where a wrong fact gets pointed at and removed; the list
  // must draw them, and the activity sheet must draw the edit history.
  assert.match(src("src/components/memory/memory-list.tsx"), /<EntryRow\b/);
  assert.match(src("src/components/memory/activity-sheet.tsx"), /<OperationDiff\b/);
});

test("no memory component is built and left unreachable", () => {
  /*
   * The shape of the bug, generalised: a component in this folder that
   * nothing else in the folder imports is either dead code or a feature the
   * user cannot reach, and both are worth a failing test rather than a
   * silent 358 lines.
   */
  const folder = repoPath("src/components/memory");
  const files = readdirSync(folder).filter((name) => name.endsWith(".tsx"));
  const bodies = files.map((name) => src(`src/components/memory/${name}`));
  const orphans = files.filter((name) => {
    const stem = name.replace(/\.tsx$/, "");
    // The manager is the folder's own entry point — it is imported by the page
    // and by the settings section, not by its siblings.
    if (stem === "memory-manager") return false;
    return !bodies.some((body) => body.includes(`/memory/${stem}"`));
  });
  assert.deepEqual(orphans, [], `unreachable memory components: ${orphans.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Regression 3: pausing memory reaches the server
// ---------------------------------------------------------------------------

test("pausing memory writes through the settings saver, not local state", () => {
  const body = src("src/components/memory/use-memory.ts");
  // `useSettingsSave` PATCHes /api/settings and rolls the switch back when the
  // server refuses. The app provider's `setSettings` is React state and no
  // request — using it here is what made the pause toggle forget itself.
  assert.match(body, /useSettingsSave/);
  assert.match(body, /saveSettings\(\{ memoryEnabled: !nextPaused \}\)/);
  assert.equal(/setSettings\(\{\s*memoryEnabled/.test(body), false);
});

test("the pause toast is not shown when the write was refused", () => {
  const body = src("src/components/memory/use-memory.ts");
  const fn = body.slice(body.indexOf("const setPaused"));
  assert.match(fn.slice(0, 600), /if \(!ok\) return;/);
});
