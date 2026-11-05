import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { getModelMetrics } from "@/lib/model-metrics";
import { routeAuto, type RouteDecision, type RouteInput } from "@/lib/router/decide";
import { autoDataUseVerdict } from "@/lib/router/data-policy";
import { parseRoutingReceipt, receiptFromDecision, receiptSummary } from "@/lib/router/receipt";
import type { TaskClass } from "@/lib/router/task-class";
import { webSearchPossible } from "@/lib/search/alevr/policy";

/*
 * Auto on representative prompts (master brief Part 4.2): what a real reader
 * types, in the locales Juno serves, each with the request facts the chat
 * route would pass. Every case asserts the task class and complexity the
 * router acted on, the property of the pick that the request demands (vision,
 * search, the image tool, a context window, a cheap fast model for small
 * talk, more thinking for hard work), and that the stored receipt is
 * truthful: its factors are the decision's own facts, it round-trips through
 * storage, and its plain-language reason is present and short.
 *
 * Properties, not model ids: the catalogue's metrics move with every model
 * sync, and a test that pinned "gpt-6-luna" would fail for the wrong reason.
 */

const byId = (id: string): ModelInfo => {
  const m = MODEL_LIST.find((x) => x.id === id);
  assert.ok(m, `catalogue has ${id}`);
  return m;
};

/** A fixed, mixed field: three labs' tiers, two attested paid-tier labs, and one never-eligible lab. */
const POOL: ModelInfo[] = [
  "openai:gpt-6-luna",
  "openai:gpt-6.1-sol",
  "openai:gpt-6-astra",
  "anthropic:claude-haiku-5-5",
  "anthropic:claude-sonnet-5-5",
  "anthropic:claude-opus-5-5",
  "google:gemini-3.5-flash-lite",
  "google:gemini-3.8-flash",
  "xai:grok-4.7",
  "qwen:qwen3.8-flash",
  "mistral:mistral-small-latest",
  "deepseek:deepseek-flash",
].map(byId);

const PAID = new Set(["google", "mistral"]);

function route(message: string, extra: Partial<RouteInput> = {}): RouteDecision {
  return routeAuto({ message, plan: "PRO", catalogue: POOL, isConfigured: () => true, paidTier: PAID, ...extra });
}

const LEVEL = { simple: 0, medium: 1, hard: 2, expert: 3 } as const;
type Level = keyof typeof LEVEL;

interface Case {
  name: string;
  prompt: string;
  extra?: Partial<RouteInput>;
  taskClass: TaskClass;
  /** Inclusive bounds on the complexity the router acted on. */
  level: [Level, Level];
  /** What the request demands of the pick. */
  check?: (d: RouteDecision) => void;
}

const cheapAndQuick = (d: RouteDecision) => {
  assert.equal(d.model.cost, 1, `small talk goes to a cost-1 model, got ${d.model.id}`);
  assert.ok(d.reasoningEffort === null || d.reasoningEffort === "minimal" || d.reasoningEffort === "low", `effort ${d.reasoningEffort}`);
  assert.equal(d.factors.cost.tier, "low");
};
const thinksHard = (d: RouteDecision) => {
  assert.ok(d.model.reasoning, `${d.model.id} reasons`);
  assert.ok(["medium", "high", "xhigh", "max"].includes(d.reasoningEffort ?? ""), `effort ${d.reasoningEffort}`);
  // The pick is at least as likely to succeed as the cheapest call in the field.
  const cheapest = [...d.ranked].sort((a, b) => a.callMicroUsd - b.callMicroUsd)[0];
  assert.ok(d.ranked[0].pSuccess >= cheapest.pSuccess, `${d.ranked[0].pSuccess} < ${cheapest.pSuccess}`);
};
const sees = (d: RouteDecision) => {
  assert.ok(d.model.vision, `${d.model.id} must read images`);
  assert.equal(d.factors.modality.input, "text_image");
};
const searches = (d: RouteDecision) => {
  assert.ok(webSearchPossible(d.model, false), `${d.model.id} must search`);
  assert.equal(d.factors.tools.webSearch, true);
};

const HARD_CODING =
  "Refactor this repository's auth module across multiple files to use a distributed session store, handle race conditions, and prove it correct step by step.";
const EXPERT_REASONING = [
  "Prove rigorously, step by step, that every finite integral domain is a field.",
  "Then explain why the argument fails for infinite domains, give a counterexample, and discuss the edge cases:",
  "- the zero ring",
  "- domains of positive characteristic",
  "- what changes if commutativity is dropped (Wedderburn's little theorem)",
  "Compare the trade-offs between the counting proof and the minimal-polynomial proof, and say which generalises further and why.",
].join("\n");

const CASES: Case[] = [
  // Everyday — the cheapest fast answer is the right one.
  { name: "small talk", prompt: "hey, what's 2+2?", taskClass: "everyday", level: ["simple", "simple"], check: cheapAndQuick },
  { name: "quick fact", prompt: "What's the capital of Portugal?", taskClass: "everyday", level: ["simple", "simple"], check: cheapAndQuick },
  { name: "French small talk", prompt: "Salut, tu peux me donner une idée de dîner rapide ?", taskClass: "everyday", level: ["simple", "simple"], check: cheapAndQuick },

  // Writing.
  { name: "short email", prompt: "Write a warm thank-you email to my landlord for fixing the boiler so quickly.", taskClass: "writing", level: ["simple", "medium"] },
  { name: "French email", prompt: "Rédige un e-mail de remerciement à mon propriétaire pour la réparation de la chaudière.", taskClass: "writing", level: ["simple", "medium"] },
  { name: "German message", prompt: "Schreibe eine kurze Geburtstagsnachricht für meine Kollegin Anna.", taskClass: "writing", level: ["simple", "medium"] },

  // Coding — hard work buys thinking and odds.
  { name: "repository refactor", prompt: HARD_CODING, taskClass: "coding", level: ["hard", "expert"], check: thinksHard },
  {
    name: "Chinese race condition",
    prompt: "这个函数为什么会出现竞态条件？请一步一步分析并给出修复方案。",
    taskClass: "coding",
    level: ["hard", "expert"],
    check: thinksHard,
  },
  { name: "French bug fix", prompt: "Refactorise cette fonction Python et corrige le bug", taskClass: "coding", level: ["medium", "hard"] },
  {
    name: "small code question",
    prompt: "What does this regex match? `^\\d{3}-\\d{4}$`",
    taskClass: "coding",
    level: ["simple", "medium"],
  },

  // Research.
  {
    name: "news with web search",
    prompt: "What changed in the EU AI Act implementation this week? Cite sources.",
    extra: { wantsWebSearch: true },
    taskClass: "research",
    level: ["simple", "hard"],
    check: searches,
  },
  {
    name: "research with Alevr Search tools",
    prompt: "Find the latest statistics on EV adoption in Norway and cite them.",
    extra: { wantsWebSearch: true, alevrSearch: true },
    taskClass: "research",
    level: ["simple", "hard"],
    check: (d) => assert.ok(webSearchPossible(d.model, true)),
  },

  // Vision.
  { name: "describe a photo", prompt: "what is in this picture", extra: { hasImages: true }, taskClass: "vision", level: ["simple", "simple"], check: sees },
  {
    name: "screenshot bug",
    prompt: "Why does this code in the screenshot throw an exception?",
    extra: { hasImages: true },
    taskClass: "coding",
    level: ["simple", "hard"],
    check: sees,
  },

  // Long context: only models with room for it.
  {
    name: "long thread summary",
    prompt: "summarise this thread",
    extra: { contextTokens: 300_000 },
    taskClass: "long_context",
    level: ["medium", "expert"],
    check: (d) => {
      const ctx = d.model.contextWindow ?? getModelMetrics(d.model).contextTokens;
      assert.ok(ctx >= d.profile.estInputTokens * 1.1, `${d.model.id} window ${ctx}`);
      assert.ok(d.factors.contextTokens >= 300_000);
    },
  },

  // Agentic: tool reliability is a need, and the stakes raise the level.
  {
    name: "send an email",
    prompt: "send an email to Sam on my behalf about Friday's meeting",
    extra: { toolsOffered: 2 },
    taskClass: "agentic",
    level: ["medium", "expert"],
    check: (d) => {
      assert.ok(d.model.agenticTools);
      assert.equal(d.factors.tools.reliable, true);
      assert.equal(d.factors.tools.connectors, 2);
    },
  },

  // Structured output.
  { name: "JSON schema", prompt: "Return a JSON schema for a user profile with name, email and roles.", taskClass: "structured_output", level: ["simple", "medium"] },

  // Image generation: the answer is a tool call.
  {
    name: "make a picture",
    prompt: "draw me a watercolor fox in the snow",
    extra: { wantsImage: true },
    taskClass: "everyday",
    level: ["simple", "simple"],
    check: (d) => {
      assert.ok(d.model.agenticTools, "the image tool needs a tool-calling model");
      assert.equal(d.factors.modality.output, "image");
      assert.equal(d.factors.tools.imageGeneration, true);
    },
  },

  // Reasoning.
  {
    name: "distributed systems trade-offs",
    prompt: "Explain the trade-offs between Raft and Paxos step by step, including edge cases.",
    taskClass: "reasoning",
    level: ["medium", "expert"],
    check: (d) => assert.ok(d.model.reasoning),
  },
  { name: "expert proof", prompt: EXPERT_REASONING, taskClass: "reasoning", level: ["hard", "expert"], check: thinksHard },
];

describe("Auto on representative prompts", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const d = route(c.prompt, c.extra);
      assert.equal(d.profile.taskClass, c.taskClass, `task class for "${c.prompt.slice(0, 60)}"`);
      const level = LEVEL[d.profile.complexity];
      assert.ok(
        level >= LEVEL[c.level[0]] && level <= LEVEL[c.level[1]],
        `complexity ${d.profile.complexity} outside ${c.level.join("–")}`
      );
      // Never a model the data-use policy refuses.
      assert.equal(autoDataUseVerdict(d.model, { paidTier: PAID }).eligible, true, d.model.id);
      assert.notEqual(d.model.provider, "deepseek");
      c.check?.(d);

      // The receipt is the decision's own record.
      const receipt = receiptFromDecision(d);
      const f = receipt.factors;
      assert.ok(f, "every routed answer carries factors");
      assert.equal(f.selected, d.model.id);
      assert.equal(receipt.taskClass, d.profile.taskClass);
      assert.equal(f.complexity, d.profile.complexity);
      assert.equal(f.plan, "PRO");
      assert.equal(f.candidates, d.ranked.length);
      assert.equal(f.contextTokens, d.profile.estInputTokens);
      assert.equal(f.pSuccess, d.ranked[0].pSuccess);
      assert.equal(f.latency.expectedS, d.ranked[0].expectedLatencyS);
      assert.deepEqual(parseRoutingReceipt(JSON.parse(JSON.stringify(receipt))), { ...receipt, rerouted: null });

      // And it can say why, briefly, without numbers it should not show.
      const summary = receiptSummary(receipt);
      assert.ok(summary && summary.length > 20 && summary.length <= 200, String(summary));
      assert.ok(!/\$|%|µ|pSuccess|score/i.test(summary), summary);
    });
  }

  test("the field is wide enough to mean something", () => {
    const d = route("hey, what's 2+2?");
    assert.ok(d.ranked.length >= 8, `${d.ranked.length} candidates`);
  });

  test("hard prompts get more thinking than small talk on the same field", () => {
    const easy = route("hey, what's 2+2?");
    const hard = route(HARD_CODING);
    const rank = (e: string | null) => ["minimal", "low", "medium", "high", "xhigh", "max"].indexOf(e ?? "") + 1;
    assert.ok(rank(hard.reasoningEffort) > rank(easy.reasoningEffort));
    assert.ok(hard.factors.cost.expectedMicroUsd > easy.factors.cost.expectedMicroUsd);
    assert.equal(hard.factors.choice, "better_odds");
  });
});
