/**
 * `suggest_research` (SPEC §3.8.9): a "Research this" button under the answer.
 *
 * Nothing runs when the model calls it. The call is the suggestion; the client
 * renders the chip from the record's `present` args, and only the person
 * pressing it starts a Research run. It is attached only to clients that
 * declared they can draw the chip (INV-10). A second call replaces the first
 * chip, which is why it is never deduplicated.
 */

import { EMPTY_QUESTION_TEXT, suggestedText } from "@/lib/tools/specs/suggest-research.prompt";
import { failed, oneLine, succeeded } from "@/lib/tools/specs/shared";
import { defineTool } from "@/lib/tools/types";

export const SUGGEST_RESEARCH_QUESTION_MAX = 300;
export const SUGGEST_RESEARCH_REASON_MAX = 160;

export interface SuggestResearchArgs extends Record<string, unknown> {
  question?: unknown;
  reason?: unknown;
}

export const suggestResearchSpec = defineTool<SuggestResearchArgs>({
  id: "suggest_research",
  title: "Suggest research",
  description:
    "Shows the user a \"Research this\" button under your answer; nothing runs unless they press it. Use it after answering briefly when the question deserves a multi-source investigation: a broad comparison, a market or literature overview, a contested or fast-moving topic, or anything needing more than about five searches. Do not use it for questions a few searches answer, for questions about a private person, or for the user's own medical, legal or financial situation. The button is the question: do not also ask \"want me to research this?\" in your text. Give the research question as the user would phrase it, and one short reason.",
  input: {
    type: "object",
    properties: {
      question: { type: "string", description: "The research question, ≤ 300 characters. Required." },
      reason: { type: "string", description: "Why it needs research, ≤ 160 characters. Required." },
    },
    required: ["question", "reason"],
  },
  risk: "read",
  parallelSafe: true,
  timeoutMs: 1_000,
  icon: "research",
  broker: "none",
  dedupe: false,
  present(args) {
    // The record's strings are ≤ 200 characters (SPEC §3.1), which the chip's
    // question follows even though the model may send up to 300.
    return {
      question: oneLine(args.question),
      reason: oneLine(args.reason, SUGGEST_RESEARCH_REASON_MAX),
    };
  },
  async execute(args) {
    const question = oneLine(args.question, SUGGEST_RESEARCH_QUESTION_MAX);
    if (!question) return failed("invalid_args", EMPTY_QUESTION_TEXT);
    return succeeded(suggestedText(question));
  },
});
