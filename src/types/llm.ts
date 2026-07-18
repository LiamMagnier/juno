import type { Attachment, Role } from "@prisma/client";
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
  | { type: "tool"; server: string; name: string; phase: "call" | "result"; detail?: string }
  | {
      type: "usage";
      input?: number;
      output?: number;
      /** Prompt-cache hits (input tokens read from cache, billed ~0.1x). */
      cacheRead?: number;
      /** Prompt-cache writes (input tokens written to cache, billed ~1.25x). */
      cacheWrite?: number;
      /** Which speed actually served this turn — true = premium fast mode was
       *  honored, false = it fell back to (or ran at) standard speed. Lets the
       *  route bill the real rate even when a fast request degrades. */
      fast?: boolean;
    }
  | { type: "finish"; reason: ChatFinishReason; raw?: string };
