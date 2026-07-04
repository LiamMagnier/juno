import type { ClientAttachment } from "@/types/chat";

export type PreflightClarificationQuestionType = "single-choice" | "multi-choice" | "text" | "text-long";
export type PreflightClarificationAnswerSource = "option" | "else" | "skip";
export type PreflightClarificationAnswerValue = string | string[] | boolean;

export interface PreflightClarificationQuestion {
  id: string;
  question: string;
  type: PreflightClarificationQuestionType;
  options: string[];
  allowElse: boolean;
  elseLabel: string;
  elsePlaceholder: string;
  required: boolean;
}

export interface PreflightClarificationResult {
  needsClarification: boolean;
  reason: string;
  title: string;
  description: string;
  questions: PreflightClarificationQuestion[];
}

export interface PreflightClarificationAnswer {
  questionId: string;
  question?: string;
  source: PreflightClarificationAnswerSource;
  value?: PreflightClarificationAnswerValue;
}

export interface PendingPreflightClarification {
  id: string;
  originalUserMessage: string;
  attachments: ClientAttachment[];
  result: PreflightClarificationResult;
}

export interface PreflightClarificationContext {
  originalUserMessage: string;
  answers: PreflightClarificationAnswer[];
  skipped?: boolean;
}

const NO_CLARIFY_RE = /\b(don't ask|do not ask|no questions|without asking|best assumption|make assumptions|assume|just answer|quick answer)\b/i;
const SIMPLE_MATH_RE = /(?:^|\b)\d+(?:\.\d+)?\s*(?:\+|-|\*|x|×|\/|÷)\s*\d+(?:\.\d+)?(?:\b|$)/i;
const CODE_OR_ERROR_RE = /(```|stack trace|traceback|typeerror|referenceerror|syntaxerror|error:|exception|failed|bug|fix this|here'?s my code)/i;

function clean(value: unknown, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return fallback;
  return String(value).replace(/\s+/g, " ").trim().slice(0, 600) || fallback;
}

function wordCount(message: string): number {
  return message.trim().split(/\s+/).filter(Boolean).length;
}

export function noPreflightClarification(reason: string): PreflightClarificationResult {
  return { needsClarification: false, reason, title: "", description: "", questions: [] };
}

/**
 * Cheap, deterministic gates that skip the AI triage entirely. Anything that
 * passes these goes to the triage model (preflight-triage.ts), which makes the
 * actual "is a question worth asking?" decision. These only catch cases where
 * asking is obviously wrong, so the user never pays triage latency for them.
 */
export function quickPreflightSkip(input: { message: string; hasAttachments?: boolean }): string | null {
  const message = input.message.trim();
  if (!message) return "Empty message.";
  if (NO_CLARIFY_RE.test(message)) return "User asked Juno to answer without clarification.";
  if (input.hasAttachments || CODE_OR_ERROR_RE.test(message)) return "The request includes concrete context.";
  if (SIMPLE_MATH_RE.test(message) && wordCount(message) <= 12) return "Simple direct question.";
  // Character-based, not word-based: CJK and Thai messages don't use spaces,
  // so a real request would count as "one word" and be wrongly skipped.
  if (message.length <= 8) return "Too short to need clarification — answer directly.";
  if (message.length > 2000) return "Long, detailed request — it already carries its own context.";
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isQuestion(value: unknown): value is PreflightClarificationQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as Record<string, unknown>;
  return (
    typeof q.id === "string" &&
    typeof q.question === "string" &&
    (q.type === "single-choice" || q.type === "multi-choice" || q.type === "text" || q.type === "text-long") &&
    isStringArray(q.options) &&
    typeof q.allowElse === "boolean" &&
    typeof q.elseLabel === "string" &&
    typeof q.elsePlaceholder === "string" &&
    typeof q.required === "boolean"
  );
}

export function isPreflightClarificationResult(value: unknown): value is PreflightClarificationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resultValue = value as Record<string, unknown>;
  if (typeof resultValue.needsClarification !== "boolean") return false;
  if (typeof resultValue.reason !== "string") return false;
  if (typeof resultValue.title !== "string" || typeof resultValue.description !== "string") return false;
  if (!Array.isArray(resultValue.questions) || !resultValue.questions.every(isQuestion)) return false;
  return !resultValue.needsClarification || resultValue.questions.length > 0;
}

function answerValueToText(value: PreflightClarificationAnswerValue | undefined): string {
  if (Array.isArray(value)) return value.map((item) => clean(item)).filter(Boolean).join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return clean(value);
}

export function formatPreflightClarificationModelMessage(payload: PreflightClarificationContext): string {
  const original = payload.originalUserMessage.trim();
  const answered = payload.answers.filter((answer) => answer.source !== "skip" && answerValueToText(answer.value));
  const skipped = payload.skipped || payload.answers.some((answer) => answer.source === "skip");
  const lines = [
    "Original user request:",
    original || "(No original request provided.)",
    "",
  ];

  if (answered.length) {
    lines.push("The user answered these pre-answer clarification questions:");
    for (const answer of answered) {
      const label = answer.question ?? answer.questionId;
      const source = answer.source === "else" ? "custom" : "option";
      lines.push(`- ${label}: ${answerValueToText(answer.value)} (${source})`);
    }
  } else if (skipped) {
    lines.push("The user skipped pre-answer clarification. Make reasonable assumptions and answer directly.");
  } else {
    lines.push("No pre-answer clarification answers were provided. Answer directly.");
  }

  lines.push("");
  lines.push("Now answer the original request using these answers. Do not repeat the clarification questions.");
  return lines.join("\n");
}
