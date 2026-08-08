import type { Attachment, Role } from "@prisma/client";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ChatFinishReason, ClientSource } from "@/types/chat";

/** A persisted message reduced to what model adapters need. */
export type MessageForModel = { role: Role; content: string; attachments: Attachment[] };

/** Events yielded by a provider stream. */
export type LlmEvent =
  | { type: "text"; text: string }
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
  | { type: "reasoning"; text: string; part?: number }
  | { type: "sources"; sources: ClientSource[] }
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
    }
  | { type: "finish"; reason: ChatFinishReason; raw?: string };
