import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanTopic,
  contentMatchesTopic,
  findExcludedTopic,
  scrubCoveredSentences,
  splitSentences,
  topicOfStatement,
  topicStatement,
  topicWordsMatch,
} from "@/lib/memory-topics";
import {
  findSuppression,
  proseCoveredBySuppression,
  screenMemoryWrite,
  suppressionRefusalMessage,
} from "@/lib/memory-suppression";
import {
  factsCoveredByForget,
  planFactIngestion,
  scrubSummaryForSuppressions,
  selectMemoriesForContext,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";

/*
 * Topic exclusions (src/lib/memory-topics.ts): "don't remember anything about
 * my divorce" as a block-list row every writer and reader honours.
 *
 * The statement rule (containment of the forgotten sentence) cannot express a
 * topic: no fact about the divorce contains "anything about my divorce", and a
 * bare one-word suppression matched inside other words ("ex" in "next"). These
 * pin both halves: what a topic catches, and what it must leave alone.
 */

const NOW = new Date("2026-10-25T12:00:00Z");

function fact(id: string, content: string, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  return {
    id,
    content,
    normalized: null,
    category: "identity",
    projectId: null,
    source: "AUTO",
    kind: "FACT",
    confidence: 0.7,
    status: "active",
    expiresAt: null,
    createdAt: NOW,
    observedAt: NOW,
    ...extra,
  };
}

test("a topic statement is recognised in the ways people phrase it", () => {
  for (const [statement, topic] of [
    ["Anything about my divorce", "my divorce"],
    ["anything about my divorce.", "my divorce"],
    ["Never remember anything about my divorce", "my divorce"],
    ["Don't remember anything to do with my side business", "my side business"],
    ["Everything regarding my ex", "my ex"],
    ["topic: health insurance", "health insurance"],
    ["Stop storing anything related to my brother", "my brother"],
  ] as const) {
    assert.equal(topicOfStatement(statement), topic, statement);
  }
  // Plain statements keep the statement rule.
  for (const statement of ["The user works at Acme.", "The user lives in Lisbon", "works at Acme", "anything"]) {
    assert.equal(topicOfStatement(statement), null, statement);
  }
  // A topic with nothing in it names nothing.
  assert.equal(topicOfStatement("Anything about my stuff"), null);
  assert.equal(topicStatement("my divorce"), "Anything about my divorce");
  assert.equal(topicOfStatement(topicStatement("my divorce")), "my divorce", "the stored form round-trips");
});

test("cleanTopic tidies and clamps, and refuses an empty topic", () => {
  assert.equal(cleanTopic("  my   divorce. "), "my divorce");
  assert.equal(cleanTopic("my"), null);
  assert.equal(cleanTopic(""), null);
  assert.equal(cleanTopic("x".repeat(200))!.length, 80);
});

test("topic words match inflections, not other words", () => {
  for (const [a, b] of [
    ["divorce", "divorc"],
    ["therapy", "therapist"],
    ["religion", "religiou"],
    ["politic", "political"],
    ["work", "worker"],
  ] as const) {
    assert.equal(topicWordsMatch(a, b), true, `${a} ~ ${b}`);
  }
  for (const [a, b] of [
    ["ex", "exam"],
    ["ex", "next"],
    ["art", "artist"],
    ["mother", "motherboard"],
    ["work", "workout"],
  ] as const) {
    assert.equal(topicWordsMatch(a, b), false, `${a} !~ ${b}`);
  }
});

test("a topic catches every fact about it, however it is phrased", () => {
  const divorce = [
    "The user is going through a divorce.",
    "The user divorced last spring.",
    "The user is divorcing their husband.",
    "The user's divorce hearing is in May.",
  ];
  for (const content of divorce) assert.equal(contentMatchesTopic(content, "my divorce"), true, content);
  const ex = ["The user's ex-wife lives in Leeds.", "The user's ex is called Sam."];
  for (const content of ex) assert.equal(contentMatchesTopic(content, "my ex"), true, content);
  assert.equal(contentMatchesTopic("The user runs a side business selling candles.", "my side business"), true);
  assert.equal(contentMatchesTopic("The user sees a therapist on Tuesdays.", "therapy"), true);
});

test("a topic leaves unrelated facts alone — no substring matches", () => {
  for (const content of [
    "The user is working on the next release.",
    "The user has years of experience with Rust.",
    "The user started a new job at Hooli.",
    "The user's motherboard died.",
    "The user's workout is at 7am.",
  ]) {
    assert.equal(contentMatchesTopic(content, "ex"), false, content);
    assert.equal(contentMatchesTopic(content, "mother"), false, content);
    assert.equal(contentMatchesTopic(content, "work"), content.includes("working on"), content);
  }
  // Every word of a multi-word topic must be there.
  assert.equal(contentMatchesTopic("The user runs a business.", "my side business"), false);
});

test("the block-list applies the topic rule to topic rows and the statement rule to the rest", () => {
  const blockList = ["Anything about my divorce", "The user works at Acme"];
  assert.equal(findSuppression("The user is going through a divorce.", blockList), "Anything about my divorce");
  assert.equal(findSuppression("The user works at Acme as a designer", blockList), "The user works at Acme");
  assert.equal(findSuppression("The user lives in Porto.", blockList), null);
  // The old failure: the topic row as a STATEMENT matched nothing about the divorce.
  assert.equal(findSuppression("The user is going through a divorce.", ["anything about my divorce zz"]), null);
  assert.equal(findExcludedTopic("The user's ex-wife lives in Leeds.", ["Anything about my ex"]), "Anything about my ex");
  assert.equal(findExcludedTopic("The user's ex-wife lives in Leeds.", ["The user works at Acme"]), null);
});

test("every writer refuses a fact on an excluded topic, in the topic's own words", () => {
  const screened = screenMemoryWrite({ content: "The user divorced in 2024.", suppressions: ["Anything about my divorce"] });
  assert.equal(screened.ok, false);
  assert.ok(!screened.ok && screened.reason === "suppressed");
  assert.match(!screened.ok && screened.reason === "suppressed" ? screened.message : "", /not to remember anything about “my divorce”/);
  assert.match(suppressionRefusalMessage("The user works at Acme"), /asked .* to forget “The user works at Acme”/);
  // A topic row itself is never screened (it IS the block-list).
  assert.equal(screenMemoryWrite({ content: "Anything about my divorce", kind: "SUPPRESSION", suppressions: ["Anything about my divorce"] }).ok, true);

  const plan = planFactIngestion(
    { content: "The user's divorce is final next month.", source: "AUTO" },
    { entries: [], suppressions: ["Anything about my divorce"], now: NOW }
  );
  assert.deepEqual(plan, { action: "skip", reason: "suppressed" });
  const manual = planFactIngestion(
    { content: "The user's divorce is final next month.", source: "MANUAL" },
    { entries: [], suppressions: ["Anything about my divorce"], now: NOW }
  );
  assert.deepEqual(manual, { action: "skip", reason: "suppressed" }, "a typed fact is refused too: the person excluded the topic");
});

test("excluding a topic retires exactly the facts about it", () => {
  const entries = [
    fact("a", "The user is going through a divorce."),
    fact("b", "The user's divorce lawyer is called Ana."),
    fact("c", "The user lives in Porto."),
    fact("d", "The user divorced once before.", { status: "superseded" }),
  ];
  assert.deepEqual(factsCoveredByForget("Anything about my divorce", entries).sort(), ["a", "b"]);
});

test("retrieval never hands a model a fact the block-list covers", () => {
  const entries = [
    fact("a", "The user is going through a divorce.", { category: "relationships" }),
    fact("b", "The user prefers short answers.", { category: "preferences" }),
  ];
  const result = selectMemoriesForContext(entries, {
    query: "help me plan my divorce paperwork",
    now: NOW,
    suppressions: ["Anything about my divorce"],
  });
  assert.deepEqual(result.selected.map((m) => m.id), ["b"]);
  assert.equal(result.excluded.blocked, 1);
});

test("summary prose: sentences on an excluded topic are cut, the rest kept", () => {
  const prose = [
    "## Personal context",
    "The user lives in Porto. They are going through a divorce and find it hard.",
    "",
    "## Relationships",
    "Their divorce lawyer is Ana.",
    "",
    "## Preferences",
    "- Prefers short answers.",
    "- Avoids discussing the divorce at work.",
  ].join("\n");
  const scrubbed = scrubCoveredSentences(prose, (sentence) => proseCoveredBySuppression(sentence, ["Anything about my divorce"]));
  assert.equal(scrubbed.removed, 3);
  assert.doesNotMatch(scrubbed.content, /divorce/i);
  assert.match(scrubbed.content, /lives in Porto/);
  assert.match(scrubbed.content, /Prefers short answers/);
  assert.doesNotMatch(scrubbed.content, /## Relationships/, "a section left empty loses its heading");
  assert.equal(scrubSummaryForSuppressions(prose, []), prose, "no block-list, no change");
  // Unchanged prose comes back byte for byte.
  assert.equal(scrubCoveredSentences("## A\nNothing here.", () => false).content, "## A\nNothing here.");
});

test("prose scrubbing is narrower than ingestion: a short sentence is not cut for being inside a statement", () => {
  // findSuppression accepts a short candidate inside a long suppression; prose must not.
  assert.equal(findSuppression("eyes", ["The user's eyes are blue"]), "The user's eyes are blue");
  assert.equal(proseCoveredBySuppression("Yes.", ["The user's eyes are blue"]), false);
  assert.equal(proseCoveredBySuppression("The user works at Acme as a designer.", ["works at Acme"]), true);
});

test("the scrub splits sentences around abbreviations, so a removed sentence leaves no stray fragment", () => {
  // The review's probe: "Dr." was cut off its sentence and stored on its own.
  const prose = "## Work context\nThe user works at Acme. Dr. Smith is their divorce lawyer. They like tea.";
  assert.equal(
    scrubSummaryForSuppressions(prose, ["Anything about my divorce"]),
    "## Work context\nThe user works at Acme. They like tea."
  );
  // An abbreviation the list does not know is taken with the sentence it heads.
  assert.equal(
    scrubSummaryForSuppressions("The user works at Acme. Fr. Ana is their divorce counsellor. They like tea.", ["Anything about my divorce"]),
    "The user works at Acme. They like tea."
  );
});

test("sentence splitting keeps numbers, dotted abbreviations and initials inside their sentence", () => {
  const line = "They paid 3.5 euros in the U.S. last year, e.g. for tea. Mr. J. R. Jones agreed! Next?";
  assert.deepEqual(splitSentences(line), [
    "They paid 3.5 euros in the U.S. last year, e.g. for tea. ",
    "Mr. J. R. Jones agreed! ",
    "Next?",
  ]);
  assert.equal(splitSentences(line).join(""), line, "the pieces give the line back");
  assert.deepEqual(splitSentences("No full stop at all"), ["No full stop at all"]);
});

