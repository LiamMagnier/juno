/**
 * The one request shape every provider adapter takes (SPEC §5.0).
 *
 * The adapters used to take positional argument lists that had drifted apart;
 * this is the common interface they converge on. `transport` is the test seam:
 * the adapters' request, stream-reading and replay code lives in modules that
 * are free of `server-only` and take the transport as an input, so a full tool
 * loop can be driven offline by a scripted transport. Production leaves it
 * absent and the adapter wires in its real SDK client.
 *
 * Types only.
 */

import type { LoopController } from "@/lib/llm/loop";
import type { ModelInfo } from "@/lib/models";
import type { BatchContext } from "@/lib/tools/dispatch";
import type { ChatToolset, PortableSchema } from "@/lib/tools/types";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export interface AdapterRequest {
  model: ModelInfo;
  system: string;
  systemStablePrefix?: string;
  history: MessageForModel[];
  maxTokens: number;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  /** Provider-native search attached (Anthropic web_search, Gemini google_search, Responses web_search). */
  webSearch: boolean;
  toolset?: ChatToolset;
  /** Present iff toolset is present. */
  batch?: Omit<BatchContext, "toolset" | "nextIsFinal">;
  loop: LoopController;
  dynamicContext?: string;
  cacheKey?: string;
  fastMode?: boolean;
  proMode?: boolean;
  requestContext?: { requestId?: string | null; generationId?: string | null; conversationId?: string | null };
  /** Structured output for a tool-less call (the research planner, SPEC §9.5). Mapped per adapter:
   *  Anthropic → one tool `{name, input_schema}` with `tool_choice: {type:"auto"}` plus
   *  validate-and-retry (a forced `any`/`tool` choice 400s on Fable 5.1 and Opus 5.5; native
   *  structured outputs only after probe P15); Responses → `text: { format: { type:
   *  "json_schema", name, schema, strict: false } }`; Gemini → `responseJsonSchema` with
   *  `responseMimeType: "application/json"`; compat → `response_format: { type: "json_object" }`
   *  plus validation, never a named `tool_choice` on Kimi or DeepSeek. */
  responseSchema?: { name: string; schema: PortableSchema };
  /** Test seam: replaces the SDK singleton (`getAnthropic()` etc.) with a scripted transport, so
   *  full-loop tests run offline. Absent in production. */
  transport?: ProviderTransport;
}

export type ProviderStream = (req: AdapterRequest) => AsyncGenerator<LlmEvent>;

/** Per adapter: `request(body, signal)` returns the provider's raw stream events (or the parsed
 *  SSE lines for fetch-based adapters). */
export interface ProviderTransport {
  request(body: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
}
