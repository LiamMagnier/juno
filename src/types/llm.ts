import type { Attachment, Role } from "@prisma/client";
import type { ChatFinishReason, ClientSource } from "@/types/chat";

/** A persisted message reduced to what model adapters need. */
export type MessageForModel = { role: Role; content: string; attachments: Attachment[] };

/** Events yielded by a provider stream. */
export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string } // visible chain-of-thought / thinking
  | { type: "sources"; sources: ClientSource[] }
  | {
      type: "usage";
      input?: number;
      output?: number;
      /** Prompt-cache hits (input tokens read from cache, billed ~0.1x). */
      cacheRead?: number;
      /** Prompt-cache writes (input tokens written to cache, billed ~1.25x). */
      cacheWrite?: number;
    }
  | { type: "finish"; reason: ChatFinishReason; raw?: string };
