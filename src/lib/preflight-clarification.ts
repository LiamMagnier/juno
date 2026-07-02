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
const SIMPLE_FACT_RE = /^(what|who|when|where|define|translate|summari[sz]e)\b/i;
const SIMPLE_MATH_RE = /(?:^|\b)\d+(?:\.\d+)?\s*(?:\+|-|\*|x|×|\/|÷)\s*\d+(?:\.\d+)?(?:\b|$)/i;
const CODE_OR_ERROR_RE = /(```|stack trace|traceback|typeerror|referenceerror|syntaxerror|error:|exception|failed|bug|fix this|here'?s my code)/i;

function clean(value: unknown, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return fallback;
  return String(value).replace(/\s+/g, " ").trim().slice(0, 600) || fallback;
}

function wordCount(message: string): number {
  return message.trim().split(/\s+/).filter(Boolean).length;
}

function question(input: {
  id: string;
  question: string;
  options?: string[];
  type?: PreflightClarificationQuestionType;
  allowElse?: boolean;
  elseLabel?: string;
  elsePlaceholder?: string;
  required?: boolean;
}): PreflightClarificationQuestion {
  return {
    id: input.id,
    question: input.question,
    type: input.type ?? "single-choice",
    options: (input.options ?? []).slice(0, 5),
    allowElse: input.allowElse ?? true,
    elseLabel: input.elseLabel ?? "Something else",
    elsePlaceholder: input.elsePlaceholder ?? "Type your own answer...",
    required: input.required ?? false,
  };
}

function result(input: {
  reason: string;
  title?: string;
  description?: string;
  questions: PreflightClarificationQuestion[];
}): PreflightClarificationResult {
  return {
    needsClarification: true,
    reason: input.reason,
    title: input.title ?? "Customize your answer",
    description: input.description ?? "Choose the closest option, type your own answer, or skip.",
    questions: input.questions.slice(0, 2),
  };
}

export function noPreflightClarification(reason: string): PreflightClarificationResult {
  return { needsClarification: false, reason, title: "", description: "", questions: [] };
}

export function maybeRequestClarification(input: {
  message: string;
  hasAttachments?: boolean;
  previousMessages?: Array<{ role: "USER" | "ASSISTANT"; content: string }>;
}): PreflightClarificationResult {
  const message = input.message.trim();
  const lower = message.toLowerCase();
  if (!message) return noPreflightClarification("Empty message.");
  if (NO_CLARIFY_RE.test(message)) return noPreflightClarification("User asked Juno to answer without clarification.");
  if (input.hasAttachments || CODE_OR_ERROR_RE.test(message)) return noPreflightClarification("The request includes concrete context.");
  if (SIMPLE_MATH_RE.test(message) && wordCount(message) <= 12) return noPreflightClarification("Simple direct question.");
  if (SIMPLE_FACT_RE.test(message) && wordCount(message) <= 16 && !/\b(explain|teach|learn|walk me through|how .*work)\b/i.test(message)) {
    return noPreflightClarification("Simple factual question.");
  }

  if (/\b(explain|teach|learn|walk me through|how do|how does|how .*work|tutorial)\b/i.test(message)) {
    if (/\b(llm|llms|ai|machine learning|ml|neural network|transformer|api|architecture|system design|database|react|next\.?js|typescript|python)\b/i.test(message)) {
      return result({
        reason: "Learning request where depth changes the answer.",
        title: "Tune the explanation",
        questions: [
          question({
            id: "depth",
            question: "What level of depth should Juno use?",
            options: ["High-level overview", "Technical walkthrough", "Code-level breakdown"],
            elsePlaceholder: "Example: visual analogies first, then technical details...",
          }),
        ],
      });
    }
  }

  if (/\b(build|create|make|design)\b/i.test(message) && /\b(portfolio|website|landing page|app|dashboard|saas|tool)\b/i.test(message)) {
    if (/\bportfolio\b/i.test(message)) {
      return result({
        reason: "Broad portfolio request without style or goal.",
        title: "Shape the portfolio",
        questions: [
          question({
            id: "portfolio_direction",
            question: "What direction should Juno optimize the portfolio for?",
            options: ["Developer portfolio with projects", "Designer or creative portfolio", "Personal brand portfolio", "Business or services portfolio"],
            elsePlaceholder: "Describe the audience, style, platform, or goal...",
          }),
        ],
      });
    }
    return result({
      reason: "Large build request with open scope.",
      title: "Clarify the scope",
      questions: [
        question({
          id: "scope",
          question: "What should Juno focus on first?",
          options: ["Fast prototype", "Polished UI", "Full feature implementation", "Architecture plan"],
          elsePlaceholder: "Describe the first version you want...",
        }),
      ],
    });
  }

  if (/\b(recommend|best|which should i choose|pick|compare)\b/i.test(message) && !/\b(budget|price|style|location|use case|criteria)\b/i.test(lower)) {
    return result({
      reason: "Recommendation request without preferences.",
      title: "Set recommendation criteria",
      questions: [
        question({
          id: "criteria",
          question: "What should matter most in the recommendation?",
          options: ["Best overall", "Lowest cost", "Easiest to use", "Most powerful"],
          elsePlaceholder: "Tell Juno your criteria, constraints, or preferences...",
        }),
      ],
    });
  }

  if (/\b(write|draft|rewrite|email|blog|post|copy|caption|essay)\b/i.test(message) && !/\b(tone|audience|formal|casual|short|long|length|style)\b/i.test(lower)) {
    return result({
      reason: "Writing request without audience or tone.",
      title: "Tune the writing",
      questions: [
        question({
          id: "writing_style",
          question: "What tone should Juno write in?",
          options: ["Clear and professional", "Warm and conversational", "Short and direct", "Persuasive and polished"],
          elsePlaceholder: "Describe the tone, audience, or length...",
        }),
      ],
    });
  }

  if (/\b(debug|fix|why is|not working|broken)\b/i.test(message) && !CODE_OR_ERROR_RE.test(message)) {
    return result({
      reason: "Debugging request without stack or expected behavior.",
      title: "Narrow the debugging target",
      questions: [
        question({
          id: "debug_context",
          question: "What context can you share first?",
          options: ["Error message", "Relevant code", "Expected vs actual behavior", "Environment or framework"],
          elsePlaceholder: "Paste or describe the missing debugging context...",
        }),
      ],
    });
  }

  return noPreflightClarification("The request can be answered directly.");
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
