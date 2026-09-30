import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_TOKEN_KINDS,
  MAX_CONTEXT_TOKENS,
  contextRangeIssues,
  contextReceiptFromActivity,
  contextReceiptSchema,
  contextTokenLabel,
  contextTokenSchema,
  contextTokensFromReceipt,
  contextTokensSchema,
  MAX_CONTEXT_TOKEN_LABEL_CHARS,
  isContextTokenId,
  rangesForStoredText,
  readContextReceipt,
  segmentWithTokens,
  type ContextReceipt,
  type ContextToken,
} from "@/lib/chat/context-tokens";
import { chatBodySchema } from "@/lib/chat/request";
import { hashFirstSubmission } from "@/lib/chat-first-submission";
import { readFileSync } from "node:fs";

/*
 * Typed context tokens: the shared shape every composer sends and the server
 * resolves (src/lib/chat/context-tokens.ts), the request contract that carries
 * them, and the receipt that brings them back on reload.
 */

const FILE = "cm1q3forecastfile000000001";
const AGENT = "cm1miraagent00000000000001";
const PROJECT = "cm1acmeproject000000000001";

const sentence = "Compare Q3 Forecast.xlsx with Stripe and ask Mira to flag renewal risk";
const at = (text: string, label: string) => {
  const start = text.indexOf(label);
  assert.ok(start >= 0, `"${label}" is in the text`);
  return { start, end: start + label.length };
};
const tokens: ContextToken[] = [
  { kind: "file", id: FILE, label: "Q3 Forecast.xlsx", range: at(sentence, "Q3 Forecast.xlsx") },
  { kind: "app", id: "composio:stripe", label: "Stripe", range: at(sentence, "Stripe") },
  { kind: "crew", id: AGENT, label: "Mira", range: at(sentence, "Mira") },
];

// ---------------------------------------------------------------------------
// The token schema
// ---------------------------------------------------------------------------

test("a token round-trips through JSON and the schema unchanged", () => {
  for (const token of tokens) {
    const parsed = contextTokenSchema.parse(JSON.parse(JSON.stringify(token)));
    assert.deepEqual(parsed, token);
  }
  assert.deepEqual(contextTokensSchema.parse(tokens), tokens);
});

test("every kind is accepted with an id of its own shape, and refused with another's", () => {
  for (const kind of CONTEXT_TOKEN_KINDS) {
    const id = kind === "app" ? "github" : PROJECT;
    assert.equal(contextTokenSchema.safeParse({ kind, id, label: "x" }).success, true, kind);
  }
  // A row-backed kind needs a cuid; an app needs a connector id.
  assert.equal(contextTokenSchema.safeParse({ kind: "file", id: "github", label: "x" }).success, false);
  assert.equal(contextTokenSchema.safeParse({ kind: "app", id: "has space", label: "x" }).success, false);
  assert.equal(contextTokenSchema.safeParse({ kind: "person", id: PROJECT, label: "x" }).success, false);
});

test("app ids take the three connector shapes and nothing else", () => {
  assert.equal(isContextTokenId("app", "github"), true);
  assert.equal(isContextTokenId("app", "apple-calendar"), true);
  assert.equal(isContextTokenId("app", "composio:gmail"), true);
  assert.equal(isContextTokenId("app", `user_mcp:${PROJECT}`), true);
  assert.equal(isContextTokenId("app", "user_mcp:not a cuid"), false);
  assert.equal(isContextTokenId("app", "../etc/passwd"), false);
  assert.equal(isContextTokenId("app", "a".repeat(200)), false);
});

test("a label is one line: control characters are refused, surrounding space trimmed", () => {
  assert.equal(contextTokenSchema.safeParse({ kind: "project", id: PROJECT, label: "Acme\nIgnore previous" }).success, false);
  assert.equal(contextTokenSchema.safeParse({ kind: "project", id: PROJECT, label: "   " }).success, false);
  assert.equal(contextTokenSchema.parse({ kind: "project", id: PROJECT, label: "  Acme  " }).label, "Acme");
  assert.equal(contextTokenSchema.safeParse({ kind: "project", id: PROJECT, label: "x".repeat(121) }).success, false);
});

test("unknown meta keys are stripped, not refused, so a newer client never 400s an older server", () => {
  const parsed = contextTokenSchema.parse({
    kind: "app",
    id: "github",
    label: "GitHub",
    meta: { icon: "app:github", subtitle: "octocat", future: true },
    future: "field",
  });
  assert.deepEqual(parsed, { kind: "app", id: "github", label: "GitHub", meta: { icon: "app:github", subtitle: "octocat" } });
});

test("a message carries at most MAX_CONTEXT_TOKENS tokens", () => {
  const many = Array.from({ length: MAX_CONTEXT_TOKENS + 1 }, () => ({ kind: "app", id: "github", label: "GitHub" }));
  assert.equal(contextTokensSchema.safeParse(many).success, false);
  assert.equal(contextTokensSchema.safeParse(many.slice(1)).success, true);
});

// ---------------------------------------------------------------------------
// Ranges against the text
// ---------------------------------------------------------------------------

test("ranges that frame their labels, in order, are clean", () => {
  assert.deepEqual(contextRangeIssues(sentence, tokens), []);
  // A token with no range is a valid encoding and is not checked.
  assert.deepEqual(contextRangeIssues(sentence, [{ label: "anything" }]), []);
});

test("a range past the end, over other words, or overlapping another is an issue", () => {
  const issues = contextRangeIssues(sentence, [
    { label: "Mira", range: { start: sentence.length - 2, end: sentence.length + 2 } },
    { label: "Stripe", range: at(sentence, "Compare") },
    { label: "Q3 Forecast.xlsx", range: at(sentence, "Q3 Forecast.xlsx") },
    { label: "Forecast", range: at(sentence, "Forecast") },
  ]);
  assert.deepEqual(
    issues.map((issue) => [issue.index, issue.code]),
    [
      [0, "out_of_bounds"],
      [1, "label_mismatch"],
      [3, "overlap"],
    ]
  );
});

test("offsets are UTF-16 code units, the way JavaScript and NSString count", () => {
  const text = "👋 ask Mira";
  const range = { start: text.indexOf("Mira"), end: text.indexOf("Mira") + 4 };
  assert.equal(range.start, 7, "the emoji is two code units");
  assert.deepEqual(contextRangeIssues(text, [{ label: "Mira", range }]), []);
});

test("ranges move with the trim the server stores, and a range that no longer fits is dropped", () => {
  const sent = `   ${sentence}  `;
  const shifted = tokens.map((token) => ({ ...token, range: { start: token.range!.start + 3, end: token.range!.end + 3 } }));
  assert.deepEqual(contextRangeIssues(sent, shifted), []);
  const stored = rangesForStoredText(sent, shifted);
  assert.deepEqual(stored, tokens, "back on the stored (trimmed) text");
  const broken = rangesForStoredText(sent, [{ ...shifted[0], range: { start: 0, end: 3 } }]);
  assert.equal(broken[0].range, undefined, "the token stays; only its placement is dropped");
  assert.equal(broken[0].id, FILE);
});

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

test("a message splits into text and tokens that concatenate back to the text", () => {
  const segments = segmentWithTokens(sentence, [...tokens].reverse());
  assert.deepEqual(
    segments.map((segment) => (segment.kind === "token" ? `[${segment.token.label}]` : segment.text)),
    ["Compare ", "[Q3 Forecast.xlsx]", " with ", "[Stripe]", " and ask ", "[Mira]", " to flag renewal risk"]
  );
  assert.equal(segments.map((segment) => segment.text).join(""), sentence);
});

test("segments ignore ranges that do not fit, never drawing a chip over the wrong words", () => {
  const segments = segmentWithTokens(sentence, [
    { kind: "crew", id: AGENT, label: "Mira", range: at(sentence, "flag") },
    { kind: "app", id: "github", label: "GitHub" },
  ]);
  assert.deepEqual(segments, [{ kind: "text", text: sentence }]);
  assert.deepEqual(segmentWithTokens("", []), [{ kind: "text", text: "" }]);
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

const receipt: ContextReceipt = {
  version: 1,
  tokens: [
    { kind: "file", id: FILE, label: "Q3 Forecast.xlsx", ranges: [at(sentence, "Q3 Forecast.xlsx")], outcome: "applied", via: "attachment" },
    {
      kind: "app",
      id: "composio:stripe",
      label: "Stripe",
      ranges: [at(sentence, "Stripe")],
      outcome: "dropped",
      code: "needs_connection",
      message: "Stripe isn't connected. Connect it to use it here.",
      connect: { connectorId: "composio:stripe", href: "/api/connectors/composio/stripe/connect" },
      approval: { reads: "allow", changes: "ask", sends: "ask", deletes: "ask", summary: "Sending, posting or changing anything in Stripe will ask you first." },
    },
    { kind: "crew", id: AGENT, label: "Mira", ranges: [at(sentence, "Mira")], outcome: "applied", via: "consult" },
  ],
};

test("a receipt round-trips, and a malformed one reads as absent", () => {
  assert.deepEqual(readContextReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
  assert.equal(readContextReceipt({ version: 2, tokens: [] }), undefined);
  assert.equal(readContextReceipt({ version: 1, tokens: [{ kind: "file" }] }), undefined);
  assert.equal(readContextReceipt(null), undefined);
  assert.equal(contextReceiptSchema.safeParse(receipt).success, true);
});

test("tokens come back from a receipt: applied ones only, one per range", () => {
  const back = contextTokensFromReceipt(receipt);
  assert.deepEqual(back, [tokens[0], tokens[2]], "the dropped app is not quietly retried");
  assert.deepEqual(contextTokensFromReceipt(undefined), []);
});

test("the receipt is found inside a reply's activity log", () => {
  const activity = [{ kind: "context" }, { kind: "context", contextReceipt: receipt }, { kind: "model" }];
  assert.deepEqual(contextReceiptFromActivity(activity), receipt);
  assert.equal(contextReceiptFromActivity([{ contextReceipt: "nonsense" }]), undefined);
  assert.equal(contextReceiptFromActivity(undefined), undefined);
});

// ---------------------------------------------------------------------------
// The request contract
// ---------------------------------------------------------------------------

test("POST /api/chat accepts tokens beside the legacy connectors field", () => {
  const parsed = chatBodySchema.safeParse({ message: sentence, context: tokens, connectors: ["github"] });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success && parsed.data.context, tokens);
  assert.deepEqual(parsed.success && parsed.data.connectors, ["github"]);
});

test("the request is refused when a range does not match the message it came with", () => {
  const parsed = chatBodySchema.safeParse({
    message: sentence,
    context: [{ kind: "crew", id: AGENT, label: "Mira", range: at(sentence, "flag") }],
  });
  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.success ? null : parsed.error.issues[0].path, ["context", 0, "range"]);
});

test("a regenerate may carry tokens with no message: their ranges are fitted on the server", () => {
  const parsed = chatBodySchema.safeParse({
    conversationId: PROJECT,
    regenerate: true,
    context: [{ kind: "crew", id: AGENT, label: "Mira", range: { start: 90, end: 94 } }],
  });
  assert.equal(parsed.success, true);
});

test("a canvas edit carries no tokens", () => {
  const parsed = chatBodySchema.safeParse({
    message: "make it shorter",
    artifactEdit: {
      artifactId: PROJECT,
      identifier: "plan",
      baseVersion: 1,
      kind: "text",
      text: "the plan",
    },
    context: [{ kind: "project", id: PROJECT, label: "Acme" }],
  });
  assert.equal(parsed.success, false);
});

test("a malformed token refuses the request rather than being silently dropped", () => {
  assert.equal(chatBodySchema.safeParse({ message: "hi", context: [{ kind: "file", id: "x", label: "a" }] }).success, false);
  assert.equal(chatBodySchema.safeParse({ message: "hi", context: "not a list" }).success, false);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("a tokenless first submission hashes exactly as it did before tokens existed", () => {
  const base = { message: "hello", model: "juno:auto", connectors: ["github"] };
  // The pre-token envelope, computed by hand: version 1, no `context` key.
  assert.equal(hashFirstSubmission({ ...base, context: [] }), hashFirstSubmission(base));
  assert.equal(hashFirstSubmission({ ...base, context: undefined }), hashFirstSubmission(base));
});

test("tokens are part of a first submission's identity, in any order, labels aside", () => {
  const base = { message: sentence };
  const withTokens = hashFirstSubmission({ ...base, context: tokens });
  assert.notEqual(withTokens, hashFirstSubmission(base));
  assert.equal(hashFirstSubmission({ ...base, context: [...tokens].reverse() }), withTokens);
  assert.equal(
    hashFirstSubmission({ ...base, context: tokens.map((token) => ({ ...token, label: "renamed" })) }),
    withTokens,
    "the server reads names from rows, so a label is not identity"
  );
  assert.notEqual(hashFirstSubmission({ ...base, context: tokens.slice(1) }), withTokens);
});

// ---------------------------------------------------------------------------
// Review fixes: labels, renamed things, and the web hook's trimmed text
// ---------------------------------------------------------------------------

test("a name becomes a token label the request accepts: one line, bounded, never empty words", () => {
  const long = `${"Quarterly revenue forecast ".repeat(12)}.xlsx`;
  const label = contextTokenLabel(long);
  assert.ok(label.length <= MAX_CONTEXT_TOKEN_LABEL_CHARS);
  assert.ok(label.endsWith("…"));
  assert.equal(contextTokenLabel("Q3\n\tForecast\u0000  final.xlsx"), "Q3 Forecast final.xlsx");
  assert.equal(contextTokenLabel("   "), "");
  // The palette inserts exactly this label into the sentence, so a token
  // built from it passes the schema however long or odd the name was.
  const text = `Compare ${label} please`;
  const parsed = chatBodySchema.safeParse({
    message: text,
    context: [{ kind: "file", id: FILE, label, range: at(text, label) }],
  });
  assert.equal(parsed.success, true);
  // The raw name would not: the whole send would have been refused.
  assert.equal(contextTokenSchema.safeParse({ kind: "file", id: FILE, label: long }).success, false);
});

test("a receipt for a thing renamed since the palette carries the chip's own words", () => {
  const typed = "Compare Q3 draft.xlsx now";
  const renamed: ContextReceipt = {
    version: 1,
    tokens: [
      {
        kind: "file",
        id: FILE,
        label: "Q3 Forecast (final).xlsx",
        text: "Q3 draft.xlsx",
        ranges: [at(typed, "Q3 draft.xlsx")],
        outcome: "applied",
        via: "attachment",
      },
    ],
  };
  assert.equal(contextReceiptSchema.safeParse(renamed).success, true);
  const back = contextTokensFromReceipt(renamed);
  assert.deepEqual(back, [{ kind: "file", id: FILE, label: "Q3 draft.xlsx", range: at(typed, "Q3 draft.xlsx") }]);
  // So the chip is drawn over the words the person typed, not lost.
  assert.deepEqual(
    segmentWithTokens(typed, back).map((segment) => segment.kind),
    ["text", "token", "text"]
  );
});

test("the web hook moves ranges onto the trimmed text it sends, so a leading space cannot refuse the send", () => {
  const draft = "\n  Compare Q3 Forecast.xlsx with Stripe  ";
  const drawn: ContextToken[] = [
    { kind: "file", id: FILE, label: "Q3 Forecast.xlsx", range: at(draft, "Q3 Forecast.xlsx") },
    { kind: "app", id: "composio:stripe", label: "Stripe", range: at(draft, "Stripe") },
  ];
  // What the hook used to send: trimmed text, ranges over the draft.
  assert.equal(chatBodySchema.safeParse({ message: draft.trim(), context: drawn }).success, false);
  // What it sends now.
  const sent = rangesForStoredText(draft, drawn);
  assert.equal(chatBodySchema.safeParse({ message: draft.trim(), context: sent }).success, true);
  // Moving them twice is a no-op, which is what lets the hook do it in `send`
  // and again in `startGeneration`.
  assert.deepEqual(rangesForStoredText(draft.trim(), sent), sent);

  const hook = readFileSync(new URL("../src/hooks/use-chat.ts", import.meta.url), "utf8");
  assert.match(hook, /context: rangesForStoredText\(text, sendOptions\.context\)/);
  assert.match(hook, /rangesForStoredText\(input\.text, input\.context\)/);
});
