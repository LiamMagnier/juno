/**
 * The live provider probes of SPEC §5.7, from gap-provider-tool-capabilities
 * §5. Each answers one question the capability record
 * (`src/lib/model-tools.ts`) keeps a conservative value for until it runs;
 * the "Decides" line says which value to revisit with the answer.
 *
 * Minimal requests, a few hundred tokens each, read-only against the provider.
 */

import {
  chatTool,
  chatToolHistory,
  getOpenAIShaped,
  postAnthropic,
  postGemini,
  postOpenAIShaped,
  type ProbeResult,
} from "./wire";

export interface Probe {
  id: string;
  question: string;
  /** What the answer changes. */
  decides: string;
  run(): Promise<ProbeResult[]>;
}

const GEMINI = "gemini-3.8-flash";

export const PROBES: Probe[] = [
  {
    id: "P1",
    question: "Which JSON-Schema keywords does Gemini accept in parameters vs parametersJsonSchema?",
    decides: "widening sanitizeForGeminiJsonSchema's allowlist (src/lib/tools/schema.ts)",
    async run() {
      const schemas: Record<string, Record<string, unknown>> = {
        const: { type: "object", $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false, properties: { q: { type: "string", const: "x" } }, required: ["q"] },
        oneOf: { type: "object", properties: { q: { oneOf: [{ type: "string" }, { type: "number" }] } } },
        defs: { type: "object", $defs: { Q: { type: "string" } }, properties: { q: { $ref: "#/$defs/Q" } } },
      };
      const out: ProbeResult[] = [];
      for (const [variant, schema] of Object.entries(schemas)) {
        for (const field of ["parameters", "parametersJsonSchema"]) {
          out.push(
            await postGemini(`${variant} in ${field}`, "gemini-3.5-flash-lite", {
              contents: [{ role: "user", parts: [{ text: "call f with q=x" }] }],
              tools: [{ functionDeclarations: [{ name: "f", description: "test", [field]: schema }] }],
            }),
          );
        }
      }
      return out;
    },
  },
  {
    id: "P2",
    question: "Gemini's final round: withheld declarations vs functionCallingConfig mode NONE, with a functionCall in history",
    decides: "the Gemini tools-off mechanism (SPEC §4.6); fallback already in place",
    async run() {
      const contents = [
        { role: "user", parts: [{ text: "weather in Paris?" }] },
        { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { result: "12C" } } }] },
      ];
      const tools = [{ functionDeclarations: [{ name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } }] }];
      return [
        await postGemini("A: declarations withheld", GEMINI, { contents }),
        await postGemini("B: mode NONE", GEMINI, { contents, tools, toolConfig: { functionCallingConfig: { mode: "NONE" } } }),
      ];
    },
  },
  {
    id: "P3",
    question: "Gemini 3 google_search + functions: AUTO vs VALIDATED, with and without includeServerSideToolInvocations",
    decides: "nothing today (the current combination is kept)",
    async run() {
      const base = {
        contents: [{ role: "user", parts: [{ text: "Find today's top AI headline, then call save(title)." }] }],
        tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "save", description: "save", parameters: { type: "object", properties: { title: { type: "string" } } } }] }],
      };
      return [
        await postGemini("AUTO", GEMINI, { ...base, toolConfig: { functionCallingConfig: { mode: "AUTO" } } }),
        await postGemini("VALIDATED + server-side invocations", GEMINI, {
          ...base,
          toolConfig: { includeServerSideToolInvocations: true, functionCallingConfig: { mode: "VALIDATED" } },
        }),
      ];
    },
  },
  {
    id: "P4",
    question: "DeepSeek: is a tool round without reasoning_content a 400, and is an empty string accepted?",
    decides: "reasoning_content \"\" on foreign history turns (compat-loop.ts compatHistoryAssistantMessage)",
    async run() {
      const tools = [chatTool("now")];
      return [
        await postOpenAIShaped("without reasoning_content", "deepseek", "/chat/completions", {
          model: "deepseek-flash", reasoning_effort: "high", tools, messages: chatToolHistory(), max_tokens: 64,
        }),
        await postOpenAIShaped("with reasoning_content \"\"", "deepseek", "/chat/completions", {
          model: "deepseek-flash", reasoning_effort: "high", tools, messages: chatToolHistory({ reasoning_content: "" }), max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P5",
    question: "Kimi K3 / K2.7 Code: is a tool round without reasoning_content a 400?",
    decides: "moonshot replay \"must\" vs \"should\" (model-tools.ts)",
    async run() {
      const out: ProbeResult[] = [];
      for (const model of ["kimi-k3", "kimi-k2.7-code"]) {
        out.push(
          await postOpenAIShaped(model, "moonshot", "/chat/completions", {
            model, tools: [chatTool("now")], messages: chatToolHistory(), max_tokens: 64,
          }),
        );
      }
      return out;
    },
  },
  {
    id: "P6",
    question: "GLM-5.3: tool_choice \"none\", and thinking {type: disabled}",
    decides: "zhipu finalRound (omit_tools → tool_choice_none)",
    async run() {
      return [
        await postOpenAIShaped("tool_choice none", "zhipu", "/chat/completions", {
          model: "glm-5.3", tool_choice: "none", tools: [chatTool("f")], messages: [{ role: "user", content: "hi" }], max_tokens: 64,
        }),
        await postOpenAIShaped("thinking disabled", "zhipu", "/chat/completions", {
          model: "glm-5.3", thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }], max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P7",
    question: "MiniMax M3: tool_choice \"none\", and a tool round replayed without reasoning_details",
    decides: "minimax finalRound and replay (model-tools.ts)",
    async run() {
      return [
        await postOpenAIShaped("tool_choice none", "minimax", "/chat/completions", {
          model: "MiniMax-M3", reasoning_split: true, tool_choice: "none", tools: [chatTool("f")], messages: [{ role: "user", content: "hi" }], max_tokens: 64,
        }),
        await postOpenAIShaped("replay without reasoning_details", "minimax", "/chat/completions", {
          model: "MiniMax-M3", reasoning_split: true, tools: [chatTool("now")], messages: chatToolHistory(), max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P8",
    question: "Meta Muse Spark: the exact body of the tool_choice \"none\" 400",
    decides: "the error classifier's wording only (meta stays omit_tools)",
    async run() {
      return [
        await postOpenAIShaped("tool_choice none", "meta", "/chat/completions", {
          model: "muse-spark-1.3", tool_choice: "none", tools: [chatTool("f")], messages: [{ role: "user", content: "hi" }], max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P9",
    question: "Which hosts reject a user message after a tool message, or a system message mid-conversation?",
    decides: "userAfterTool per lab (model-tools.ts)",
    async run() {
      const hosts: Array<[Parameters<typeof postOpenAIShaped>[1], string]> = [
        ["mistral", "mistral-medium-latest"],
        ["qwen", "qwen3.8-max"],
        ["zhipu", "glm-5.3"],
        ["minimax", "MiniMax-M3"],
        ["moonshot", "kimi-k3"],
        ["mimo", "mimo-v2.6-pro"],
        ["meta", "muse-spark-1.3"],
      ];
      const out: ProbeResult[] = [];
      for (const [provider, model] of hosts) {
        const history = chatToolHistory();
        out.push(
          await postOpenAIShaped(`${model}: user after tool`, provider, "/chat/completions", {
            model, tools: [chatTool("now")], max_tokens: 64,
            messages: [...history, { role: "user", content: [{ type: "text", text: "(image follows)" }] }],
          }),
        );
        out.push(
          await postOpenAIShaped(`${model}: system mid-conversation`, provider, "/chat/completions", {
            model, max_tokens: 64,
            messages: [
              { role: "user", content: "hi" },
              { role: "assistant", content: "Hello." },
              { role: "system", content: "Today is Thursday." },
              { role: "user", content: "what day is it?" },
            ],
          }),
        );
      }
      return out;
    },
  },
  {
    id: "P10",
    question: "OpenAI Chat Completions + tools + reasoning: which models 400?",
    decides: "the incident note only (every OpenAI model is on Responses already)",
    async run() {
      const out: ProbeResult[] = [];
      for (const model of ["gpt-6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-5.4-mini"]) {
        out.push(
          await postOpenAIShaped(model, "openai", "/chat/completions", {
            model, reasoning_effort: "low", tools: [chatTool("f")], messages: [{ role: "user", content: "hi" }],
          }),
        );
      }
      return out;
    },
  },
  {
    id: "P11",
    question: "Responses: replaying a round without its message item (reasoning + function_call only)",
    decides: "the incident note only (the adapter replays every item)",
    async run() {
      const tool = { type: "function", name: "f", description: "probe", parameters: { type: "object", properties: {} } };
      const first = await postOpenAIShaped("round 1", "openai", "/responses", {
        model: "gpt-5.3-codex", store: false, include: ["reasoning.encrypted_content"], tools: [tool],
        input: [{ role: "user", content: "Say one short sentence, then call f." }],
      });
      let output: Array<Record<string, unknown>> = [];
      try {
        output = (JSON.parse(first.body) as { output?: Array<Record<string, unknown>> }).output ?? [];
      } catch {
        return [first, { label: "round 2", status: null, body: "round 1 did not return a JSON body" }];
      }
      const call = output.find((item) => item.type === "function_call");
      if (!call) return [first, { label: "round 2", status: null, body: "round 1 made no function call" }];
      const user = { role: "user", content: "Say one short sentence, then call f." };
      const result = { type: "function_call_output", call_id: call.call_id, output: "ok" };
      const withoutMessage = output.filter((item) => item.type !== "message");
      return [
        first,
        await postOpenAIShaped("round 2 without the message item", "openai", "/responses", {
          model: "gpt-5.3-codex", store: false, tools: [tool], input: [user, ...withoutMessage, result],
        }),
        await postOpenAIShaped("round 2 with every item", "openai", "/responses", {
          model: "gpt-5.3-codex", store: false, tools: [tool], input: [user, ...output, result],
        }),
      ];
    },
  },
  {
    id: "P12",
    question: "OpenAI: do defer_loading tools count toward the 128-function cap?",
    decides: "maxTools for OpenAI (and a later tool_search adoption)",
    async run() {
      const tools = Array.from({ length: 129 }, (_, i) => ({
        type: "function",
        name: `f${i}`,
        description: "probe",
        parameters: { type: "object", properties: {} },
        ...(i >= 4 ? { defer_loading: true } : {}),
      }));
      return [
        await postOpenAIShaped("129 functions, 125 deferred", "openai", "/responses", {
          model: "gpt-6-luna", store: false, tools: [...tools, { type: "tool_search" }], input: "hi", max_output_tokens: 16,
        }),
      ];
    },
  },
  {
    id: "P13",
    question: "xAI: Live Search on Chat Completions; web_search on grok-build-0.1; a function tool on the multi-agent model",
    decides: "grok-build-0.1 nativeSearch and grok-4.20-multi-agent-0309 supported (model-tools.ts)",
    async run() {
      return [
        await postOpenAIShaped("(a) search_parameters on Chat Completions (expect 410)", "xai", "/chat/completions", {
          model: "grok-4.7", messages: [{ role: "user", content: "latest xAI news?" }], search_parameters: { mode: "auto" }, max_tokens: 64,
        }),
        await postOpenAIShaped("(b) web_search on grok-build-0.1", "xai", "/responses", {
          model: "grok-build-0.1", store: false, input: [{ role: "user", content: "latest xAI news?" }], tools: [{ type: "web_search" }],
        }),
        await postOpenAIShaped("(c) a function tool on grok-4.20-multi-agent-0309", "xai", "/responses", {
          model: "grok-4.20-multi-agent-0309", store: false, input: [{ role: "user", content: "call f" }],
          tools: [{ type: "function", name: "f", description: "probe", parameters: { type: "object", properties: {} } }],
        }),
      ];
    },
  },
  {
    id: "P14",
    question: "xAI: is grok-4.1-fast a served slug, and on which surface?",
    decides: "grok-4.1-fast responses/nativeSearch (model-tools.ts)",
    async run() {
      return [
        await getOpenAIShaped("GET /models/grok-4.1-fast", "xai", "/models/grok-4.1-fast"),
        await postOpenAIShaped("one-token Responses call", "xai", "/responses", {
          model: "grok-4.1-fast", store: false, input: "hi", max_output_tokens: 16,
        }),
      ];
    },
  },
  {
    id: "P15",
    question: "Anthropic tool versions per model",
    decides: "anthropicSearchVersion values; native structured outputs for the research planner",
    async run() {
      return [
        await postAnthropic("(a) claude-opus-5-5 with web_fetch_20260318", {
          model: "claude-opus-5-5", max_tokens: 1024, messages: [{ role: "user", content: "Summarize https://example.com" }],
          tools: [{ type: "web_fetch_20260318", name: "web_fetch", max_uses: 1 }],
        }),
        await postAnthropic("(b) claude-haiku-4-5 with web_search_20260318, no allowed_callers", {
          model: "claude-haiku-4-5", max_tokens: 256, messages: [{ role: "user", content: "Latest AI news?" }],
          tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 1 }],
        }),
      ];
    },
  },
  {
    id: "P16",
    question: "Opus 5.5: do display \"updates\" progress blocks differ from \"summarized\" thinking?",
    decides: "nothing (not adopted)",
    async run() {
      const body = (display: string) => ({
        model: "claude-opus-5-5", max_tokens: 2048, thinking: { type: "adaptive", display },
        messages: [{ role: "user", content: "Use the tool twice, then answer." }],
        tools: [{ name: "now", description: "time", input_schema: { type: "object", properties: {} } }],
      });
      return [
        await postAnthropic("summarized", body("summarized")),
        await postAnthropic("updates", body("updates"), { "anthropic-beta": "thinking-display-updates-2026-08-18" }),
      ];
    },
  },
  {
    id: "P17",
    question: "Qwen: enable_search with tools on qwen3.8-flash; tools on qwen-long",
    decides: "nothing (Qwen keeps Juno web_search)",
    async run() {
      return [
        await postOpenAIShaped("enable_search + tools on qwen3.8-flash", "qwen", "/chat/completions", {
          model: "qwen3.8-flash", enable_search: true, tools: [chatTool("f")], messages: [{ role: "user", content: "latest AI news?" }], max_tokens: 64,
        }),
        await postOpenAIShaped("tools on qwen-long", "qwen", "/chat/completions", {
          model: "qwen-long", tools: [chatTool("f")], messages: [{ role: "user", content: "call f" }], max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P18",
    question: "LongCat: does LongCat-2.0 take tools, and tool_choice \"none\"?",
    decides: "longcat finalRound (model-tools.ts)",
    async run() {
      return [
        await postOpenAIShaped("tools", "longcat", "/chat/completions", {
          model: "LongCat-2.0", tools: [chatTool("f")], messages: [{ role: "user", content: "call f" }], max_tokens: 64,
        }),
        await postOpenAIShaped("tool_choice none", "longcat", "/chat/completions", {
          model: "LongCat-2.0", tool_choice: "none", tools: [chatTool("f")], messages: [{ role: "user", content: "hi" }], max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P19",
    question: "MiMo: web_search plus a function tool, and tool_choice \"none\"",
    decides: "mimo finalRound (model-tools.ts); native search stays off",
    async run() {
      return [
        await postOpenAIShaped("web_search + function", "mimo", "/chat/completions", {
          model: "mimo-v2.6-pro", tools: [{ type: "web_search" }, chatTool("f")], messages: [{ role: "user", content: "latest AI news?" }], max_tokens: 64,
        }),
        await postOpenAIShaped("tool_choice none", "mimo", "/chat/completions", {
          model: "mimo-v2.6-pro", tool_choice: "none", tools: [chatTool("f")], messages: [{ role: "user", content: "hi" }], max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P20",
    question: "GLM-5.3: the web_search tool beside a function tool",
    decides: "nothing (GLM keeps Juno web_search)",
    async run() {
      return [
        await postOpenAIShaped("web_search + function", "zhipu", "/chat/completions", {
          model: "glm-5.3", tools: [{ type: "web_search", web_search: { enable: true } }, chatTool("f")],
          messages: [{ role: "user", content: "latest AI news?" }], max_tokens: 64,
        }),
      ];
    },
  },
  {
    id: "P21",
    question: "Anthropic: continuing a pause_turn whose server_tool_use input was emptied",
    decides: "nothing (the adapter replays the real input regardless)",
    async run() {
      const tools = [{ type: "web_search_20260318", name: "web_search", max_uses: 20 }];
      const messages: Array<Record<string, unknown>> = [
        { role: "user", content: "Survey this week's AI news across ten sources, then summarise." },
      ];
      const first = await postAnthropic("round 1 (hoping for pause_turn)", { model: "claude-opus-5-5", max_tokens: 4096, tools, messages });
      let parsed: { stop_reason?: string; content?: Array<Record<string, unknown>> } = {};
      try {
        parsed = JSON.parse(first.body) as typeof parsed;
      } catch {
        return [first, { label: "round 2", status: null, body: "round 1 did not return a JSON body" }];
      }
      if (parsed.stop_reason !== "pause_turn") {
        return [first, { label: "round 2", status: null, body: `round 1 stopped with ${parsed.stop_reason}; rerun` }];
      }
      const emptied = (parsed.content ?? []).map((block) => (block.type === "server_tool_use" ? { ...block, input: {} } : block));
      return [
        first,
        await postAnthropic("round 2 with emptied input", {
          model: "claude-opus-5-5", max_tokens: 4096, tools, messages: [...messages, { role: "assistant", content: emptied }],
        }),
      ];
    },
  },
];
