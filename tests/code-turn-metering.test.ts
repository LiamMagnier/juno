import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codeTurnKey, codeTurnOpening, CODE_TURN_RETRY_WINDOW_SEC } from "@/lib/metering/code-turn";
import { inspectAgentRequest } from "@/lib/agent-proxy";

/*
 * A Code turn is counted from the provider call that opens it. These pin the
 * classifier (which call opens a turn, on each wire), the retry fingerprint,
 * and the wiring that keeps a turn from being counted twice.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The tools an agent loop's turn offers; every call in these tests is one unless it says otherwise. */
const TOOLS = [{ name: "read", input_schema: { type: "object" } }];
const withTools = (body: Record<string, unknown>) => ("tools" in body ? body : { ...body, tools: TOOLS });

function opens(wire: Parameters<typeof codeTurnOpening>[0], body: Record<string, unknown>): boolean {
  return codeTurnOpening(wire, withTools(body)).opens;
}

function fingerprint(wire: Parameters<typeof codeTurnOpening>[0], body: Record<string, unknown>): string {
  const turn = codeTurnOpening(wire, withTools(body));
  assert.ok(turn.opens, "expected an opening");
  return turn.fingerprint;
}

test("Anthropic: the person's message opens a turn, tool results continue it", () => {
  const opening = {
    model: "claude-opus-5-5",
    system: "You are a coding agent.",
    messages: [{ role: "user", content: "Fix the failing test in src/app.ts" }],
  };
  assert.equal(opens("anthropic", opening), true);
  // Block form, with a picture beside the words.
  assert.equal(
    opens("anthropic", {
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", source: {} }] }],
    }),
    true,
  );
  // The loop answering a tool call is the same turn, even with text after the result.
  assert.equal(
    opens("anthropic", {
      model: "claude-opus-5-5",
      messages: [
        { role: "user", content: "Fix it" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file contents" },
            { type: "text", text: "Keep going." },
          ],
        },
      ],
    }),
    false,
  );
  // An assistant prefill is not the person speaking.
  assert.equal(
    opens("anthropic", {
      model: "claude-opus-5-5",
      messages: [
        { role: "user", content: "Fix it" },
        { role: "assistant", content: "Sure" },
      ],
    }),
    false,
  );
  // Nothing readable is never an opening.
  assert.equal(opens("anthropic", { model: "claude-opus-5-5", messages: [] }), false);
  assert.equal(opens("anthropic", { model: "claude-opus-5-5", messages: [{ role: "user", content: "   " }] }), false);
  assert.equal(opens("anthropic", { model: "claude-opus-5-5" }), false);
});

test("Chat Completions: a closing user message opens, a tool message continues", () => {
  assert.equal(
    opens("openai-chat", {
      model: "gpt-6-sol",
      messages: [
        { role: "system", content: "Agent." },
        { role: "user", content: "Add a README" },
      ],
    }),
    true,
  );
  assert.equal(
    opens("openai-chat", {
      model: "gpt-6-sol",
      messages: [
        { role: "user", content: "Add a README" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    }),
    false,
  );
});

test("Responses: a user input opens, a function call output continues", () => {
  assert.equal(opens("openai-responses", { model: "gpt-6-sol", input: "Refactor the parser" }), true);
  assert.equal(
    opens("openai-responses", {
      model: "gpt-6-sol",
      input: [{ role: "user", content: [{ type: "input_text", text: "Refactor the parser" }] }],
    }),
    true,
  );
  assert.equal(
    opens("openai-responses", {
      model: "gpt-6-sol",
      input: [
        { type: "message", role: "user", content: "Refactor the parser" },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    }),
    false,
  );
  assert.equal(
    opens("openai-responses", {
      model: "gpt-6-sol",
      input: [{ type: "message", role: "assistant", content: "Done" }],
    }),
    false,
  );
});

test("a side call that offers no tools is never a turn, on any wire", () => {
  // The auto-reviewer, the completion judge, a hook's prompt, a title or a
  // summary: the engine's own words in a user message, sent with no tools.
  const words = "Review this step: rm -rf build. Reply allow or deny.";
  for (const tools of [undefined, []]) {
    const extra = tools ? { tools } : {};
    assert.equal(
      codeTurnOpening("anthropic", { model: "claude-opus-5-5", ...extra, messages: [{ role: "user", content: words }] }).opens,
      false,
    );
    assert.equal(
      codeTurnOpening("openai-chat", { model: "gpt-6-sol", ...extra, messages: [{ role: "user", content: words }] }).opens,
      false,
    );
    assert.equal(codeTurnOpening("openai-responses", { model: "gpt-6-sol", ...extra, input: words }).opens, false);
  }
  // Chat Completions' older `functions` spelling still offers tools.
  assert.equal(
    codeTurnOpening("openai-chat", {
      model: "gpt-6-sol",
      functions: [{ name: "read" }],
      messages: [{ role: "user", content: "Add a README" }],
    }).opens,
    true,
  );
});

test("a retried opening has the same fingerprint, the next turn a different one", () => {
  const first = {
    model: "claude-opus-5-5",
    stream: true,
    messages: [{ role: "user", content: "Run the tests" }],
  };
  // The same body again, as an engine's retry sends it.
  assert.equal(fingerprint("anthropic", first), fingerprint("anthropic", structuredClone(first)));
  // The same words later in the conversation are a new turn.
  const later = {
    model: "claude-opus-5-5",
    messages: [
      { role: "user", content: "Run the tests" },
      { role: "assistant", content: "All pass." },
      { role: "user", content: "Run the tests" },
    ],
  };
  assert.notEqual(fingerprint("anthropic", first), fingerprint("anthropic", later));
  // Another model, another wire: different openings.
  assert.notEqual(
    fingerprint("anthropic", first),
    fingerprint("anthropic", { ...first, model: "claude-sonnet-5" }),
  );
  assert.notEqual(
    fingerprint("openai-chat", { model: "gpt-6-sol", messages: [{ role: "user", content: "Run the tests" }] }),
    fingerprint("openai-responses", { model: "gpt-6-sol", input: [{ role: "user", content: "Run the tests" }] }),
  );
  // Keys are per account, and short enough for the shared table.
  const key = codeTurnKey("user_1", fingerprint("anthropic", first));
  assert.match(key, /^code-turn:user_1:[0-9a-f]{40}$/);
  assert.notEqual(key, codeTurnKey("user_2", fingerprint("anthropic", first)));
  assert.ok(CODE_TURN_RETRY_WINDOW_SEC >= 90, "the window covers an engine's whole retry budget");
});

test("a pathologically nested opening is fingerprinted without recursion", () => {
  // Valid JSON the provider would accept; a recursive walk overflows on it.
  const depth = 50_000;
  const raw = `{"model":"gpt-6-sol","tools":[{"type":"function","function":{"name":"read"}}],"messages":[{"role":"user","content":${"[".repeat(depth)}"x"${"]".repeat(depth)}}]}`;
  const checked = inspectAgentRequest("openai-chat", raw);
  assert.ok(checked.ok);
  assert.equal(checked.request.turn?.opens, true);
  const again = inspectAgentRequest("openai-chat", raw);
  assert.ok(again.ok && again.request.turn?.opens && checked.request.turn?.opens);
  assert.equal(
    again.request.turn.opens && again.request.turn.fingerprint,
    checked.request.turn.opens && checked.request.turn.fingerprint,
  );
});

test("inspectAgentRequest reports whether the call opens a turn", () => {
  const opening = inspectAgentRequest(
    "anthropic",
    JSON.stringify({ model: "claude-opus-5-5", tools: TOOLS, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.ok(opening.ok);
  assert.equal(opening.request.turn?.opens, true);
  const continuing = inspectAgentRequest(
    "openai-chat",
    JSON.stringify({ model: "gpt-6-sol", messages: [{ role: "tool", tool_call_id: "c", content: "x" }] }),
  );
  assert.ok(continuing.ok);
  assert.equal(continuing.request.turn?.opens, false);
});

test("the proxy admits like a chat turn and counts the opening once it is billed", () => {
  const route = read("../src/app/api/agent/[...path]/route.ts");
  // Admission happens before the provider is called, and only on Alevr's key.
  const admit = route.indexOf("admitCodeCall(");
  assert.ok(admit > 0);
  assert.ok(admit < route.indexOf("await fetch(target"), "admitted before the provider is called");
  assert.match(route, /if \(!byok\) \{\s*const admission = await admitCodeCall/);
  // Counting rides the billing write: after the BYOK early return, beside recordSpend.
  const count = route.indexOf("countCodeTurn(");
  const byokReturn = route.indexOf("recordByokUsage(");
  const spend = route.indexOf('recordSpend({ userId, model: spendModel, kind: "code"');
  assert.ok(byokReturn > 0 && spend > byokReturn && count > spend, "counted only where the call is billed to Alevr");
  assert.match(route, /if \(request\.turn\?\.opens\) \{/);
});

test("the reporter route no longer moves the counter, so its hosts are not counted twice", () => {
  const usageRoute = read("../src/app/api/agent/usage/route.ts");
  assert.doesNotMatch(usageRoute, /reserveCodeMessage/);
  assert.match(usageRoute, /openCodeUsageReservation\(user\.id\)/);
  // Admission parity with chat: an unconfirmed address is refused at start.
  assert.match(usageRoute, /reason: "email_unverified"/);
  const usage = read("../src/lib/usage.ts");
  const resolve = usage.slice(usage.indexOf("export async function resolveCodeUsageReservation"));
  assert.doesNotMatch(resolve.slice(0, resolve.indexOf("\n}\n")), /decrement/);
  assert.doesNotMatch(usage, /export async function reserveCodeMessage/);
});
