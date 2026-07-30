import test from "node:test";
import assert from "node:assert/strict";
import { findLearningBlocks, parseLearningBlock, salvageLearningBlock } from "@/lib/learning-blocks";
import { parseStepLab, parseYamlSubset } from "@/lib/step-lab";

/*
 * The contract this file pins, and which
 * `native/Packages/JunoNativeKit/Tests/JunoDesignSystemTests/JunoLearningBlocksTests.swift`
 * mirrors assertion for assertion.
 *
 * A learning block is written BY THE MODEL, mid-reply, into a stream. So the
 * parser has two jobs and they pull against each other: be forgiving enough that
 * a stray tab or a missing quote does not cost the reader the lesson, and be
 * strict enough that a block which cannot teach anything — a quiz with no right
 * answer, a comparison with one column — is refused rather than drawn.
 *
 * The reason these cases are duplicated in Swift is that the two clients
 * disagreeing is invisible: the website would render a five-step timeline and
 * the phone a four-step one, both confidently, and nothing would report it.
 */

const parse = (kind: Parameters<typeof parseLearningBlock>[0], body: string) =>
  parseLearningBlock(kind, body, "test");

// ── The YAML subset ────────────────────────────────────────────────────────

test("yaml: scalars are typed, and a quoted comma does not split a flow list", () => {
  const value = parseYamlSubset(
    ['count: 3', 'ratio: -0.5', 'flag: true', 'blank: null', 'items: ["a, b", c]'].join("\n")
  );
  assert.deepEqual(value, { count: 3, ratio: -0.5, flag: true, blank: null, items: ["a, b", "c"] });
});

test("yaml: comments and blank lines are dropped, tabs count as two spaces", () => {
  const value = parseYamlSubset(["# a note", "", "root:", "\tchild: yes"].join("\n"));
  assert.deepEqual(value, { root: { child: "yes" } });
});

test("yaml: a sequence of records reads its inline key plus the indented rest", () => {
  const value = parseYamlSubset(
    ["steps:", "  - label: Tokenize", "    description: Split the text", "  - label: Embed"].join("\n")
  );
  assert.deepEqual(value, {
    steps: [{ label: "Tokenize", description: "Split the text" }, { label: "Embed" }],
  });
});

test("yaml: a prose line with a colon is not data", () => {
  // "Note this" is not an identifier, so the line is skipped rather than
  // becoming a key — otherwise every sentence with a colon would be a field.
  const value = parseYamlSubset(["title: Real", "Note this: not a field"].join("\n"));
  assert.deepEqual(value, { title: "Real" });
});

// ── Learning card ──────────────────────────────────────────────────────────

test("learning card: tone, icon and content", () => {
  const { payload, error } = parse("learning-card", "title: Caching\ntone: tip\nicon: 💡\ncontent: Cache the read path.");
  assert.equal(error, undefined);
  assert.deepEqual(payload, {
    kind: "learning-card",
    card: { title: "Caching", icon: "💡", tone: "tip", content: "Cache the read path." },
  });
});

test("learning card: an unknown tone becomes insight, and the title has a default", () => {
  const { payload } = parse("learning-card", "tone: spicy\ncontent: Something true.");
  assert.deepEqual(payload, {
    kind: "learning-card",
    card: { title: "Core idea", icon: undefined, tone: "insight", content: "Something true." },
  });
});

test("learning card: no content is a refusal, not an empty card", () => {
  const { payload, error } = parse("learning-card", "title: Nothing here");
  assert.equal(payload, null);
  assert.equal(error, "Learning card needs `content`.");
});

// ── Process timeline ───────────────────────────────────────────────────────

test("process timeline: steps keep their order and accept label aliases", () => {
  const { payload } = parse(
    "process-timeline",
    ["title: Request", "steps:", "  - label: Receive", "    description: Parse it", "  - title: Route", "  - name: Answer"].join("\n")
  );
  assert.deepEqual(payload, {
    kind: "process-timeline",
    timeline: {
      title: "Request",
      steps: [
        { label: "Receive", description: "Parse it" },
        { label: "Route", description: undefined },
        { label: "Answer", description: undefined },
      ],
    },
  });
});

test("process timeline: one step is not a process", () => {
  const { payload, error } = parse("process-timeline", "steps:\n  - label: Only");
  assert.equal(payload, null);
  assert.equal(error, "Process timeline needs at least two steps with labels.");
});

// ── Comparison ─────────────────────────────────────────────────────────────

test("comparison: columns, rows and a verdict", () => {
  const { payload } = parse(
    "comparison",
    ["columns: [Postgres, SQLite]", "rows:", "  - label: Concurrency", "    values: [High, Single writer]", "verdict: Postgres, for this workload."].join("\n")
  );
  assert.deepEqual(payload, {
    kind: "comparison",
    comparison: {
      title: undefined,
      columns: ["Postgres", "SQLite"],
      rows: [{ label: "Concurrency", values: ["High", "Single writer"] }],
      verdict: "Postgres, for this workload.",
    },
  });
});

test("comparison: one column is a list, not a comparison", () => {
  const { payload, error } = parse("comparison", "columns: [Only]\nrows:\n  - label: A\n    values: [x]");
  assert.equal(payload, null);
  assert.equal(error, "Comparison needs 2+ columns and at least one row with values.");
});

// ── Quiz ───────────────────────────────────────────────────────────────────

test("quiz: the legacy single-question shape, with string options and `answer:`", () => {
  const { payload } = parse("quiz", ["question: Which is idempotent?", "options: [POST, PUT]", "answer: PUT"].join("\n"));
  assert.deepEqual(payload, {
    kind: "quiz",
    quiz: {
      title: undefined,
      questions: [
        {
          question: "Which is idempotent?",
          options: [
            { label: "POST", correct: false },
            { label: "PUT", correct: true },
          ],
          explanation: undefined,
          hint: undefined,
        },
      ],
    },
  });
});

test("quiz: the multi-question shape keeps its own title", () => {
  const { payload } = parse(
    "quiz",
    [
      "title: HTTP",
      "questions:",
      "  - question: Which is safe?",
      "    options:",
      "      - label: GET",
      "        correct: true",
      "      - label: DELETE",
      "  - question: Which creates?",
      "    options:",
      "      - label: POST",
      "        correct: true",
      "      - label: HEAD",
    ].join("\n")
  );
  assert.equal(payload?.kind, "quiz");
  if (payload?.kind !== "quiz") return;
  assert.equal(payload.quiz.title, "HTTP");
  assert.equal(payload.quiz.questions.length, 2);
  assert.deepEqual(
    payload.quiz.questions.map((q) => q.options.findIndex((o) => o.correct)),
    [0, 0]
  );
});

test("quiz: a question nobody can pass is refused", () => {
  const { payload, error } = parse("quiz", "question: Pick one\noptions: [A, B]");
  assert.equal(payload, null);
  assert.equal(error, "Quiz needs a question with 2+ options and a correct answer.");
});

// ── Deep dive ──────────────────────────────────────────────────────────────

test("deep dive: summary defaults to the title, paragraphs survive", () => {
  const { payload } = parse("deep-dive", "title: Vacuum\ncontent: One.\ndetail: ignored");
  assert.deepEqual(payload, {
    kind: "deep-dive",
    deepDive: { title: "Vacuum", summary: "Vacuum", content: "One." },
  });
});

test("deep dive: a title with no content is refused", () => {
  const { payload, error } = parse("deep-dive", "title: Alone");
  assert.equal(payload, null);
  assert.equal(error, "Deep dive needs `title` and `content`.");
});

// ── Scanning a reply ───────────────────────────────────────────────────────

test("scan: blocks are found in order with the prose between them intact", () => {
  const text = [
    "Before.",
    ":::learning-card",
    "content: First idea.",
    ":::",
    "Between.",
    ":::deep-dive",
    "title: More",
    "content: Detail.",
    ":::",
    "After.",
  ].join("\n");
  const blocks = findLearningBlocks(text);
  assert.deepEqual(blocks.map((b) => b.kind), ["learning-card", "deep-dive"]);
  assert.equal(text.slice(0, blocks[0].start), "Before.\n");
  assert.equal(text.slice(blocks[0].end, blocks[1].start), "Between.\n");
  assert.equal(text.slice(blocks[1].end), "After.");
});

test("scan: a block inside a code fence is source, not a lesson", () => {
  const text = ["```md", ":::quiz", "question: no", ":::", "```"].join("\n");
  assert.deepEqual(findLearningBlocks(text), []);
});

test("scan: an unclosed trailing block is streaming and is NOT parsed", () => {
  const text = [":::quiz", "question: Which is safe?"].join("\n");
  const [block] = findLearningBlocks(text);
  assert.equal(block.streaming, true);
  assert.equal(block.payload, null);
  assert.equal(block.kind, "quiz");
});

test("scan: salvaging a cut-off block parses what arrived and says it was cut", () => {
  const text = [":::learning-card", "content: Half a thought."].join("\n");
  const salvaged = salvageLearningBlock(findLearningBlocks(text)[0]);
  assert.equal(salvaged.streaming, false);
  assert.equal(salvaged.error, "This block was cut off mid-stream.");
  assert.equal(salvaged.payload?.kind, "learning-card");
});

test("scan: an unknown ::: kind is left alone", () => {
  assert.deepEqual(findLearningBlocks(":::mystery\nx: 1\n:::"), []);
});

// ── Step Lab ───────────────────────────────────────────────────────────────

test("step lab: steps, inferred visual types, and a deduped id", () => {
  const { block, error } = parseStepLab(
    [
      "title: How it reads",
      "steps:",
      "  - id: same",
      "    title: Tokens",
      "    summary: Split the prompt",
      "  - id: same",
      "    title: Attention",
      "    summary: Weigh the context",
      "takeaway: That is the whole loop.",
    ].join("\n"),
    "seed"
  );
  assert.equal(error, undefined);
  assert.equal(block.title, "How it reads");
  assert.deepEqual(block.steps.map((s) => s.id), ["same", "same_2"]);
  assert.deepEqual(block.steps.map((s) => s.visualType), ["tokenization", "attention"]);
  assert.equal(block.takeaway, "That is the whole loop.");
});

test("step lab: a step with no summary is dropped; none left is a fallback lab", () => {
  const { block, error } = parseStepLab("title: Broken\nsteps:\n  - title: Alone", "seed");
  assert.equal(error, "Step Lab has no valid steps.");
  assert.equal(block.title, "Broken");
  assert.equal(block.steps.length, 1);
  assert.equal(block.steps[0].id, "fallback");
});

test("step lab: its quiz uses the same rules as the standalone block", () => {
  const { block } = parseStepLab(
    [
      "title: Lab",
      "steps:",
      "  - title: One",
      "    summary: Does something",
      "quiz:",
      "  question: Which?",
      "  options:",
      "    - label: This",
      "      correct: true",
      "    - label: That",
    ].join("\n"),
    "seed"
  );
  assert.equal(block.quiz?.questions.length, 1);
  assert.equal(block.quiz?.questions[0].options[0].correct, true);
});
