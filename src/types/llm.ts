import type { Attachment, Role } from "@prisma/client";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ChatFinishReason, ClientSource } from "@/types/chat";
import type { ToolErrorCode, ToolOutcomeStatus, ToolProgress, ToolRunRecord } from "@/lib/tools/types";
import type {
  ChatSourceOrigin,
  ToolFigure,
  ToolPresentArgs,
  ToolWebDetail,
} from "@/types/run";

/**
 * Explicit prompt-cache markers for one request, on the providers that take
 * them (Anthropic; Qwen's explicit cache). Omitted: the chat behaviour, a
 * cached system prompt plus a marker on the newest message. "short": one
 * 5-minute marker on the system prompt only, for a system prompt reused by a
 * burst of calls whose user messages differ. "none": no markers, for one-off
 * prompts where a write would never be read and only adds its premium.
 */
/**
 * Prompt-cache markers for a request that is not a chat turn. Unset: the chat
 * markers (1h tools and system, a 5m conversation marker). "none": no markers,
 * for one-off utility prompts. "short": 5m markers only, and the conversation
 * marker only when the request runs a tool loop.
 */
export type PromptCacheMode = "none" | "short";

/** A persisted message reduced to what model adapters need. */
export type MessageForModel = {
  role: Role;
  content: string;
  attachments: Attachment[];
  /** ASSISTANT rows only: the turn's reasoning text, for the compat labs that
   *  must replay it on later tool turns (DeepSeek, MiMo, Kimi; SPEC §5.4). */
  reasoning?: string | null;
  /** ASSISTANT rows only: the model that wrote the row, so a replay rule can
   *  tell its own lab's turns from a foreign one's. */
  model?: string | null;  /**
   * USER rows only: the tail of `content` that is context for THIS generation
   * (retrieved passages, the memory notes ranked for this question, named
   * references) rather than the user's words. `content` already ends with it,
   * so every adapter sends it; an adapter with explicit cache breakpoints
   * (Anthropic) places the conversation breakpoint BEFORE it, because the tail
   * changes every turn and is never persisted — a breakpoint after it would
   * write a cache entry the next turn can never read.
   */
  volatileTail?: string;
};

/** Events yielded by a provider stream. */
export type LlmEvent =
  | {
      type: "text";
      text: string;
      /** The model step this text belongs to: 0-based, +1 every time the model
       *  resumes after tool results, whoever ran the tools. */
      round?: number;
      /** OpenAI Responses only: the message item's declared phase. */
      phase?: "commentary" | "answer";
    }
  /**
   * Visible chain-of-thought / thinking.
   *
   * `part` is the ordinal of the discrete summary part this delta belongs to,
   * assigned by the adapter from ARRAY POSITION — never from the provider's own
   * index. OpenAI's `summary_index` repeats within a single response (live:
   * [0…14, 13, 14] on gpt-5.4-mini), so using it as a key would collide two
   * parts into one and silently drop text.
   *
   * Only the OpenAI Responses adapter sets it, because it is the only provider
   * that delivers reasoning as discrete parts on the wire. Everyone else emits
   * one continuous stream and leaves it undefined — which is what makes
   * "this provider has no steps" a fact carried by the pipeline rather than a
   * guess made by the UI.
   */
  | { type: "reasoning"; text: string; part?: number; round?: number }
  | {
      type: "sources";
      sources: ClientSource[];
      /** Where they came from; drives the provenance ledger and is persisted on each source. */
      origin?: ChatSourceOrigin;
    }
  /**
   * A model step ended. `tools` counts the CLIENT tool calls (Juno, connector,
   * native) that ended the request — 0 when the step ended with the answer, a
   * stop, or a provider server-tool call inside the response. `serverTools`
   * counts provider server-tool calls in this step. `final` = this step's
   * request was the tools-off final request.
   */
  | { type: "round_end"; round: number; tools: number; serverTools: number; final: boolean; stop: string | null }
  /**
   * One connector tool call, in two acts.
   *
   * `call` is emitted the instant the model reaches for the tool — before the
   * network round trip — because that is the only moment at which "Using
   * Linear" is news. `result` is emitted when `execute()` returns and carries
   * what came back. A single event emitted only at completion would leave the
   * panel silent for the entire duration of the thing it exists to explain.
   *
   * ARGUMENTS RIDE ON WHICHEVER ACT HAS THEM, and that differs by provider,
   * which is why `args` is optional on both. OpenAI (Responses and compat)
   * accumulate the complete argument JSON before the loop dispatches, so their
   * `call` carries it. ANTHROPIC CANNOT: its call event is yielded from
   * `content_block_start` (anthropic-round.ts), where the arguments have not
   * begun streaming — they arrive as `input_json_delta` and are only whole at
   * `content_block_stop`. Anthropic therefore leaves `args` off `call` and
   * attaches it to `result`. A row whose args never arrive on either act SAYS
   * SO in the panel; it never renders an empty code block.
   *
   * `callId` is the provider's own id for the call (`call_id`, `tool_call.id`,
   * `tool_use.id`). It is what pairs the two acts, and it is the same id the
   * broker uses as half its idempotency key — so a stream that reconnects and
   * replays pairs correctly rather than opening a second row.
   *
   * `args` and `result` are RAW here. Redaction, truncation and the run budget
   * are the route's job (`src/lib/chat/tool-detail.ts`): an adapter is the
   * wrong layer to hold a policy, and putting it here would mean four copies.
   */
  | {
      type: "tool";
      phase: "call";
      server: string;
      name: string;
      callId: string;
      detail?: string;
      /** Raw JSON string exactly as the provider sent it, unparsed. */
      args?: string;
      /**
       * The provider's own id when it differs from `callId` (suffixed because a
       * host reused it, or synthesized because the host sent none). `callId`
       * is always the Alevr id (src/lib/tools/call-ids.ts).
       */
      providerCallId?: string;
      /** The model step this call ended: 0-based, +1 per tool round. */
      round?: number;
      /** Position of the call within its round, 0-based. */
      index?: number;
    }
  /**
   * The dispatcher's view of a call between `call` and `result`
   * (src/lib/tools/dispatch.ts).
   *
   * `queued` is yielded for every call of a batch the moment it starts, so the
   * rows exist before any of them runs. `awaiting_approval` means a person is
   * deciding (the approval frame itself still comes from the broker's
   * callback). `running` is yielded only AFTER authorisation, with the tool's
   * own bound: the route holds the stall watchdog from here to the result,
   * because the provider is not expected to say anything while a tool runs.
   */
  | {
      type: "tool";
      phase: "status";
      server?: string;
      name?: string;
      callId: string;
      status: "queued" | "awaiting_approval" | "running";
      approval?: ClientActionApproval;
      timeoutMs?: number;
      present?: ToolPresentArgs;
      argsText?: string;
    }
  /**
   * A running call's latest output (design §6.4): the last few lines and byte
   * counts, at most one frame per call per second. Logged like every other
   * frame, and it touches the watchdog.
   */
  | {
      type: "tool";
      phase: "progress";
      server?: string;
      name?: string;
      callId: string;
      progress: ToolProgress;
    }
  | {
      type: "tool";
      phase: "result";
      server: string;
      name: string;
      callId: string;
      detail?: string;
      /** Present only when the adapter could not attach it to `call`. */
      args?: string;
      /** The tool's output with the untrusted envelope ALREADY STRIPPED — the
       *  markers are a model-context construct and mean nothing to a reader. */
      result: string;
      /** False for `Tool error:`, a broker refusal, an unreachable connector,
       *  or an unknown tool name. NEVER inferred from the text: it comes from
       *  `McpToolset.execute`'s own outcome. A GitHub issue titled "Tool error:
       *  build fails" must not read as a failed call. */
      ok: boolean;
      /** Wall clock for the DISPATCH only, measured in mcp.ts around
       *  `client.callTool`. Absent when no dispatch happened — an approval wait
       *  sits before the clock starts and is deliberately excluded.
       *
       *  There is no `resultChars` companion: `result` is right here, and the
       *  only length that can honestly appear in the panel is one measured on
       *  the text the panel's own cut was taken from. tool-detail.ts measures
       *  it there rather than carrying a second, subtly different number. */
      durationMs?: number;
      providerCallId?: string;
      round?: number;
      index?: number;
      /** The typed outcome. `ok` stays and equals `status === "succeeded"`. */
      status?: ToolOutcomeStatus;
      error?: { code: ToolErrorCode };
      figure?: ToolFigure;
      web?: ToolWebDetail;
      /** Execution tools: the run behind the call. */
      run?: ToolRunRecord;
      /** Served from the turn's duplicate cache: nothing ran a second time. */
      cached?: boolean;
      /** Juno's own fee for this call in micro-USD; 0 or absent = tokens only. */
      feeMicroUsd?: number;
    }
  /** A provider-run (server-side) tool: Anthropic web_search, OpenAI/xAI hosted search, xAI x_search. */
  | {
      type: "server_tool";
      phase: "call" | "result";
      tool: "provider_web_search" | "provider_x_search";
      /** The provider's id (srvtoolu_…, ws_…) or `ps_${round}_${n}`. */
      callId: string;
      round: number;
      /** call: the query as streamed. */
      query?: string;
      /** result: how many results came back. */
      results?: number;
      /** result */
      ok?: boolean;
      web?: ToolWebDetail;
    }
  /**
   * A connector action is waiting for the person to answer.
   *
   * Emitted by the toolset the moment a receipt enters `pending`, BEFORE the
   * broker starts waiting on it — the stream is blocked on the answer, so an
   * event that arrived after the wait would arrive after the deadline it exists
   * to beat. The payload is the redacted client projection: the raw arguments
   * that the digest is taken over never leave the server.
   */
  | { type: "approval"; approval: ClientActionApproval }
  | {
      type: "usage";
      input?: number;
      output?: number;
      /**
       * Reasoning / thinking tokens when the provider reports them as a
       * separate counter. Often a *subset* of `output` (OpenAI); sometimes the
       * only place thinking is counted (then output is lifted to this value).
       */
      reasoning?: number;
      /** Full request total (input + output). Used as a cross-check. */
      total?: number;
      /** Prompt-cache hits (input tokens read from cache, billed ~0.1x). */
      cacheRead?: number;
      /**
       * Prompt-cache writes. Prefer cacheWrite5m / cacheWrite1h when the API
       * splits TTL (Anthropic). Aggregate write when only one counter exists.
       */
      cacheWrite?: number;
      cacheWrite5m?: number;
      cacheWrite1h?: number;
      /** Server web-search tool invocations (Anthropic / OpenAI / xAI). */
      webSearchRequests?: number;
      /** xAI X-search tool invocations. */
      xSearchRequests?: number;
      /** Which speed actually served this turn — true = premium fast mode was
       *  honored, false = it fell back to (or ran at) standard speed. Lets the
       *  route bill the real rate even when a fast request degrades. */
      fast?: boolean;
      round?: number;
      groundingQueries?: number;
    }
  | {
      type: "finish";
      reason: ChatFinishReason;
      raw?: string;
      /**
       * One sentence naming what actually ended the turn, when the adapter
       * knows something the reason alone cannot say.
       *
       * `finishReasonDetail` maps a reason to a generic sentence, and generic
       * was the problem: "Response hit the token limit · Use Continue" over a
       * Gemini turn that spent 64k of its 65,536-token budget THINKING tells
       * the reader to press Continue when the lever that fixes it is the
       * thinking level. Only the adapter has the numbers, so only the adapter
       * can say it. Absent means the generic sentence is the whole truth.
       */
      note?: string;
    };
