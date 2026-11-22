import type { ExportMessage } from "@/components/chat/conversation-export";
import type { TurnItem } from "@/lib/code-v2/contracts";

/** The conversation itself, with attachment names and the settling state of each answer. */
export function codeExportMessages(items: readonly TurnItem[]): ExportMessage[] {
  const messages: ExportMessage[] = [];
  for (const item of items) {
    if (item.agentId) continue;
    if (item.kind === "user_message") {
      messages.push({
        id: item.id,
        role: "USER",
        content: item.text,
        attachments: item.attachments?.map(({ name }) => ({ fileName: name })),
      });
    } else if (item.kind === "assistant_message") {
      messages.push({ id: item.id, role: "ASSISTANT", content: item.text, streaming: item.streaming });
    }
  }
  return messages;
}
