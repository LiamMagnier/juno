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

test("a subject word needs a claim about the user before it counts", () => {
  // "health" as a field of work is not a health fact about the person.
  assert.equal(sensitiveTopicOf("Their team builds software for health clinics."), null);
  // The same word, attributed, is.
  assert.equal(sensitiveTopicOf("The user is sick with a chronic condition."), "health");
});

test("a marker fires even when the sentence attributes nothing", () => {
  // The precision rule above applies to `subjects` only — a word like
  // "chemotherapy" has no innocent reading worth preserving, and a gate that
  // waited for a verb would miss "Chemotherapy, weekly, Tuesdays."
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
  const body = src("src/lib/memory.ts");
  assert.match(body, /NEVER extract anything touching these subjects/);
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

/** `/api/memory/edit` → `src/app/api/memory/edit/route.ts`, `${id}` → `[id]`. */
function routeFileFor(apiPath: string): string | null {
  const segments = apiPath.replace(/^\//, "").split("/");
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

test("the memory manager renders the entry list, the topics and the edit queue", () => {
  const body = src("src/components/memory/memory-manager.tsx");
  for (const component of ["EntryList", "TopicsView", "EditsPanel", "SummaryCard", "PrivacyStrip"]) {
    assert.match(body, new RegExp(`<${component}\\b`), `${component} is imported but never rendered`);
  }
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
