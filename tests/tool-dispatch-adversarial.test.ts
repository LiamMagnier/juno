import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TOOL_RESULT_CHARS, executeToolBatch } from "@/lib/tools/dispatch";
import { coercePortableArguments, portableArgumentsProblem } from "@/lib/tools/validate";
import { defineTool, type BatchResult, type ChatToolset, type PortableSchema, type ResolvedTool, type ToolCallInput, type ToolExecuteOptions } from "@/lib/tools/types";
import { toolCallingVerdict } from "@/lib/model-tool-probe";
import { wrapUntrusted, UNTRUSTED_CLOSE } from "@/lib/untrusted-content";
import type { ToolExecution } from "@/lib/mcp";
import type { LlmEvent } from "@/types/llm";

/*
 * The L1 adversarial review's findings, each pinned on the dispatcher's
 * contract rather than on one adapter: what a tool RUNS with after a lenient
 * check, what a malformed call can do to a batch, what happens to running
 * calls when the consumer walks away, what an executor can still say after its
 * call is answered, what a model is told after a write it could not watch end,
 * what a thrown internal error is allowed to reveal, and how big a result may
 * be. Offline and free of `server-only`.
 */

type Executor = (args: Record<string, unknown>, signal: AbortSignal | undefined, opts: ToolExecuteOptions | undefined) => Promise<ToolExecution>;

function toolset(entries: Array<{ resolved: ResolvedTool; run: Executor }>): ChatToolset & { dispatched: Array<Record<string, unknown>> } {
  const byName = new Map(entries.map((entry) => [entry.resolved.name, entry]));
  const dispatched: Array<Record<string, unknown>> = [];
  return {
    dispatched,
    tools: entries.map((entry) => ({ type: "function" as const, function: { name: entry.resolved.name, parameters: {} } })),
    resolve: (name) => byName.get(name)?.resolved,
    labelFor: (name) => byName.get(name)?.resolved.title ?? name,
    accessFor: () => "read",
    async execute(name, args, signal, _callId, opts) {
      dispatched.push(args);
      return byName.get(name)!.run(args, signal, opts);
    },
    close: async () => {},
  };
}

const SCHEMA: PortableSchema = {
  type: "object",
  properties: {
    code: { type: "string", description: "Code." },
    network: { type: "boolean", description: "Allow network." },
    seconds: { type: "integer", description: "Budget." },
    ratio: { type: "number", description: "Ratio." },
    note: { type: "string", description: "Optional note." },
    files: {
      type: "array",
      description: "Files.",
      items: {
        type: "object",
        description: "A file.",
        properties: { keep: { type: "boolean", description: "Keep it." }, size: { type: "number", description: "Bytes." } },
      },
    },
  },
  required: ["code"],
};

function resolved(name: string, overrides: Partial<ResolvedTool> = {}): ResolvedTool {
  return { name, origin: "alevr", title: name, risk: "read", parallelSafe: false, timeoutMs: 5_000, dedupe: false, input: SCHEMA, ...overrides };
}

const ok = (text: string): ToolExecution => ({ text, body: text, ok: true });
const call = (name: string, argsText: string, index = 0): ToolCallInput => ({ name, callId: `jc_0_${index}`, round: 0, index, argsText });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(gen: AsyncGenerator<LlmEvent, BatchResult[]>): Promise<{ events: LlmEvent[]; results: BatchResult[] }> {
  const events: LlmEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, results: next.value };
    events.push(next.value);
  }
}

test("a value the lenient check admits runs in its DECLARED type: \"false\" is false, never a truthy string", async () => {
  const tools = toolset([{ resolved: resolved("run_code"), run: async (_a, _s, opts) => (opts?.onAuthorized?.(), ok("ran")) }]);
  await drain(
    executeToolBatch(
      [call("run_code", JSON.stringify({ code: "print(1)", network: "false", seconds: "30", ratio: "0.5", note: null, files: [{ keep: "true", size: "12" }] }))],
      new AbortController().signal,
      { toolset: tools, cache: new Map() },
    ),
  );
  assert.deepEqual(tools.dispatched[0], { code: "print(1)", network: false, seconds: 30, ratio: 0.5, files: [{ keep: true, size: 12 }] });
  assert.equal(Object.hasOwn(tools.dispatched[0], "note"), false, "a null optional field is left out, never handed over as null");
  // The pure helpers agree with the dispatcher.
  const args = { code: "x", network: "true" };
  assert.equal(portableArgumentsProblem(args, SCHEMA), null);
  assert.deepEqual(coercePortableArguments(args, SCHEMA), { code: "x", network: true });
});

test("arguments nested deep enough to overflow the checks are answered as malformed, and the batch still answers every call", async () => {
  const deep = `{"code":"x","files":${"[".repeat(200_000)}${"]".repeat(200_000)}}`;
  const connectorDeep = `{"q":${"[".repeat(200_000)}${"]".repeat(200_000)}}`;
  const tools = toolset([
    { resolved: resolved("run_code"), run: async () => ok("never") },
    { resolved: resolved("gh__search", { origin: "connector", input: undefined, inputSchema: { type: "object" }, dedupe: true }), run: async () => ok("never") },
    { resolved: resolved("lookup", { input: { type: "object", properties: {} } }), run: async (_a, _s, opts) => (opts?.onAuthorized?.(), ok("fine")) },
  ]);
  const { results } = await drain(
    executeToolBatch([call("run_code", deep, 0), call("gh__search", connectorDeep, 1), call("lookup", "{}", 2)], new AbortController().signal, {
      toolset: tools,
      cache: new Map(),
    }),
  );
  assert.equal(results.length, 3);
  assert.equal(results[0].errorCode, "invalid_args");
  assert.equal(results[1].errorCode, "invalid_args");
  // The connector's own check is shallow; the overflow is in the duplicate key, and it is caught.
  assert.match(results[1].text, /nested too deeply.*Nothing was run/);
  assert.equal(results[2].text, "fine");
  assert.equal(tools.dispatched.length, 1, "only the well-formed call ran");
});

test("a consumer that walks away mid-batch cancels the calls still running", async () => {
  let seenAbort = false;
  const tools = toolset([
    {
      resolved: resolved("run_code", { risk: "destructive" }),
      run: async (_a, signal, opts) => {
        opts?.onAuthorized?.();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        seenAbort = true;
        return ok("stopped");
      },
    },
  ]);
  const turn = new AbortController();
  const gen = executeToolBatch([call("run_code", '{"code":"while True: pass"}')], turn.signal, { toolset: tools, cache: new Map() });
  for (;;) {
    const next = await gen.next();
    if (next.done) break;
    if (next.value.type === "tool" && next.value.phase === "status" && next.value.status === "running") break;
  }
  // The route threw or broke out of its loop: `return()` reaches the dispatcher at a yield.
  await gen.return([]);
  await sleep(5);
  assert.equal(seenAbort, true, "the executor's signal was aborted although the turn's was not");
  assert.equal(turn.signal.aborted, false);
});

test("nothing an executor reports after its call is answered reaches the stream", async () => {
  const tools = toolset([
    {
      resolved: resolved("first", { input: { type: "object", properties: {} } }),
      // Returns without ever authorising, then reports late: a late `running`
      // would hold the stall watchdog for the rest of the turn.
      run: async (_a, _s, opts) => {
        setTimeout(() => {
          opts?.onAuthorized?.();
          opts?.reportProgress?.({ lines: [{ stream: "stdout", text: "late" }] });
          opts?.onApprovalRequest?.({} as never);
        }, 0);
        return ok("answered");
      },
    },
    {
      resolved: resolved("second", { input: { type: "object", properties: {} } }),
      run: async (_a, _s, opts) => {
        opts?.onAuthorized?.();
        await sleep(30);
        return ok("done");
      },
    },
  ]);
  const { events } = await drain(
    executeToolBatch([call("first", "{}", 0), call("second", "{}", 1)], new AbortController().signal, { toolset: tools, cache: new Map() }),
  );
  const forFirst = events
    .filter((e): e is Extract<LlmEvent, { type: "tool" }> => e.type === "tool" && e.callId === "jc_0_0")
    .map((e) => (e.phase === "status" ? e.status : e.phase));
  assert.deepEqual(forFirst, ["queued", "result"]);
});

test("a write that times out or is stopped mid-run is not claimed to have done nothing", async () => {
  const hang: Executor = async (_a, signal, opts) => {
    opts?.onAuthorized?.();
    await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return ok("never");
  };
  const write = await drain(
    executeToolBatch([call("send", '{"code":"x"}')], new AbortController().signal, {
      toolset: toolset([{ resolved: resolved("send", { risk: "external", timeoutMs: 20 }), run: hang }]),
      cache: new Map(),
    }),
  );
  assert.equal(write.results[0].errorCode, "timeout");
  assert.match(write.results[0].text, /may still have taken effect/);
  const read = await drain(
    executeToolBatch([call("look", '{"code":"x"}')], new AbortController().signal, {
      toolset: toolset([{ resolved: resolved("look", { timeoutMs: 20 }), run: hang }]),
      cache: new Map(),
    }),
  );
  assert.match(read.results[0].text, /Try a narrower request/);

  const turn = new AbortController();
  const gen = executeToolBatch([call("send", '{"code":"x"}')], turn.signal, {
    toolset: toolset([{ resolved: resolved("send", { risk: "external" }), run: hang }]),
    cache: new Map(),
  });
  const events: LlmEvent[] = [];
  await assert.rejects(async () => {
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === "tool" && next.value.phase === "status" && next.value.status === "running") turn.abort();
    }
  });
  const stopped = events.find((e) => e.type === "tool" && e.phase === "result") as { result: string; status: string };
  assert.equal(stopped.status, "cancelled");
  assert.match(stopped.result, /may have partly or fully taken effect/);
});

test("an Alevr or native tool that throws reveals nothing of its error; a connector's error stays its own, enveloped", async () => {
  const secretish = "PrismaClientKnownRequestError: connect to db.internal:5432 failed for user juno_app";
  const original = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    for (const origin of ["alevr", "native"] as const) {
      const { results, events } = await drain(
        executeToolBatch([call("boom", '{"code":"x"}')], new AbortController().signal, {
          toolset: toolset([{ resolved: resolved("boom", { origin }), run: async () => { throw new Error(secretish); } }]),
          cache: new Map(),
        }),
      );
      assert.equal(results[0].errorCode, "tool_error");
      assert.doesNotMatch(results[0].text, /db\.internal|Prisma|juno_app/);
      const row = events.find((e) => e.type === "tool" && e.phase === "result") as { result: string };
      assert.doesNotMatch(row.result, /db\.internal|Prisma|juno_app/, "nor does the panel's copy");
    }
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2, "the detail goes to the server log instead");
  const { results } = await drain(
    executeToolBatch([call("gh__x", "{}")], new AbortController().signal, {
      toolset: toolset([
        { resolved: resolved("gh__x", { origin: "connector", input: undefined, inputSchema: { type: "object" } }), run: async () => { throw new Error("rate limited by GitHub"); } },
      ]),
      cache: new Map(),
    }),
  );
  assert.match(results[0].text, /rate limited by GitHub/);
  assert.ok(results[0].text.trimEnd().endsWith(UNTRUSTED_CLOSE));
});

test("a result over the ceiling is withheld whole, never cut through its envelope", async () => {
  const huge = wrapUntrusted("stdout", "x".repeat(MAX_TOOL_RESULT_CHARS + 10));
  const { results, events } = await drain(
    executeToolBatch([call("run_code", '{"code":"print(\'x\'*10**6)"}')], new AbortController().signal, {
      toolset: toolset([{ resolved: resolved("run_code"), run: async (_a, _s, opts) => (opts?.onAuthorized?.(), { text: huge, body: "x".repeat(MAX_TOOL_RESULT_CHARS + 10), ok: true }) }]),
      cache: new Map(),
    }),
  );
  assert.ok(results[0].text.length < 500);
  assert.match(results[0].text, /withheld/);
  assert.equal(results[0].status, "succeeded", "the run itself is not misreported");
  const row = events.find((e) => e.type === "tool" && e.phase === "result") as { result: string };
  assert.ok(row.result.length <= MAX_TOOL_RESULT_CHARS + 500);
});

test("a spec may skip the broker only as a read", () => {
  const base = {
    id: "fetch_rows",
    title: "Fetch rows",
    description: "Fetch rows.",
    input: { type: "object" as const, properties: {} },
    parallelSafe: false,
    timeoutMs: 1_000,
    dedupe: false,
    execute: async () => ({ status: "succeeded" as const, text: "", body: "" }),
  };
  assert.doesNotThrow(() => defineTool({ ...base, risk: "read", broker: "none" }));
  assert.throws(() => defineTool({ ...base, risk: "write", broker: "none" }), /only a read may skip the broker/);
  assert.throws(() => defineTool({ ...base, risk: "destructive", broker: "none" }), /only a read may skip the broker/);
});

test("probe evidence gathered through another adapter does not verify this turn's", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  const evidence = {
    tools: {
      probeVersion: 2,
      verdict: "verified",
      checkedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      adapter: "openai-compatible",
      checks: { roundTrip: "passed", parallel: "passed", toolImage: "skipped" },
    },
  };
  assert.equal(toolCallingVerdict(evidence, now), "verified");
  assert.equal(toolCallingVerdict(evidence, now, "openai-compatible"), "verified");
  assert.equal(toolCallingVerdict(evidence, now, "openai-responses"), "untested", "Pro mode moves the model onto Responses");
});
