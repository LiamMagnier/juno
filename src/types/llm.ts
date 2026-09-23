import type { Attachment, Role } from "@prisma/client";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ChatFinishReason, ClientSource } from "@/types/chat";
import type {
  ChatSourceOrigin,
  ToolErrorCode,
  ToolFigure,
  ToolPresentArgs,
  ToolWebDetail,
} from "@/types/run";

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
  model?: string | null;
};

/*
 * THE CHAT REWORK'S ADDITIONS (SPEC §2.9) land in two steps. Every field added
 * to an EXISTING member below is optional for now — `round?`, `index?`,
 * `status?`… — so no producer has to change in the same commit. The adapters
 * make the adapter-side fields required when the last one is converted, and
 * the route drops its defaults after that. Members that are new outright
 * (`round_end`, the `tool` status act, `server_tool`) carry their final shape
 * from the start.
 *
 * The Anthropic and Gemini adapters stamp every adapter-side field already;
 * the Responses and compat adapters are converted separately, and the
 * `round?`/`index?` fields tighten once they are.
 */

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
      /** The provider's own id when `callId` had to be suffixed or synthesized (SPEC §4.3). */
      providerCallId?: string;
      round?: number;
      /** Position of the call within its round, 0-based. */
      index?: number;
    }
  /**
   * The dispatcher's view of a call between `call` and `result`.
   *
   * `awaiting_approval` carries the redacted client projection the approval
   * frame sends; `running` is emitted only after authorisation succeeded, never
   * before an approval wait. The first `queued` carries the presentation args
   * and the full argument text, so a row can show its query or domain before
   * the result arrives (Anthropic's `call` fires before its arguments stream).
   */
  | {
      type: "tool";
      phase: "status";
      callId: string;
      status: "queued" | "running" | "awaiting_approval";
      approval?: ClientActionApproval;
      timeoutMs?: number;
      present?: ToolPresentArgs;
      argsText?: string;
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
      round?: number;
      index?: number;
      /** The typed outcome; `ok` stays and equals `status === "succeeded"`. */
      status?: "succeeded" | "failed" | "denied" | "expired" | "cancelled";
      error?: { code: ToolErrorCode };
      figure?: ToolFigure;
      web?: ToolWebDetail;
      /** Served from the turn's duplicate cache. */
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
      /**
       * result, Gemini grounding only: `{ engine: "gemini", searchSuggestionsHtml }`
       * — Google's Search Suggestions widget, which its grounding terms ask to be
       * shown with the answer (SPEC §5.3 item 11). Carried on the provider-search
       * record; no surface renders it yet (owner item O-2).
       */
      web?: ToolWebDetail;
    }
  /*
   * There is no `approval` member. An approval travels as the call's own
   * `tool` status act (`awaiting_approval`, carrying the redacted projection),
   * so it is ordered with the call it belongs to rather than beside it.
   */
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
      /** Present on per-round cumulative usage (every adapter, after every request). */
      round?: number;
      /** Gemini only: grounding queries so far, before the free-quota split. */
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
