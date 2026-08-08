/**
 * The policy behind a tool row: what is redacted, what is cut, what is refused,
 * and what survives a reload.
 *
 * These are the parts most worth a test because they are the parts that fail
 * SILENTLY. A redactor that stops masking still renders. A budget that stops
 * counting still renders. A whitelist that drops a field renders perfectly for
 * the whole of the stream and only loses the payload on the next page load —
 * which is the exact bug this module's `readToolDetail` exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_DETAIL_CHARS_PER_RUN,
  MAX_TOOL_RESULT_CHARS,
  closeToolDetail,
  createToolDetailBudget,
  openToolDetail,
  readToolDetail,
  stripUntrustedEnvelope,
} from "@/lib/chat/tool-detail";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { ClientToolDetail } from "@/types/chat";

const fresh = () => createToolDetailBudget();

// ---------------------------------------------------------------- arguments

test("arguments are redacted by the SAME helper the approval card uses", () => {
  const detail = openToolDetail(
    {
      server: "Linear",
      name: "linear__create_issue",
      args: JSON.stringify({ title: "Fix login", api_key: "sk-live-abc123", nested: { authorization: "Bearer xyz" } }),
    },
    fresh()
  );

  assert.ok(detail.args);
  assert.match(detail.args, /"title": "Fix login"/);
  // Widened SECRET_KEY: api_key and authorization, at any depth.
  assert.doesNotMatch(detail.args, /sk-live-abc123/);
  assert.doesNotMatch(detail.args, /Bearer xyz/);
  assert.match(detail.args, /"api_key": "\[redacted\]"/);
  assert.match(detail.args, /"authorization": "\[redacted\]"/);
});

test("arguments are pretty-printed on the server so the panel never re-formats", () => {
  const detail = openToolDetail({ server: "S", name: "t", args: '{"a":1,"b":{"c":2}}' }, fresh());
  assert.equal(detail.args, '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
});

test("oversized arguments are cut to a HEAD and say so", () => {
  const args = JSON.stringify({ body: "x".repeat(MAX_TOOL_ARGS_CHARS * 2) });
  const detail = openToolDetail({ server: "S", name: "t", args }, fresh());

  assert.equal(detail.args?.length, MAX_TOOL_ARGS_CHARS);
  assert.equal(detail.argsTruncated, true);
});

test("every reason arguments can be missing has its own note, and none is silent", () => {
  const note = (args?: string) => {
    const d = openToolDetail({ server: "S", name: "t", args }, fresh());
    assert.equal(d.args, undefined, "a noted absence must not also carry a payload");
    return d.argsNote;
  };

  assert.equal(note(undefined), "unavailable");
  assert.equal(note(""), "empty");
  assert.equal(note("   "), "empty");
  assert.equal(note("{}"), "empty");
  assert.equal(note("{not json"), "unparsable");
});

// ------------------------------------------------------------------ results

test("the untrusted envelope never reaches the panel", () => {
  const wrapped = wrapUntrusted("GitHub · list_issues", "issue one\nissue two");
  assert.equal(stripUntrustedEnvelope(wrapped), "issue one\nissue two");
  // Idempotent: a body that was already unwrapped passes through untouched.
  assert.equal(stripUntrustedEnvelope("issue one"), "issue one");

  const detail = closeToolDetail(undefined, { server: "S", name: "t", result: wrapped, ok: true }, fresh());
  assert.equal(detail.result, "issue one\nissue two");
});

test("a JSON result is pretty-printed once, on the server that holds the whole of it", () => {
  const detail = closeToolDetail(undefined, { server: "S", name: "t", result: '{"id":7,"open":true}', ok: true }, fresh());
  assert.equal(detail.result, '{\n  "id": 7,\n  "open": true\n}');
});

test("a non-JSON result is passed through verbatim rather than mangled", () => {
  const prose = "Deployed 3 minutes ago by robin.";
  const detail = closeToolDetail(undefined, { server: "S", name: "t", result: prose, ok: true }, fresh());
  assert.equal(detail.result, prose);
});

test("a long result is cut to a head and names the length it was cut FROM", () => {
  const body = "y".repeat(26_318);
  const detail = closeToolDetail(undefined, { server: "S", name: "t", result: body, ok: true }, fresh());

  assert.equal(detail.result?.length, MAX_TOOL_RESULT_CHARS);
  assert.equal(detail.resultTruncated, true);
  // "first 4000 of 26318" must be a true statement about ONE string.
  assert.equal(detail.resultChars, body.length);
});

test("resultChars is measured after pretty-printing, on the text the cut was taken from", () => {
  const rows = Array.from({ length: 900 }, (_, i) => ({ id: i, title: `row ${i}` }));
  const raw = JSON.stringify(rows);
  const detail = closeToolDetail(undefined, { server: "S", name: "t", result: raw, ok: true }, fresh());

  assert.equal(detail.resultTruncated, true);
  assert.equal(detail.resultChars, JSON.stringify(rows, null, 2).length);
  assert.notEqual(detail.resultChars, raw.length);
});

test("an empty result is a stated fact, not a missing field", () => {
  const detail = closeToolDetail(undefined, { server: "S", name: "t", result: "   ", ok: true }, fresh());
  assert.equal(detail.result, undefined);
  assert.equal(detail.resultNote, "empty");
  assert.equal(detail.status, "ok");
});

test("results are NOT key-masked — the caption says so and the code must match it", () => {
  // A connector answering with the user's own secrets is the user's own data
  // coming back to them. Sniffing prose for them would mangle legitimate
  // content and buy confidence it has not earned.
  const body = "password: hunter2\ntoken=abc";
  const detail = closeToolDetail(undefined, { server: "S", name: "t", result: body, ok: true }, fresh());
  assert.equal(detail.result, body);
});

// ------------------------------------------------------------------ outcome

test("failure comes from the toolset's own verdict, never from the text", () => {
  const budget = fresh();
  // A GitHub issue whose TITLE reads like a failure must not read as one.
  const innocent = closeToolDetail(undefined, { server: "S", name: "t", result: "Tool error: build fails", ok: true }, budget);
  assert.equal(innocent.status, "ok");

  const real = closeToolDetail(undefined, { server: "S", name: "t", result: "Action not permitted: policy", ok: false }, budget);
  assert.equal(real.status, "failed");
});

test("a call that never reached the network has NO duration — absent, not zero", () => {
  const refused = closeToolDetail(undefined, { server: "S", name: "t", result: "Unknown tool: x", ok: false }, fresh());
  assert.equal("durationMs" in refused, false);

  const dispatched = closeToolDetail(undefined, { server: "S", name: "t", result: "ok", ok: true, durationMs: 412 }, fresh());
  assert.equal(dispatched.durationMs, 412);
});

// ------------------------------------------------------------------ pairing

test("the live row is pending, with no status and no duration to lie with", () => {
  const open = openToolDetail({ server: "Linear", name: "linear__create_issue", args: '{"title":"x"}' }, fresh());
  assert.equal(open.resultNote, "pending");
  assert.equal(open.result, undefined);
  assert.equal(open.status, undefined);
  assert.equal(open.durationMs, undefined);
});

test("ANTHROPIC: args absent at the call are resolved from the result", () => {
  const budget = fresh();
  const open = openToolDetail({ server: "Linear", name: "linear__create_issue" }, budget);
  assert.equal(open.argsNote, "unavailable");

  const closed = closeToolDetail(open, { server: "Linear", name: "linear__create_issue", args: '{"title":"Fix"}', result: "created", ok: true }, budget);
  assert.equal(closed.argsNote, undefined);
  assert.match(closed.args ?? "", /"title": "Fix"/);
});

test("OPENAI: args resolved at the call are carried forward and charged only once", () => {
  const budget = fresh();
  const before = budget.remaining;
  const open = openToolDetail({ server: "S", name: "t", args: '{"title":"Fix"}' }, budget);
  const afterOpen = budget.remaining;

  const closed = closeToolDetail(open, { server: "S", name: "t", result: "created", ok: true }, budget);
  assert.equal(closed.args, open.args);
  assert.equal(before - afterOpen, open.args?.length);
  // Only the result was charged the second time round.
  assert.equal(afterOpen - budget.remaining, closed.result?.length);
});

test("args that were never supplied on EITHER act stay unavailable, honestly", () => {
  const budget = fresh();
  const open = openToolDetail({ server: "S", name: "t" }, budget);
  const closed = closeToolDetail(open, { server: "S", name: "t", result: "done", ok: true }, budget);
  assert.equal(closed.argsNote, "unavailable");
  assert.equal(closed.args, undefined);
});

// ------------------------------------------------------------------- budget

test("an exhausted run budget is reported on the row, not hidden by a silent cut", () => {
  const budget = createToolDetailBudget(20);
  const open = openToolDetail({ server: "S", name: "t", args: JSON.stringify({ body: "z".repeat(500) }) }, budget);

  assert.equal(open.args, undefined);
  assert.equal(open.argsNote, "over_budget");
  assert.equal(budget.remaining, 0);

  const closed = closeToolDetail(open, { server: "S", name: "t", result: "anything", ok: true }, budget);
  assert.equal(closed.argsNote, "over_budget");
  assert.equal(closed.result, undefined);
  assert.equal(closed.resultNote, "over_budget");
  // The row still tells the truth about the call itself.
  assert.equal(closed.status, "ok");
});

test("the budget bounds the RUN, which per-call caps alone do not", () => {
  const budget = fresh();
  const rows: ClientToolDetail[] = [];
  // 30 calls is a realistic 6-round connector turn with parallel dispatch:
  // 180,000 characters at the per-call caps alone.
  for (let i = 0; i < 30; i++) {
    const open = openToolDetail({ server: "S", name: `t${i}`, args: JSON.stringify({ body: "a".repeat(5_000) }) }, budget);
    rows.push(closeToolDetail(open, { server: "S", name: `t${i}`, result: "b".repeat(30_000), ok: true }, budget));
  }

  const shipped = rows.reduce((n, r) => n + (r.args?.length ?? 0) + (r.result?.length ?? 0), 0);
  assert.ok(shipped <= MAX_TOOL_DETAIL_CHARS_PER_RUN, `${shipped} exceeds the run budget`);
  assert.ok(shipped > 0, "the first calls must still carry their payloads");
  // Later rows say why they are bare rather than looking like calls with no output.
  assert.equal(rows.at(-1)?.resultNote, "over_budget");
});

// -------------------------------------------------------------- persistence

test("a run stopped mid-call reloads as unfinished, never as still running", () => {
  const open = openToolDetail({ server: "Linear", name: "linear__create_issue", args: '{"title":"x"}' }, fresh());
  assert.equal(open.resultNote, "pending");

  // The row is persisted exactly as it stood when the stream was cut.
  const reloaded = readToolDetail(JSON.parse(JSON.stringify(open)));
  assert.equal(reloaded?.resultNote, "unfinished");
  assert.equal(reloaded?.status, undefined);
  assert.equal(reloaded?.args, open.args);
});

test("every field of a completed row survives the JSON round trip", () => {
  // The guard against `serializeActivity`'s whitelist quietly dropping a field:
  // a payload that streams live and vanishes on reload looks exactly like the
  // feature working right up until someone refreshes.
  const full: Required<ClientToolDetail> = {
    server: "Linear",
    name: "linear__create_issue",
    args: '{\n  "title": "Fix"\n}',
    argsNote: "over_budget",
    argsTruncated: true,
    result: "created",
    resultNote: "empty",
    resultTruncated: true,
    resultChars: 26_318,
    status: "failed",
    durationMs: 412,
  };

  assert.deepEqual(readToolDetail(JSON.parse(JSON.stringify(full))), full);
});

test("a real streamed row round-trips unchanged", () => {
  const budget = fresh();
  const open = openToolDetail({ server: "Linear", name: "linear__create_issue", args: '{"title":"Fix","token":"s3cret"}' }, budget);
  const closed = closeToolDetail(open, { server: "Linear", name: "linear__create_issue", result: '{"id":7}', ok: true, durationMs: 88 }, budget);

  assert.deepEqual(readToolDetail(JSON.parse(JSON.stringify(closed))), closed);
});

test("a message written before this shipped loads with no tool detail at all", () => {
  assert.equal(readToolDetail(undefined), undefined);
  assert.equal(readToolDetail(null), undefined);
  assert.equal(readToolDetail("tool"), undefined);
  assert.equal(readToolDetail([]), undefined);
  // A row with no identity is not a row.
  assert.equal(readToolDetail({ args: "{}" }), undefined);
});

test("a row from a LATER build degrades one field, never the whole event", () => {
  const detail = readToolDetail({
    server: "S",
    name: "t",
    result: "ok",
    resultNote: "quarantined_by_a_future_build",
    status: "partial",
    durationMs: -1,
    resultChars: Number.NaN,
    extra: { unknown: true },
  });

  assert.deepEqual(detail, { server: "S", name: "t", result: "ok" });
});
