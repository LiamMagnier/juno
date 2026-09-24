import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseClientFeatures } from "@/lib/chat/client-features";
import type { ChatSkillApplication } from "@/lib/chat/skills";
import { MicroVMSandboxAdapter, resetSandboxEgressCache, sandboxEgressIsolated } from "@/lib/code-interpreter";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import { MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";
import { chatToolEntitlements, type EntitlementInput } from "@/lib/tools/entitlements";
import { JUNO_TOOL_IDS } from "@/lib/tools/registry";

/*
 * The §3.6 matrix, row by row, and the RC-2 sweep: every current chat model
 * that takes tools can reach the web when web is on and a keyed engine
 * exists, through its provider's search or Juno's, plus Juno's page reader.
 */

const sonnet = getModel("anthropic:claude-sonnet-5")!;
const gptMini = MODEL_LIST.find((m) => m.provider === "openai" && m.modality === "chat" && toolCapabilitiesFor(m).supported)!;
const deepseek = MODEL_LIST.find((m) => m.provider === "deepseek" && m.modality === "chat")!;

function input(overrides: Partial<EntitlementInput> = {}): EntitlementInput {
  return {
    plan: "PRO",
    private: false,
    lockdown: false,
    approvalPolicy: "ask_for_any_change",
    voice: false,
    regenerate: false,
    artifactEdit: false,
    researchActive: false,
    researchArmed: false,
    webToggle: true,
    features: parseClientFeatures(["timeline", "citations", "suggest_research", "research_background"]),
    workspace: {},
    skill: null,
    model: deepseek,
    hasFileAttachment: true,
    hasInspectable: true,
    sandboxConfigured: true,
    keyedSearchEngine: true,
    saved: { userMessageId: "m1", conversationKind: "chat" },
    taskTool: true,
    effort: "medium",
    ...overrides,
  };
}

function skill(tools: string[]): ChatSkillApplication {
  return {
    resolved: { tools, withheld: { tools: [], connectors: [], apps: [], domains: [] } },
  } as unknown as ChatSkillApplication;
}

test("entitlements keep server-only out of their static graph", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/tools/entitlements.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.doesNotMatch(source, /not implemented/);
});

test("a PRO turn on a compat model with web on carries everything, in registry order", () => {
  const plan = chatToolEntitlements(input({ model: { ...deepseek, vision: true, agenticTools: true } }));
  assert.deepEqual(plan.juno, [
    "web_search", "web_fetch", "read_document", "inspect_image", "run_code", "search_chats",
    "current_time", "calculate", "suggest_research", "start_task",
  ]);
  assert.deepEqual(plan.juno, JUNO_TOOL_IDS.filter((id) => plan.juno.includes(id)), "registry order");
  assert.equal(plan.nativeSearch, false);
  assert.equal(plan.connectors, true);
  assert.equal(plan.suggestResearch, true);
  assert.equal(plan.roundBudget, 10);
  assert.equal(plan.citationStyle, "numbered");
});

test("provider search replaces Juno's web_search; web_fetch stays (Juno's fetch everywhere)", () => {
  const plan = chatToolEntitlements(input({ model: sonnet }));
  assert.equal(plan.nativeSearch, true);
  assert.ok(!plan.juno.includes("web_search"));
  assert.ok(plan.juno.includes("web_fetch"));
  assert.equal(plan.citationStyle, "links", "numbered only with Juno's own search");
  // Hosted search rejected at minimal on the model that says so.
  const gpt5 = getModel("openai:gpt-5");
  if (gpt5) {
    const minimal = chatToolEntitlements(input({ model: gpt5, effort: "minimal" }));
    assert.equal(minimal.nativeSearch, false);
    assert.ok(minimal.juno.includes("web_search"), "Juno's search stands in");
  }
});

test("FREE: the readers, the pure tools and search_chats; no web, code, connectors, tasks or research", () => {
  const plan = chatToolEntitlements(input({ plan: "FREE", model: { ...deepseek, vision: true, agenticTools: true } }));
  assert.deepEqual(plan.juno, ["read_document", "inspect_image", "search_chats", "current_time", "calculate"]);
  assert.equal(plan.nativeSearch, false);
  assert.equal(plan.connectors, false);
  assert.equal(plan.suggestResearch, false);
  assert.equal(chatToolEntitlements(input({ plan: "FREE", model: sonnet })).nativeSearch, false);
});

test("private: the pure tools always; web only when toggled in that chat; nothing that persists", () => {
  const off = chatToolEntitlements(input({ private: true, webToggle: false, saved: null, connectorsRequested: true }));
  assert.deepEqual(off.juno, ["current_time", "calculate"]);
  assert.equal(off.connectors, false);
  assert.deepEqual(off.notices, ["private_tools_limited"]);
  const on = chatToolEntitlements(input({ private: true, webToggle: true, saved: null }));
  assert.deepEqual(on.juno, ["web_search", "web_fetch", "current_time", "calculate"]);
  assert.equal(chatToolEntitlements(input({ private: true, webToggle: true, saved: null, model: sonnet })).nativeSearch, true);
  assert.deepEqual(chatToolEntitlements(input({ private: true, webToggle: false, saved: null })).notices, []);
});

test("lockdown and the block policy leave only the pure tools, and stop provider search", () => {
  for (const overrides of [{ lockdown: true }, { approvalPolicy: "block" as const }]) {
    const plan = chatToolEntitlements(input({ ...overrides, model: sonnet }));
    assert.deepEqual(plan.juno, ["current_time", "calculate"]);
    assert.equal(plan.nativeSearch, false);
    assert.equal(plan.connectors, false);
    assert.equal(plan.suggestResearch, false);
  }
  assert.deepEqual(chatToolEntitlements(input({ lockdown: true })).notices, ["web_off_lockdown"]);
  assert.deepEqual(chatToolEntitlements(input({ lockdown: true, webToggle: false })).notices, []);
});

test("voice is unchanged: provider search and the readers as before, no new tools, the legacy budget", () => {
  const voice = chatToolEntitlements(input({ voice: true, model: { ...sonnet, agenticTools: true } }));
  assert.equal(voice.nativeSearch, true);
  assert.deepEqual(voice.juno, ["web_fetch", "read_document", "inspect_image"], "web_fetch only where browser_agent was (toggle and provider search)");
  assert.equal(voice.roundBudget, 7);
  const compatVoice = chatToolEntitlements(input({ voice: true, model: { ...deepseek, vision: true } }));
  assert.deepEqual(compatVoice.juno, ["read_document", "inspect_image"]);
});

test("workspace keys: webSearch, memoryRecall, deepResearch, connectors; code only unrestricted", () => {
  const model = { ...deepseek, vision: true, agenticTools: true };
  const none = chatToolEntitlements(input({ model, workspace: { allowedTools: [] } }));
  assert.deepEqual(none.juno, ["read_document", "inspect_image", "current_time", "calculate", "start_task"]);
  assert.equal(none.connectors, false);

  const web = chatToolEntitlements(input({ workspace: { allowedTools: ["webSearch", "memoryRecall", "deepResearch", "connectors"] } }));
  assert.ok(web.juno.includes("web_search") && web.juno.includes("web_fetch") && web.juno.includes("search_chats"));
  assert.ok(web.juno.includes("suggest_research"));
  assert.ok(!web.juno.includes("run_code"), "a workspace that restricts tools at all has no code");
  assert.equal(web.connectors, true);
});

test("a skill that lists tools narrows every row, provider search and the pure tools included", () => {
  const narrow = chatToolEntitlements(input({ model: sonnet, skill: skill(["read_document", "code_interpreter"]) }));
  assert.deepEqual(narrow.juno, ["read_document", "run_code"], "code_interpreter means run_code (INV-23)");
  assert.equal(narrow.nativeSearch, false);
  const web = chatToolEntitlements(input({ model: sonnet, skill: skill(["web_search", "browser_agent"]) }));
  assert.equal(web.nativeSearch, true);
  assert.deepEqual(web.juno, ["web_fetch"]);
  // A skill that lists nothing narrows nothing.
  assert.deepEqual(chatToolEntitlements(input({ skill: skill([]) })).juno, chatToolEntitlements(input()).juno);
});

test("clientFeatures gate client-surface tools (INV-10) and the citation style", () => {
  const profile1 = chatToolEntitlements(input({ features: parseClientFeatures(undefined) }));
  assert.ok(!profile1.juno.includes("suggest_research"));
  assert.equal(profile1.suggestResearch, false);
  assert.equal(profile1.citationStyle, "links", "native shows [n] literally outside research");
  const noCitations = chatToolEntitlements(input({ features: parseClientFeatures(["timeline", "suggest_research"]) }));
  assert.equal(noCitations.citationStyle, "links");
  assert.ok(noCitations.juno.includes("suggest_research"));
});

test("suggest_research needs web, entitlement, and research not already armed or running", () => {
  assert.ok(!chatToolEntitlements(input({ researchArmed: true })).juno.includes("suggest_research"));
  assert.ok(!chatToolEntitlements(input({ webToggle: false })).juno.includes("suggest_research"));
  assert.ok(!chatToolEntitlements(input({ researchEntitled: false })).juno.includes("suggest_research"));
  const active = chatToolEntitlements(input({ researchActive: true, model: sonnet }));
  assert.ok(!active.juno.includes("suggest_research"));
  assert.equal(active.nativeSearch, false, "an in-chat research run supplies its own corpus, as today");
});

test("run_code needs a sandbox confirmed isolated, a paid plan, and not voice", () => {
  assert.ok(chatToolEntitlements(input()).juno.includes("run_code"));
  assert.ok(!chatToolEntitlements(input({ sandboxConfigured: false })).juno.includes("run_code"));
  assert.ok(!chatToolEntitlements(input({ plan: "FREE" })).juno.includes("run_code"));
  assert.ok(!chatToolEntitlements(input({ hasFileAttachment: false })).juno.includes("read_document"));
  assert.ok(chatToolEntitlements(input({ hasFileAttachment: false })).juno.includes("run_code"), "no attachment needed");
});

test("sandboxConfigured means egress isolation is confirmed, never assumed", async () => {
  const saved = { egress: process.env.CODE_INTERPRETER_EGRESS };
  try {
    delete process.env.CODE_INTERPRETER_EGRESS;
    resetSandboxEgressCache();
    assert.equal(await sandboxEgressIsolated({ endpoint: null, token: null }), false, "no sandbox, no isolation");
    const health = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as typeof fetch;
    assert.equal(await sandboxEgressIsolated({ endpoint: "https://sb.example", token: "t", fetch: health({ egress: "none" }) }), true);
    resetSandboxEgressCache();
    assert.equal(await sandboxEgressIsolated({ endpoint: "https://sb.example", token: "t", fetch: health({ egress: "open" }) }), false);
    resetSandboxEgressCache();
    assert.equal(await sandboxEgressIsolated({ endpoint: "https://sb.example", token: "t", fetch: health({}, false) }), false);
    resetSandboxEgressCache();
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    assert.equal(await sandboxEgressIsolated({ endpoint: "https://sb.example", token: "t", fetch: failing }), false, "a failed probe is false");

    // Cached for ten minutes per process: one probe, not one per turn.
    resetSandboxEgressCache();
    let probes = 0;
    const counting = (async () => {
      probes += 1;
      return new Response(JSON.stringify({ egress: "none" }));
    }) as typeof fetch;
    let now = 1_000_000;
    await sandboxEgressIsolated({ endpoint: "https://sb.example", token: "t", fetch: counting, now: () => now });
    await sandboxEgressIsolated({ endpoint: "https://sb.example", token: "t", fetch: counting, now: () => now });
    now += 10 * 60_000;
    await sandboxEgressIsolated({ endpoint: "https://sb.example", token: "t", fetch: counting, now: () => now });
    assert.equal(probes, 2);

    // The deployer can state it.
    resetSandboxEgressCache();
    process.env.CODE_INTERPRETER_EGRESS = "none";
    assert.equal(await sandboxEgressIsolated({ endpoint: null, token: null }), true);
  } finally {
    if (saved.egress === undefined) delete process.env.CODE_INTERPRETER_EGRESS;
    else process.env.CODE_INTERPRETER_EGRESS = saved.egress;
    resetSandboxEgressCache();
  }
});

test("the sandbox is always asked for no network, and a stopped turn stops the run", async () => {
  const original = globalThis.fetch;
  let payload: Record<string, unknown> | null = null;
  let signal: AbortSignal | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    signal = init.signal ?? null;
    return new Response(JSON.stringify({ success: true, stdout: "1", exitCode: 0, durationMs: 5 }));
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const adapter = new MicroVMSandboxAdapter("https://sb.example", "t");
    await adapter.execute({ code: "print(1)", language: "python", signal: controller.signal } as Parameters<MicroVMSandboxAdapter["execute"]>[0]);
    assert.equal(payload!.network, "none");
    assert.ok(signal, "the request carries a signal");
    controller.abort();
    assert.equal((signal as AbortSignal | null)?.aborted, true, "the chat's Stop reaches the runner request");
  } finally {
    globalThis.fetch = original;
  }
});

test("RC-2 sweep: every current tools-capable chat model can reach the web with a keyed engine", () => {
  const current = MODEL_LIST.filter((m) => m.modality === "chat" && m.status === "current" && !m.comingSoon);
  assert.ok(current.length > 10);
  for (const model of current) {
    const caps = toolCapabilitiesFor(model);
    const plan = chatToolEntitlements(input({ model: model as ModelInfo }));
    if (!caps.supported) {
      assert.deepEqual(plan.juno, [], `${model.id} takes no function tools`);
      continue;
    }
    assert.ok(plan.nativeSearch || plan.juno.includes("web_search"), `${model.id} cannot search`);
    assert.ok(plan.juno.includes("web_fetch"), `${model.id} cannot read a page`);
    assert.ok(plan.juno.includes("current_time") && plan.juno.includes("calculate"), model.id);
  }
});

test("pre-Gemini-3 models keep their function tools and get Juno's web tools", () => {
  const legacy = MODEL_LIST.find((m) => m.provider === "google" && /gemini-2/.test(m.id) && m.modality === "chat");
  assert.ok(legacy, "a pre-3 Gemini is still in the catalog");
  const plan = chatToolEntitlements(input({ model: legacy }));
  assert.equal(plan.nativeSearch, false);
  assert.ok(plan.juno.includes("web_search") && plan.juno.includes("web_fetch"));
});

test("no keyed engine: models without provider search get no web_search, but keep web_fetch", () => {
  const plan = chatToolEntitlements(input({ keyedSearchEngine: false }));
  assert.ok(!plan.juno.includes("web_search"));
  assert.ok(plan.juno.includes("web_fetch"));
});

test("an artifact edit carries no tools; a regenerate carries the same plan but start_task", () => {
  const edit = chatToolEntitlements(input({ artifactEdit: true, model: sonnet }));
  assert.deepEqual([edit.juno, edit.nativeSearch, edit.connectors], [[], false, false]);
  const model = { ...deepseek, agenticTools: true };
  const fresh = chatToolEntitlements(input({ model }));
  const regen = chatToolEntitlements(input({ model, regenerate: true }));
  assert.deepEqual(regen.juno, fresh.juno.filter((id) => id !== "start_task"));
  assert.ok(fresh.juno.includes("start_task"));
  assert.ok(!chatToolEntitlements(input({ model, taskTool: false })).juno.includes("start_task"));
  assert.ok(!chatToolEntitlements(input({ model: { ...deepseek, agenticTools: false } })).juno.includes("start_task"));
});

test("the round budget follows the effort (DECISIONS §4b)", () => {
  assert.equal(chatToolEntitlements(input({ effort: "low" })).roundBudget, 4);
  assert.equal(chatToolEntitlements(input({ effort: null })).roundBudget, 10);
  assert.equal(chatToolEntitlements(input({ effort: "high" })).roundBudget, 16);
  assert.equal(chatToolEntitlements(input({ effort: "max" })).roundBudget, 24);
  assert.ok(gptMini, "an OpenAI chat model exists for the sweep");
});
