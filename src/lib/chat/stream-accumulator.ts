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
import type { FastMode } from "@/lib/pricing";
import type { TextSegment } from "@/lib/chat/answer-split";
import { SourceRegistry } from "@/lib/chat/source-registry";
import { appendReasoningDelta, emptyReasoning, type ReasoningState } from "@/lib/reasoning-parts";
import { mergeUsage, type UsageAccumulator } from "@/lib/usage-merge";
import type { ChatFinishReason, ClientSource } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";
import type { ToolErrorCode, ToolOutcomeStatus, ToolProgress, ToolRunRecord } from "@/lib/tools/types";

export type StreamEffect =
  | {
      kind: "text";
      text: string;
      /** True exactly once, on the first text delta — the "Writing…" activity. */
      startedWriting: boolean;
    }
  | { kind: "reasoning"; text: string; part?: number; round: number }
  /**
   * The two acts of one connector call, paired by `callId`.
   *
   * The accumulator holds NO tool state of its own. It could pair the acts
   * here, but it must not: a mid-stream reconnect replays events, and any
   * pairing state kept here would have to be reconciled against an activity log
   * and a database this class cannot see. The route already owns both, so it
   * owns the pairing too — and gets one activity row per call out of it.
   */
  | { kind: "tool_call"; server: string; name: string; callId: string; args?: string }
  /** The dispatcher's queued / awaiting_approval / running act for a call. */
  | {
      kind: "tool_status";
      server?: string;
      name?: string;
      callId: string;
      status: "queued" | "awaiting_approval" | "running";
      timeoutMs?: number;
    }
  /** A running call's latest output. */
  | { kind: "tool_progress"; server?: string; name?: string; callId: string; progress: ToolProgress }
  | {
      kind: "tool_result";
      server: string;
      name: string;
      callId: string;
      args?: string;
      result: string;
      ok: boolean;
      durationMs?: number;
      status?: ToolOutcomeStatus;
      errorCode?: ToolErrorCode;
      run?: ToolRunRecord;
      cached?: boolean;
    }
  | {
      kind: "sources";
      /** Newly seen this event — one "Visited source" activity each. */
      added: ClientSource[];
      /** Every source so far. Published whole, because citations are numbered. */
      all: ClientSource[];
    }
  | { kind: "usage" }
  | { kind: "finish"; reason: ChatFinishReason }
  /** Nothing to emit — an event this build does not render. */
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
  /** The adapter's own sentence about why, when it has one. See LlmEvent. */
  finishNote: string | null = null;
  /**
   * Which speed actually served. Starts at what was requested and is refined
   * from the usage stream, because a fast adapter may fall back to standard.
   */
  /** The tier the turn was served on (pricing.ts FastMode): what billing charges. */
  servedFast: FastMode;
  writingStarted = false;
  /**
   * The turn's text as runs within model steps, in stream order (SPEC §2.8).
   * `splitAnswer` decides from these which text is the answer and which was
   * commentary; `text` above stays the glued stream for billing and the
   * budget guard.
   */
  readonly textSegments: TextSegment[] = [];
  /**
   * The model step the next event belongs to when it does not say: the round
   * of the last event that did, or one past the last `round_end`. Adapters
   * stamp every event's `round` once converted (SPEC §2.9); this covers the
   * ones that do not yet.
   */
  currentRound = 0;
  /**
   * The first model step of the provider request in flight: one past the last
   * `round_end` that ended in client tool calls. A `round_end` with no client
   * tools inside a turn is a step within the same request (a provider search
   * inside the response, a `pause_turn` continuation), so when the request
   * does end in client tools, every step since this one is demoted with it.
   */
  requestStartRound = 0;

  /**
   * The turn's one list of sources (SPEC §2.11). The route passes the same
   * registry the tools number against, so a citation [n] and the persisted
   * `Message.sources` order are one list; without one the accumulator keeps
   * its own, as before.
   */
  readonly sourceRegistry: SourceRegistry;

  constructor(options: { requestedFastMode?: FastMode; sources?: SourceRegistry } = {}) {
    this.servedFast = options.requestedFastMode ?? false;
    this.sourceRegistry = options.sources ?? new SourceRegistry();
  }

  get reasoning(): string {
    return this.reasoningState.text;
  }

  get reasoningParts(): string[] {
    return this.reasoningState.parts;
  }

  /** Every source so far, normalised (INV-3), in the order they were first seen. */
  get sources(): ClientSource[] {
    return [...this.sourceRegistry.all()];
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
  seedSources(sources: readonly ClientSource[], origin?: ClientSource["origin"]): ClientSource[] {
    const before = this.sourceRegistry.all().length;
    this.sourceRegistry.register(sources, { cited: false, ...(origin ? { origin } : {}) });
    return this.sourceRegistry.all().slice(before);
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
        const round = this.roundOf(event.round);
        const phase = event.phase ?? null;
        const last = this.textSegments[this.textSegments.length - 1];
        if (last && last.round === round && last.phase === phase) last.text += event.text;
        else this.textSegments.push({ round, phase, text: event.text, endedInTools: false });
        return { kind: "text", text: event.text, startedWriting };
      }
      case "reasoning": {
        const round = this.roundOf(event.round);
        // `round` puts a blank line between two steps' thinking in the flat
        // text, exactly where the client's fold of the same frames puts it.
        this.reasoningState = appendReasoningDelta(this.reasoningState, event.text, event.part, round);
        // `part` rides the SSE so the panel can build steps AS THEY ARRIVE,
        // from the same boundaries the API gave the adapter.
        return { kind: "reasoning", text: event.text, part: event.part, round };
      }
      case "round_end": {
        // A request that ended in CLIENT tool calls demotes the undeclared text
        // of every step it held; a provider search inside the response never
        // does on its own (SPEC §2.8 rule 1). "Let me search. <search> Let me
        // open that page. <web_fetch>" is one request that ended in a tool
        // call, so both sentences are commentary.
        if (event.tools > 0) {
          const from = this.demotedRoundsFrom(event.round);
          for (const segment of this.textSegments) {
            if (segment.round >= from && segment.round <= event.round) segment.endedInTools = true;
          }
          this.requestStartRound = Math.max(this.requestStartRound, event.round + 1);
        }
        this.currentRound = Math.max(this.currentRound, event.round + 1);
        return { kind: "none" };
      }
      case "tool": {
        // Results are no longer swallowed. They carry the only record of what a
        // connector actually answered, and dropping them here is what used to
        // make "Using Linear" the entire truth the panel could tell.
        switch (event.phase) {
          case "call":
            return { kind: "tool_call", server: event.server, name: event.name, callId: event.callId, args: event.args };
          case "status":
            return {
              kind: "tool_status",
              callId: event.callId,
              status: event.status,
              ...(event.server !== undefined ? { server: event.server } : {}),
              ...(event.name !== undefined ? { name: event.name } : {}),
              ...(event.timeoutMs === undefined ? {} : { timeoutMs: event.timeoutMs }),
            };
          case "progress":
            return {
              kind: "tool_progress",
              callId: event.callId,
              progress: event.progress,
              ...(event.server !== undefined ? { server: event.server } : {}),
              ...(event.name !== undefined ? { name: event.name } : {}),
            };
          case "result":
            return {
              kind: "tool_result",
              server: event.server,
              name: event.name,
              callId: event.callId,
              args: event.args,
              result: event.result,
              ok: event.ok,
              durationMs: event.durationMs,
              ...(event.status ? { status: event.status } : {}),
              ...(event.error ? { errorCode: event.error.code } : {}),
              ...(event.run ? { run: event.run } : {}),
              ...(event.cached ? { cached: true } : {}),
            };
        }
        return { kind: "none" };
      }
      case "sources": {
        const added = this.seedSources(event.sources, event.origin);
        return { kind: "sources", added, all: this.sources };
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
        // Kept beside the reason rather than folded into it: the reason is what
        // the product branches on (Continue is offered for `length`), the note
        // is what the reader is told. Collapsing them would make one of the two
        // wrong.
        this.finishNote = event.note ?? null;
        return { kind: "finish", reason: event.reason };
      }
      default:
        return { kind: "none" };
    }
  }

  /**
   * The first step a client-tool `round_end` for `round` demotes: the start of
   * the request in flight, or `round` itself when an adapter reports an
   * earlier step than one already closed.
   */
  demotedRoundsFrom(round: number): number {
    return Math.min(this.requestStartRound, round);
  }

  /** An event's own round when it has one (and from then on the current one), else the current. */
  private roundOf(round: number | undefined): number {
    if (typeof round === "number" && Number.isInteger(round) && round >= 0) {
      this.currentRound = round;
      return round;
    }
    return this.currentRound;
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
