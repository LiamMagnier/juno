import type { Attachment, Role } from "@prisma/client";
import type { ClientSource } from "@/types/chat";

/** A persisted message reduced to what model adapters need. */
export type MessageForModel = { role: Role; content: string; attachments: Attachment[] };

/** Events yielded by a provider stream. */
export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string } // visible chain-of-thought / thinking
  | { type: "sources"; sources: ClientSource[] }
  | { type: "usage"; input?: number; output?: number };
