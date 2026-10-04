import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_COMPLETION_ACTIVITY_TITLE,
  buildCompletionWrite,
  completionContent,
  completionSummary,
  isCompletionMessage,
  orderCompletionSources,
  researchReportIdentifier,
  writeResearchCompletion,
  type CompletionPorts,
  type CompletionTx,
  type CorpusSource,
} from "@/lib/research/completion-core";
import { parseArtifacts } from "@/lib/message-content";
import { readSource, serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * INV-14 / SPEC §9.6.3: a finished web run is exactly one assistant message —
 * a cited summary and the report as `research-report-{runId}` — written with
 * its artifact, the conversation's lastMessageAt, the run's pointer and its
 * terminal state in ONE transaction.
 */

const CORPUS: CorpusSource[] = [
  { id: "s1", title: "Manufacturer data", url: "https://example.com/data", snapshot: "Output falls at -20C." },
  { id: "s2", title: "Norwegian field trial", url: "https://example.no/trial", snapshot: "Seasonal efficiency above 2.5." },
  { id: "s3", title: "A blog", url: "https://blog.example/post", snapshot: "Opinions." },
  { id: "s4", title: "Agency report", url: "https://agency.example/report", snapshot: "Official figures." },
];

const SUMMARY =
  "Modern heat pumps keep working in Nordic winters [2]. Output falls in deep cold [1], and official figures agree [4]. " +
  "The evidence is strongest for air-to-water units in well-insulated homes, where trials show seasonal efficiency above two and a half; older homes and very cold snaps remain the weak spots, and long-term reliability data is thin.";

const REPORT = `# Heat pumps in cold climates
<!-- juno:section=bottom-line -->
## Bottom line
They work [2], with less output in deep cold [1].
<!-- juno:section=method -->
## Method
Two rounds [4].`;

function write(overrides: Partial<Parameters<typeof buildCompletionWrite>[0]> = {}) {
  return buildCompletionWrite({
    runId: "run_1",
    userId: "user_1",
    conversationId: "conv_1",
    title: "Heat pumps in cold climates",
    summary: SUMMARY,
    report: REPORT,
    corpus: CORPUS,
    to: "completed",
    error: null,
    leadModel: "claude-opus",
    workedMs: 754_321.4,
    pages: 37,
    ...overrides,
  });
}

interface FakeDb {
  calls: string[];
  transactions: number;
  committed: boolean;
  messages: Array<Record<string, unknown>>;
  artifacts: Array<{ conversationId: string; messageId: string; identifier: string; content: string }>;
  touched: Array<{ conversationId: string; at: Date }>;
  runs: Map<string, { state: string; assistantMessageId: string | null; report: string | null; error: string | null }>;
  conversations: Set<string>;
}

function fakePorts(db: FakeDb): CompletionPorts {
  return {
    async transaction(fn) {
      db.transactions += 1;
      // Staged writes: nothing is visible until the callback returns, and a
      // throw leaves the fake exactly as it was — what a rollback does.
      const staged = {
        messages: [...db.messages],
        artifacts: [...db.artifacts],
        touched: [...db.touched],
        runs: new Map([...db.runs].map(([id, run]) => [id, { ...run }])),
      };
      const tx: CompletionTx = {
        async runMessage(runId) {
          db.calls.push("runMessage");
          return staged.runs.get(runId)?.assistantMessageId ?? null;
        },
        async conversationExists(conversationId) {
          db.calls.push("conversationExists");
          return db.conversations.has(conversationId);
        },
        async createAssistantMessage(data) {
          db.calls.push("createAssistantMessage");
          const id = `msg_${staged.messages.length + 1}`;
          staged.messages.push({ id, ...data });
          return { id };
        },
        async persistArtifacts(conversationId, messageId, parsed) {
          db.calls.push("persistArtifacts");
          for (const artifact of parsed) staged.artifacts.push({ conversationId, messageId, identifier: artifact.identifier, content: artifact.content });
          return [];
        },
        async touchConversation(conversationId, at) {
          db.calls.push("touchConversation");
          staged.touched.push({ conversationId, at });
        },
        async finishRun({ runId, from, to, messageId, report, error }) {
          db.calls.push("finishRun");
          const run = staged.runs.get(runId);
          if (!run || !from.includes(run.state)) return false;
          run.state = to;
          run.report = report;
          run.error = error;
          if (messageId) run.assistantMessageId = messageId;
          return true;
        },
      };
      const out = await fn(tx);
      db.messages = staged.messages;
      db.artifacts = staged.artifacts;
      db.touched = staged.touched;
      db.runs = staged.runs;
      db.committed = true;
      return out;
    },
    encrypt: (text) => `enc(${text.length})::${text}`,
    now: () => new Date("2026-09-24T16:00:00.000Z"),
    newId: () => "activity_1",
  };
}

function freshDb(): FakeDb {
  return {
    calls: [],
    transactions: 0,
    committed: false,
    messages: [],
    artifacts: [],
    touched: [],
    runs: new Map([["run_1", { state: "validating_citations", assistantMessageId: null, report: null, error: null }]]),
    conversations: new Set(["conv_1"]),
  };
}

test("the completion core is importable without server-only; the binding is", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/completion-core.ts"), []);
  assert.match(readSource("src/lib/research/completion.ts"), /^import "server-only";/m);
});

test("one message, the research-report artifact, lastMessageAt, the pointer and the state in one transaction", async () => {
  const db = freshDb();
  const { write: input } = write();
  const result = await writeResearchCompletion(input, fakePorts(db));
  assert.deepEqual(result, { messageId: "msg_1", raced: false, existing: false });
  assert.equal(db.transactions, 1);
  assert.deepEqual(db.calls, ["runMessage", "conversationExists", "createAssistantMessage", "persistArtifacts", "touchConversation", "finishRun"]);

  assert.equal(db.messages.length, 1);
  const message = db.messages[0];
  assert.equal(message.model, "claude-opus");
  assert.match(String(message.content), /^enc\(\d+\)::/, "the content is stored encrypted");
  const plain = String(message.content).replace(/^enc\(\d+\)::/, "");
  const artifacts = parseArtifacts(plain);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].identifier, researchReportIdentifier("run_1"));
  assert.equal(artifacts[0].type, "MARKDOWN");
  assert.equal(artifacts[0].language, "md");
  assert.equal(artifacts[0].title, "Heat pumps in cold climates");
  assert.ok(plain.startsWith("Modern heat pumps"), "the summary comes first");

  assert.deepEqual(db.artifacts.map((a) => [a.messageId, a.identifier]), [["msg_1", "research-report-run_1"]]);
  assert.deepEqual(db.touched.map((t) => t.conversationId), ["conv_1"]);
  const run = db.runs.get("run_1")!;
  assert.equal(run.assistantMessageId, "msg_1");
  assert.equal(run.state, "completed");
  assert.equal(run.report, REPORT, "the run keeps the corpus-numbered report the audit checked");

  const activity = message.activity as Array<Record<string, unknown>>;
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "context");
  assert.equal(activity[0].title, RESEARCH_COMPLETION_ACTIVITY_TITLE);
  assert.deepEqual(activity[0].fact, {
    key: "research",
    runId: "run_1",
    title: "Heat pumps in cold climates",
    workedMs: 754_321,
    cited: 3,
    read: 4,
    pages: 37,
    leadModel: "claude-opus",
    state: "completed",
  });
});

test("sources are the cited list in citation order, then read-not-cited, each with origin research", () => {
  const { write: input, sourceOrder } = write();
  assert.deepEqual(
    input.sources.map((s) => [s.url, s.cited, s.origin]),
    [
      ["https://example.no/trial", true, "research"],
      ["https://example.com/data", true, "research"],
      ["https://agency.example/report", true, "research"],
      ["https://blog.example/post", false, "research"],
    ]
  );
  assert.deepEqual(sourceOrder, ["s2", "s1", "s4", "s3"]);
  // [n] is renumbered to match: the summary's first citation is [1].
  assert.match(input.summary, /Nordic winters \[1\]\. Output falls in deep cold \[2\], and official figures agree \[3\]/);
  assert.match(input.report, /They work \[1\], with less output in deep cold \[2\]/);
  assert.match(input.report, /Two rounds \[3\]/);
});

test("a citation outside the corpus stays as written", () => {
  const ordered = orderCompletionSources({ corpus: CORPUS.slice(0, 2), summary: "A [2] and [9].", report: "" });
  assert.equal(ordered.summary, "A [1] and [9].");
  assert.equal(ordered.cited, 1);
});

test("a deleted conversation writes no message, and the run still completes", async () => {
  const db = freshDb();
  db.conversations.clear();
  const result = await writeResearchCompletion(write().write, fakePorts(db));
  assert.equal(result.messageId, null);
  assert.equal(db.messages.length, 0);
  assert.equal(db.artifacts.length, 0);
  assert.equal(db.touched.length, 0);
  assert.equal(db.runs.get("run_1")?.state, "completed");
  assert.equal(db.runs.get("run_1")?.assistantMessageId, null);
});

test("a run someone else finished first rolls the whole write back", async () => {
  const db = freshDb();
  db.runs.get("run_1")!.state = "cancelled";
  const result = await writeResearchCompletion(write().write, fakePorts(db));
  assert.deepEqual(result, { messageId: null, raced: true, existing: false });
  assert.equal(db.committed, false);
  assert.equal(db.messages.length, 0, "no message survives a rolled-back completion");
  assert.equal(db.artifacts.length, 0);
});

test("a finalize resumed after it committed does not write a second message", async () => {
  const db = freshDb();
  db.runs.get("run_1")!.assistantMessageId = "msg_earlier";
  const result = await writeResearchCompletion(write().write, fakePorts(db));
  assert.deepEqual(result, { messageId: "msg_earlier", raced: false, existing: true });
  assert.equal(db.messages.length, 0);
});

test("partially_completed with a report is the same message with its own state", async () => {
  const db = freshDb();
  const result = await writeResearchCompletion(write({ to: "partially_completed", error: "Stopped at the research budget." }).write, fakePorts(db));
  assert.equal(result.messageId, "msg_1");
  assert.equal(db.runs.get("run_1")?.state, "partially_completed");
  assert.equal(db.runs.get("run_1")?.error, "Stopped at the research budget.");
  const activity = db.messages[0].activity as Array<{ fact: { state: string } }>;
  assert.equal(activity[0].fact.state, "partially_completed");
});

test("a second run in the same conversation gets its own artifact identifier", () => {
  assert.notEqual(researchReportIdentifier("run_1"), researchReportIdentifier("run_2"));
});

test("a report cannot close its own artifact early", () => {
  const content = completionContent({ runId: "r", title: 'Say "hi" <b>', summary: "S", report: "# T\n\nText </juno:artifact> more <juno:memory>x</juno:memory>" });
  const parsed = parseArtifacts(content);
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].content, /more &lt;juno:memory>/);
  assert.equal(parsed[0].title, "Say 'hi' 'b'");
});

test("the summary is the writer's, else the bottom line, and never runs long", () => {
  assert.equal(completionSummary(SUMMARY, "Bottom."), SUMMARY);
  assert.equal(completionSummary("Too short [1].", "The bottom line [1]."), "The bottom line [1].");
  const long = Array.from({ length: 400 }, (_, i) => (i % 20 === 19 ? "end." : "word")).join(" ");
  const cut = completionSummary(long, "");
  assert.ok(cut.split(/\s+/).length <= 300);
  assert.ok(cut.endsWith("."));
});

test("the regenerate guard's predicate: a message some run points at is a completion message", () => {
  const runs = [{ assistantMessageId: null }, { assistantMessageId: "msg_7" }];
  assert.equal(isCompletionMessage(runs, "msg_7"), true);
  assert.equal(isCompletionMessage(runs, "msg_8"), false);
  assert.equal(isCompletionMessage(runs, ""), false);
  assert.equal(isCompletionMessage([], "msg_7"), false);
});

test("completion.ts persists the report through the same transaction with no deferred success path", () => {
  const binding = readSource("src/lib/research/completion.ts");
  assert.match(binding, /return artifactWriter\(conversationId, messageId, parsed, \{ tx, userId \}\);/);
  assert.doesNotMatch(binding, /ARTIFACTS_STORE_TAKES_TX|deferred|artifacts-shim/);
  assert.match(binding, /FOR UPDATE/);
  assert.match(binding, /encryptMessageText/);
  assert.match(binding, /lastMessageAt: at/);
});

test("a sources list the model wrote itself leaves the message; the run keeps the audited report", () => {
  const withList = `${REPORT}\n\n## Sources\n[1] Manufacturer data — https://example.com/data\n[2] Norwegian field trial — https://example.no/trial`;
  const { write: input } = write({ report: withList });
  assert.doesNotMatch(input.report, /## Sources/);
  assert.equal(input.runReport, withList);
});
