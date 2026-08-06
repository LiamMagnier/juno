import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { MODEL_LIST } from "@/lib/models";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { workModelOptions } from "@/lib/work/models";

import {
  createProviderFromSpec,
  type ProviderSpec,
} from "../runner/agent-core/src/providers/registry.js";
import { OpenAICompatAdapter } from "../runner/agent-core/src/providers/openai-compat.js";
import { anthropicThinkingBits } from "../runner/agent-core/src/providers/thinking.js";
import { ProviderSilenceError, runAgentLoop } from "../runner/agent-core/src/loop.js";
import { WorkAgentSession } from "../runner/agent-core/src/work/session.js";
import { WorkPlan } from "../runner/agent-core/src/work/plan.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
} from "../runner/agent-core/src/providers/types.js";

/*
 * Three failures a user watched on chat.liams.dev, and the properties that stop
 * them coming back.
 *
 * 1. The picker offered fourteen labs and the executor could reach three. Every
 *    other choice threw `Unknown provider: <id>` while building the adapter, so
 *    a model the composer showed was a run that died before its first token.
 *    Mistral is the one that was reported; twelve behaved identically.
 *
 * 2. A run sat at `running`, zero tokens, empty transcript, for as long as
 *    anybody watched. The provider had accepted the request and sent nothing,
 *    and nothing in the executor was counting: the budget guard is consulted
 *    when a request comes back, and that request never came back.
 *
 * 3. The thinking control in the composer wrote a column nothing read.
 *
 * What is under test is deliberately the seam rather than the script.
 * scripts/work-runner.ts is a worker with a `void main()` at the bottom;
 * importing it would start a poll loop against a database. The properties that
 * actually broke live either side of it — in the catalogs it reads and in the
 * runtime it hands them to — and both are importable.
 */

// ---------------------------------------------------------------------------
// 1. The picker and the executor
// ---------------------------------------------------------------------------

/**
 * The executor's own spec builder, in the shape scripts/work-runner.ts builds
 * it. A copy of the mapping and not of the decision: what is asserted below is
 * that the *catalog* can be turned into a spec for every model the picker
 * offers, which is the property the runner depends on rather than the code path
 * it takes to get there.
 */
function specFrom(provider: Provider): ProviderSpec {
  const def = PROVIDERS[provider];
  const models = workModelOptions(MODEL_LIST, { providers: null }).filter(
    (model) => model.provider === provider
  );
  return {
    id: provider,
    name: def.label,
    kind: def.kind,
    apiKey: "test-key-not-a-real-credential",
    ...(def.defaultBaseUrl ? { baseUrl: def.defaultBaseUrl } : {}),
    defaultModel: models[0]?.providerModel ?? "",
    models: Object.fromEntries(
      models.map((model) => [
        model.providerModel,
        {
          label: model.name,
          capabilities: {
            tools: true,
            vision: model.vision,
            computerUse: false,
            reasoningLevels: model.reasoning ? ["low", "high"] : [],
            maxContext: model.contextWindow ?? 200_000,
            streaming: true,
            mcp: false,
          },
        },
      ])
    ),
  };
}

test("every provider the Work picker can offer is one the executor can build", () => {
  const offered = new Set(
    workModelOptions(MODEL_LIST, { providers: null }).map((model) => model.provider)
  );
  // The catalog is the picker's source and it is not empty, or the assertion
  // below would pass by having nothing to check.
  assert.ok(offered.size >= 10, `only ${offered.size} providers offer a Work-capable model`);

  for (const provider of offered) {
    const adapter = createProviderFromSpec(specFrom(provider));
    assert.equal(adapter.id, provider);
  }
});

test("every model the Work picker offers is a model its adapter carries", () => {
  for (const model of workModelOptions(MODEL_LIST, { providers: null })) {
    const adapter = createProviderFromSpec(specFrom(model.provider));
    assert.ok(
      adapter.models().includes(model.providerModel),
      `${model.id} is offered by the picker and absent from the ${model.provider} adapter`
    );
    // Capabilities have to come from the catalog rather than from a fallback:
    // a surface that greys out vision on a model that has it is answering a
    // question it did not actually ask anyone.
    assert.equal(adapter.capabilities(model.providerModel).vision, model.vision);
  }
});

test("a provider with no key is refused in words, not with a stack trace", () => {
  const spec = { ...specFrom("mistral"), apiKey: "" };
  assert.throws(
    () => createProviderFromSpec(spec),
    /Mistral has no API key configured/,
    "an unconfigured provider must name itself"
  );
});

test("every lab in the catalog declares a kind the runtime has an adapter for", () => {
  // The catalog is where a fifteenth lab will be added, and the runtime has two
  // adapters. A `kind` outside those two would reach `createProviderFromSpec`
  // and be a run that cannot start, which is the original bug wearing a hat.
  for (const provider of PROVIDER_LIST) {
    assert.ok(
      PROVIDERS[provider].kind === "anthropic" || PROVIDERS[provider].kind === "openai",
      `${provider} declares a kind the agent runtime cannot drive`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. A provider that stops talking
// ---------------------------------------------------------------------------

/** An adapter that accepts the request and then says nothing, for ever. */
function silentProvider(onAbort?: () => void): ProviderAdapter {
  return {
    id: "silent",
    name: "Silent",
    defaultModel: "silent-1",
    models: () => ["silent-1"],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: 1000,
      streaming: true,
      mcp: false,
    }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener("abort", () => {
          onAbort?.();
          resolve();
        });
      });
      // The real SDKs throw on abort rather than ending the iteration, and the
      // loop has to handle the throwing shape: that is the one it sees in
      // production.
      throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    },
  };
}

test("a stream that says nothing is abandoned, with a sentence a person can read", async () => {
  const started = Date.now();
  let aborted = false;
  await assert.rejects(
    runAgentLoop({
      provider: silentProvider(() => {
        aborted = true;
      }),
      model: "silent-1",
      system: "s",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      maxSteps: 5,
      silenceTimeoutMs: 200,
      executeToolCall: async () => ({
        type: "tool_result",
        toolCallId: "x",
        content: "",
        isError: false,
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSilenceError);
      // The message goes into the transcript verbatim, so it has to say what
      // happened and what it cost — the two things the user was owed while
      // watching a run at zero tokens.
      assert.match(error.message, /sent nothing for 0s|sent nothing for \d+s/);
      assert.match(error.message, /Nothing was charged/);
      return true;
    }
  );
  // The request is actually cancelled rather than left running: an abandoned
  // turn that keeps its socket is a turn that can still be billed.
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 5_000, "the deadline did not fire promptly");
});

test("a run whose first turn never returns still ends, and says which ceiling stopped it", async () => {
  const session = new WorkAgentSession({
    runId: "run-stalled",
    goal: "Do the thing.",
    provider: silentProvider(),
    model: "silent-1",
    cwd: process.cwd(),
    tools: [],
    plan: new WorkPlan([{ id: "one", title: "One" }]),
    // The runtime ceiling is the one that could never fire while a request was
    // outstanding, because it was only ever consulted after a request came
    // back. Set below the silence deadline so it is unambiguously the thing
    // being tested.
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 150 },
    providerSilenceMs: 60_000,
    budgetCheckIntervalMs: 25,
    callbacks: {
      onEvent: () => {},
      askQuestion: async () => "",
      requestApproval: async () => "denied",
    },
  });

  const result = await session.run();
  assert.equal(result.state, "finished");
  if (result.state !== "finished") return;
  assert.equal(result.terminalReason, "timed_out");
  assert.match(result.detail, /ceiling/);
});

// ---------------------------------------------------------------------------
// 3. The thinking tier
// ---------------------------------------------------------------------------

/** Runs one request against a local stand-in and hands back the body it saw. */
async function capturedRequest(
  build: (baseUrl: string) => ProviderAdapter,
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
): Promise<Record<string, unknown>> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const adapter = build(`http://127.0.0.1:${port}/v1`);
    for await (const _ of adapter.stream({
      model: "m",
      system: "s",
      messages: [],
      tools: [],
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })) {
      // Drained rather than ignored: the generator only issues the request when
      // something pulls on it.
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
}

test("a lab that speaks reasoning_effort is sent the tier the user chose", async () => {
  const body = await capturedRequest(
    (baseUrl) =>
      new OpenAICompatAdapter(
        {
          id: "openai",
          name: "OpenAI",
          baseUrl,
          envVar: "",
          defaultModel: "m",
          models: {},
          reasoningEffortParam: true,
        },
        { apiKey: "k" }
      ),
    "xhigh"
  );
  // Verbatim, not clamped. Which tiers a model accepts is per-model knowledge
  // held by the caller (clampReasoningEffort in src/lib/model-metrics.ts); a
  // second clamp here could only disagree with it, and did.
  assert.equal(body.reasoning_effort, "xhigh");
});

test("a lab with no such parameter ignores the tier rather than failing on it", async () => {
  // Mistral's Medium/Small take `[high, none]` and nothing else: sending
  // `medium` answered `400 status code (no body)` and killed the run before its
  // first token. A tier a lab cannot receive has to be dropped, because the
  // alternative is a preference that costs the user the whole task.
  const body = await capturedRequest(
    (baseUrl) =>
      new OpenAICompatAdapter(
        { id: "mistral", name: "Mistral", baseUrl, envVar: "", defaultModel: "m", models: {} },
        { apiKey: "k" }
      ),
    "medium"
  );
  assert.equal("reasoning_effort" in body, false);
});

test("Anthropic gets the thinking shape its model generation accepts", () => {
  // `type:'enabled'` is a hard 400 on the adaptive-era models and `adaptive` is
  // a hard 400 on the older ones, so the two branches are not a preference.
  const adaptive = anthropicThinkingBits("claude-sonnet-5", 8192, "high");
  assert.equal(adaptive.thinking?.type, "adaptive");
  assert.equal(adaptive.outputConfig?.effort, "high");
  assert.ok(adaptive.maxTokens > 8192, "adaptive thinking needs headroom above the answer");

  const manual = anthropicThinkingBits("claude-haiku-4-5", 8192, "high");
  assert.equal(manual.thinking?.type, "enabled");
  assert.ok(
    manual.thinking?.type === "enabled" && manual.thinking.budget_tokens >= 1024,
    "Anthropic rejects a budget under 1024"
  );
  assert.ok(
    manual.thinking?.type === "enabled" && manual.thinking.budget_tokens < manual.maxTokens,
    "the budget must leave room for an answer"
  );

  // Anthropic has no `minimal`, so the bottom tier maps rather than being sent.
  assert.equal(anthropicThinkingBits("claude-opus-4-8", 8192, "minimal").outputConfig?.effort, "low");

  // Instant is a choice: Sonnet 5 thinks by default, so it has to be told not to.
  assert.equal(anthropicThinkingBits("claude-sonnet-5", 8192).thinking?.type, "disabled");
  // And Fable cannot be told not to, so nothing pretends otherwise.
  assert.equal(anthropicThinkingBits("claude-fable-5", 8192).thinking?.type, "adaptive");
});
