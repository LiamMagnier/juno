import { formatPreflightClarificationModelMessage } from "@/lib/preflight-clarification";
import type { FirstSubmissionPreflightClarification } from "@/lib/chat-first-submission";

export interface ModerationHistoryMessage {
  role: string;
  content: string;
}

/**
 * Return the actual user-authored model inputs that need moderation. Private
 * history can contain several user turns, while preflight answers replace the
 * plain composer text with the formatted effective prompt.
 */
export function effectiveModerationTexts(input: {
  message?: string;
  preflightClarification?: FirstSubmissionPreflightClarification;
  privateHistory?: ModerationHistoryMessage[];
  privateMode?: boolean;
  regenerate?: boolean;
}): string[] {
  if (input.regenerate) return [];
  if (input.privateMode) {
    const history = [...(input.privateHistory ?? [])];
    if (input.preflightClarification) {
      let lastUserIndex = -1;
      for (let index = history.length - 1; index >= 0; index--) {
        if (history[index].role === "USER") {
          lastUserIndex = index;
          break;
        }
      }
      if (lastUserIndex >= 0) {
        history[lastUserIndex] = {
          ...history[lastUserIndex],
          content: formatPreflightClarificationModelMessage(input.preflightClarification),
        };
      }
    }
    return history
      .filter((message) => message.role === "USER")
      .map((message) => message.content.trim())
      .filter(Boolean);
  }
  const effective = input.preflightClarification
    ? formatPreflightClarificationModelMessage(input.preflightClarification)
    : input.message?.trim() ?? "";
  return effective ? [effective] : [];
}

/** Private-mode audit records retain the verdict, never the prompt preview. */
export function moderationMessagePreview(text: string, privateMode: boolean): string | null {
  return privateMode ? null : text.slice(0, 240);
}
