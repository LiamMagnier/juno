import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_PROBE_TTL_MS,
  TOOL_PROBE_VERSION,
  runToolProbe,
  solidPng,
  toolCallingVerdict,
  type ProbeStream,
  type ToolProbeEvidence,
} from "@/lib/model-tool-probe";
import { getModel, type ModelInfo } from "@/lib/models";
import { providerAdapterFor } from "@/lib/provider-routing";
import type { LlmEvent } from "@/types/llm";
import { scripted, sseResponse } from "./fixtures/tool-loop";

/*
 * V6/V7 (TOOL_RUNTIME_DESIGN §6.11, §7 L1): the tool round-trip probe, run
 * through each adapter family's REAL adapter and the real dispatcher, against a
 * scripted model. The scripted model reads what the adapter actually sent —
 * the prompt, the tool results, the image parts — so a pass means the round
 * trip happened on the wire, not that a test said so.
 *
 * No provider keys exist in this environment, so no live evidence can be
 * recorded: every catalog model stays `untested` (pinned at the bottom).
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { streamAnthropic } = req("../src/lib/anthropic") as typeof import("@/lib/anthropic");
const { streamOpenAICompat } = req("../src/lib/openai-compat") as typeof import("@/lib/openai-compat");
const { streamOpenAIResponses } = req("../src/lib/openai-responses") as typeof import("@/lib/openai-responses");
const { streamGemini } = req("../src/lib/gemini") as typeof import("@/lib/gemini");

// ── A scripted model: the same brain behind every wire ────────────────────────

interface Plan {
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  text?: string;
}
type Brain = (input: { prompt: string; results: string[]; sawImage: boolean }) => Plan;

const competent: Brain = ({ prompt, results, sawImage }) => {
  if (results.length === 0) {
    if (prompt.includes("1234")) return { calls: [{ name: "multiply", args: { a: 1234, b: 5678 } }] };
    if (prompt.includes("12 times 13")) {
      return { calls: [{ name: "multiply", args: { a: 12, b: 13 } }, { name: "multiply", args: { a: 21, b: 22 } }] };
    }
    if (prompt.includes("show_swatch")) return { calls: [{ name: "show_swatch", args: {} }] };
    return { text: "Hello." };
  }
  if (prompt.includes("show_swatch")) return { text: sawImage ? "Red" : "I cannot see an image." };
  const numbers = results.map((r) => r.match(/-?\d+/)?.[0]).filter(Boolean);
  // A thousands separator, as a model would write it.
  return { text: numbers.map((n) => Number(n).toLocaleString("en-US")).join(" and ") };
};

const neverCalls: Brain = () => ({ text: "The answer is probably about seven million." });
const badArgs: Brain = ({ results }) => (results.length ? { text: "Done." } : { calls: [{ name: "multiply", args: { a: "lots" } }] });

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => textOf((part as { text?: unknown; content?: unknown }).text ?? (part as { content?: unknown }).content ?? "")).join("");
  return "";
};

// ── Per-family wire encoders around the brain ─────────────────────────────────

function anthropicStream(model: ModelInfo, brain: Brain): ProbeStream {
  return ({ system, prompt, tools, signal }) => {
    let n = 0;
    return streamAnthropic(model, system, [{ role: "USER", content: prompt, attachments: [] }], 1_024, signal, undefined, false, tools, undefined, false, undefined, {
      async create(params) {
        const messages = params.messages as Array<{ role: string; content: unknown }>;
        const last = messages.at(-1)!;
        const blocks = Array.isArray(last.content) ? (last.content as Array<{ type: string; content?: unknown }>) : [];
        const resultBlocks = blocks.filter((b) => b.type === "tool_result");
        const sawImage = resultBlocks.some((b) => Array.isArray(b.content) && (b.content as Array<{ type: string }>).some((p) => p.type === "image"));
        const plan = brain({ prompt: textOf(messages[0].content), results: resultBlocks.map((b) => textOf(b.content)), sawImage });
        const events: unknown[] = [{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }];
        (plan.calls ?? []).forEach((call, index) => {
          events.push(
            { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${++n}`, name: call.name, input: {} } },
            { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } },
            { type: "content_block_stop", index },
          );
        });
        if (plan.text) {
          events.push(
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: plan.text } },
            { type: "content_block_stop", index: 0 },
          );
        }
        events.push({ type: "message_delta", delta: { stop_reason: plan.calls ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
        return scripted(events as never[]);
      },
    });
  };
}

function compatStream(model: ModelInfo, brain: Brain): ProbeStream {
  return ({ system, prompt, tools, signal }) => {
    let n = 0;
    return streamOpenAICompat(model, system, [{ role: "USER", content: prompt, attachments: [] }], 1_024, signal, undefined, false, tools, undefined, undefined, false, {
      async create(params) {
        const messages = params.messages as Array<{ role: string; content: unknown }>;
        const results = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
        const sawImage = messages.some((m) => m.role === "user" && Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image_url"));
        const userPrompt = textOf(messages.find((m) => m.role === "user")?.content);
        const plan = brain({ prompt: userPrompt, results, sawImage });
        const chunks: unknown[] = [];
        (plan.calls ?? []).forEach((call, index) => {
          chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${++n}`, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
        });
        if (plan.text) chunks.push({ choices: [{ index: 0, delta: { content: plan.text } }] });
        chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: plan.calls ? "tool_calls" : "stop" }] });
        return scripted(chunks as never[]);
      },
    });
  };
}

function responsesStream(model: ModelInfo, brain: Brain): ProbeStream {
  return ({ system, prompt, tools, signal }) => {
    let n = 0;
    return streamOpenAIResponses(model, system, [{ role: "USER", content: prompt, attachments: [] }], 1_024, signal, undefined, false, tools, undefined, undefined, false, false, {
      async create(params) {
        const input = params.input as Array<{ type?: string; role?: string; output?: string; content?: unknown }>;
        const results = input.filter((i) => i.type === "function_call_output").map((i) => String(i.output));
        const sawImage = input.some((i) => i.role === "user" && Array.isArray(i.content) && (i.content as Array<{ type: string }>).some((p) => p.type === "input_image"));
        const userPrompt = textOf(input.find((i) => i.role === "user")?.content);
        const plan = brain({ prompt: userPrompt, results, sawImage });
        const events: unknown[] = (plan.calls ?? []).map((call) => ({
          type: "response.output_item.done",
          item: { type: "function_call", call_id: `call_${++n}`, name: call.name, arguments: JSON.stringify(call.args) },
        }));
        if (plan.text) events.push({ type: "response.output_text.delta", delta: plan.text });
        events.push({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 5 } } });
        return scripted(events as never[]);
      },
    });
  };
}

function geminiStream(model: ModelInfo, brain: Brain): ProbeStream {
  return ({ system, prompt, tools, signal }) =>
    streamGemini(model, system, [{ role: "USER", content: prompt, attachments: [] }], 1_024, signal, undefined, false, tools, undefined, undefined, {
      async request({ body }) {
        const contents = (body as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }).contents;
        const responses = contents.flatMap((c) => c.parts.filter((p) => "functionResponse" in p).map((p) => p.functionResponse as { response: { result?: string } }));
        const sawImage = contents.some((c) => c.role === "user" && c.parts.some((p) => "inlineData" in p));
        const userPrompt = String(contents.find((c) => c.role === "user")?.parts.find((p) => typeof p.text === "string")?.text ?? "");
        const plan = brain({ prompt: userPrompt, results: responses.map((r) => String(r.response.result ?? "")), sawImage });
        const parts = plan.calls ? plan.calls.map((call) => ({ functionCall: { name: call.name, args: call.args } })) : [{ text: plan.text ?? "" }];
        return sseResponse([
          { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 } },
        ]);
      },
    });
}

const FAMILIES: Array<{ family: string; modelId: string; stream: (model: ModelInfo, brain: Brain) => ProbeStream }> = [
  { family: "anthropic-native", modelId: "claude-sonnet-5", stream: anthropicStream },
  { family: "openai-compatible", modelId: "kimi-k3", stream: compatStream },
  { family: "openai-responses", modelId: "gpt-5.5-pro", stream: responsesStream },
  { family: "gemini-native", modelId: "gemini-3.8-flash", stream: geminiStream },
];

for (const { family, modelId, stream } of FAMILIES) {
  test(`${family}: a model that calls, receives and states the result is verified, with parallel and image evidence`, async () => {
    const model = getModel(modelId)!;
    assert.equal(providerAdapterFor(model), family);
    const now = new Date("2026-10-02T12:00:00Z");
    const { evidence, answered } = await runToolProbe({ stream: stream(model, competent), adapter: family, vision: model.vision, now });
    assert.equal(answered, true);
    assert.equal(evidence.verdict, "verified", evidence.detail);
    assert.deepEqual(evidence.checks, { roundTrip: "passed", parallel: "passed", toolImage: model.vision ? "passed" : "skipped" });
    assert.equal(evidence.probeVersion, TOOL_PROBE_VERSION);
    assert.equal(evidence.adapter, family);
    assert.equal(toolCallingVerdict({ tools: evidence }, now), "verified");
  });

  test(`${family}: a model that answers without calling the tool is not verified`, async () => {
    const model = getModel(modelId)!;
    const { evidence } = await runToolProbe({ stream: stream(model, neverCalls), adapter: family, vision: false });
    assert.equal(evidence.verdict, "failed");
    assert.equal(evidence.failureKind, "model");
    assert.match(evidence.detail ?? "", /did not call the tool/);
  });

  test(`${family}: a model whose arguments do not fit the schema is not verified, and the tool never ran`, async () => {
    const model = getModel(modelId)!;
    const { evidence } = await runToolProbe({ stream: stream(model, badArgs), adapter: family, vision: false });
    assert.equal(evidence.verdict, "failed");
    assert.match(evidence.detail ?? "", /not valid/);
  });
}

test("a provider that never answers is transport-class: not stored as a verdict, model stays untested", async () => {
  const failing: ProbeStream = () =>
    (async function* (): AsyncGenerator<LlmEvent> {
      throw Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
    })();
  const { evidence, answered } = await runToolProbe({ stream: failing, adapter: "anthropic-native", vision: false });
  assert.equal(answered, false);
  assert.equal(evidence.failureKind, "transport");
  assert.equal(toolCallingVerdict({ tools: evidence }), "untested");
});

test("missing, stale, transport-class or older-version evidence reads as untested", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const fresh: ToolProbeEvidence = {
    probeVersion: TOOL_PROBE_VERSION,
    verdict: "verified",
    checkedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOOL_PROBE_TTL_MS).toISOString(),
    adapter: "anthropic-native",
    checks: { roundTrip: "passed", parallel: "passed", toolImage: "skipped" },
  };
  assert.equal(toolCallingVerdict(null, now), "untested");
  assert.equal(toolCallingVerdict({}, now), "untested");
  // The transport probe's own catalog guess is not evidence.
  assert.equal(toolCallingVerdict({ catalogCapabilities: { tools: true } }, now), "untested");
  assert.equal(toolCallingVerdict({ tools: fresh }, now), "verified");
  assert.equal(toolCallingVerdict({ tools: { ...fresh, verdict: "failed" } }, now), "failed");
  assert.equal(toolCallingVerdict({ tools: { ...fresh, probeVersion: 1 } }, now), "untested");
  assert.equal(toolCallingVerdict({ tools: fresh }, new Date(now.getTime() + TOOL_PROBE_TTL_MS + 1)), "untested");
});

test("the swatch is a real PNG of one colour", () => {
  const png = solidPng(4, 4, [220, 20, 20]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 4);
});
