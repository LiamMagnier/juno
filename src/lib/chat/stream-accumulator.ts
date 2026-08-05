/**
 * Stage: the provider/tool stream.
 *
 * Folding a provider's event stream into the state a turn is made of — text,
 * reasoning, sources, usage, finish reason — existed twice in the route, once
 * on the private path and once on the saved one, ~70 near-identical lines each.
 * They had already diverged in small ways, and every fix to the stream had to
 * be found and re-made in both.
 *
 * The accumulator holds the state and answers "what should be emitted for this
 * event"; the route still owns the SSE, the activity log and the budget guard.
 * That split is what keeps the extraction behaviour-preserving: the effects
 * come back in the same order the branches produced them, and the caller does
 * exactly what it did before with each one.
 */
import { appendReasoningDelta, emptyReasoning, type ReasoningState } from "@/lib/reasoning-parts";
import { mergeUsage, type UsageAccumulator } from "@/lib/usage-merge";
import type { ChatFinishReason, ClientSource } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";

export type StreamEffect =
  | {
      kind: "text";
      text: string;
      /** True exactly once, on the first text delta — the "Writing…" activity. */
      startedWriting: boolean;
    }
  | { kind: "reasoning"; text: string; part?: number }
  /** A tool invocation worth showing. Results are folded in silently. */
  | { kind: "tool_call"; server: string; name: string }
  | {
      kind: "sources";
      /** Newly seen this event — one "Visited source" activity each. */
      added: ClientSource[];
      /** Every source so far. Published whole, because citations are numbered. */
      all: ClientSource[];
    }
  | { kind: "usage" }
  | { kind: "finish"; reason: ChatFinishReason }
  /** Nothing to emit — a tool result, or an event this build does not render. */
  | { kind: "none" };

/** Token counters in the shape `recordSpend` and the logs want them. */
export interface AccumulatedTokens {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  webSearchRequests?: number;
  xSearchRequests?: number;
}

export class GenerationAccumulator {
  /**
   * The assistant text as it will be persisted. A canvas edit replaces this
   * wholesale after the stream (see `replaceText`), which is why the character
   * count the model actually emitted is tracked separately.
   */
  text = "";
  /**
   * Characters the MODEL emitted. Floors the cost estimate, so it must not
   * include a rebuilt artifact the model never wrote.
   */
  providerOutputChars = 0;
  reasoningState: ReasoningState = emptyReasoning();
  usage: UsageAccumulator = {};
  finishReason: ChatFinishReason = "stop";
  /**
   * Which speed actually served. Starts at what was requested and is refined
   * from the usage stream, because a fast adapter may fall back to standard.
   */
  servedFast: boolean;
  writingStarted = false;

  private readonly sourceList: ClientSource[] = [];
  private readonly sourceUrls = new Set<string>();

  constructor(options: { requestedFastMode?: boolean } = {}) {
    this.servedFast = options.requestedFastMode ?? false;
  }

  get reasoning(): string {
    return this.reasoningState.text;
  }

  get reasoningParts(): string[] {
    return this.reasoningState.parts;
  }

  get sources(): ClientSource[] {
    return this.sourceList;
  }

  get hasOutput(): boolean {
    return !!(this.text || this.reasoning);
  }

  get tokens(): AccumulatedTokens {
    return {
      promptTokens: this.usage.input,
      completionTokens: this.usage.output,
      reasoningTokens: this.usage.reasoning,
      totalTokens: this.usage.total,
      cacheReadTokens: this.usage.cacheRead,
      cacheWriteTokens: this.usage.cacheWrite,
      cacheWrite5mTokens: this.usage.cacheWrite5m,
      cacheWrite1hTokens: this.usage.cacheWrite1h,
      webSearchRequests: this.usage.webSearchRequests,
      xSearchRequests: this.usage.xSearchRequests,
    };
  }

  /**
   * Adds sources known before the stream starts — deep research resolves its
   * whole corpus up front, and the numbering the report cites must match.
   */
  seedSources(sources: readonly ClientSource[]): ClientSource[] {
    const added: ClientSource[] = [];
    for (const source of sources) {
      if (!source.url || this.sourceUrls.has(source.url)) continue;
      this.sourceUrls.add(source.url);
      this.sourceList.push(source);
      added.push(source);
    }
    return added;
  }

  /**
   * Replaces the persisted text without touching `providerOutputChars`.
   *
   * Used by a canvas edit, where the model emits a patch and the message shows
   * the rebuilt artifact. Billing follows what the model emitted.
   */
  replaceText(next: string): void {
    this.text = next;
  }

  apply(event: LlmEvent): StreamEffect {
    switch (event.type) {
      case "text": {
        const startedWriting = !this.writingStarted;
        this.writingStarted = true;
        this.text += event.text;
        this.providerOutputChars += event.text.length;
        return { kind: "text", text: event.text, startedWriting };
      }
      case "reasoning": {
        this.reasoningState = appendReasoningDelta(this.reasoningState, event.text, event.part);
        // `part` rides the SSE so the panel can build steps AS THEY ARRIVE,
        // from the same boundaries the API gave the adapter.
        return { kind: "reasoning", text: event.text, part: event.part };
      }
      case "tool": {
        if (event.phase !== "call") return { kind: "none" };
        return { kind: "tool_call", server: event.server, name: event.name };
      }
      case "sources": {
        const added = this.seedSources(event.sources);
        return { kind: "sources", added, all: this.sourceList };
      }
      case "usage": {
        this.usage = mergeUsage(this.usage, {
          input: event.input,
          output: event.output,
          reasoning: event.reasoning,
          total: event.total,
          cacheRead: event.cacheRead,
          cacheWrite: event.cacheWrite,
          cacheWrite5m: event.cacheWrite5m,
          cacheWrite1h: event.cacheWrite1h,
          webSearchRequests: event.webSearchRequests,
          xSearchRequests: event.xSearchRequests,
          fast: event.fast,
        });
        if (this.usage.fast != null) this.servedFast = this.usage.fast;
        return { kind: "usage" };
      }
      case "finish": {
        this.finishReason = event.reason;
        return { kind: "finish", reason: event.reason };
      }
      default:
        return { kind: "none" };
    }
  }

  /** The raw counters `buildUsage` reconciles into a billable figure. */
  rawUsage(chars: { promptChars: number; reasoningChars?: number }) {
    return {
      input: this.usage.input,
      output: this.usage.output,
      reasoning: this.usage.reasoning,
      total: this.usage.total,
      cacheRead: this.usage.cacheRead,
      cacheWrite: this.usage.cacheWrite,
      cacheWrite5m: this.usage.cacheWrite5m,
      cacheWrite1h: this.usage.cacheWrite1h,
      webSearchRequests: this.usage.webSearchRequests,
      xSearchRequests: this.usage.xSearchRequests,
      promptChars: chars.promptChars,
      completionChars: this.providerOutputChars,
      reasoningChars: chars.reasoningChars ?? this.reasoning.length,
    };
  }
}
