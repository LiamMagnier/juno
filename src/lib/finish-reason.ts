import type { ChatFinishReason } from "@/types/chat";

/**
 * Names a provider can end a turn with, grouped by what the UI must then say.
 *
 * Every value below is one a provider Juno ships actually sends. Gemini alone
 * has ten terminal reasons and only three of them were recognised, so an answer
 * Google BLOCKED (`RECITATION`, `PROHIBITED_CONTENT`, `SPII`…) rendered as
 * "Stream ended unexpectedly / the provider closed the stream without a
 * recognized finish reason" — a transport story told about a safety decision.
 */
const SENSITIVE = new Set([
  "sensitive",
  "content_filter",
  "safety",
  // Gemini
  "recitation",
  "blocklist",
  "prohibited_content",
  "spii",
  "image_safety",
  // Anthropic
  "refusal",
]);

const LENGTH = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  // Gemini stops here when the model exhausts its server-side tool budget:
  // the turn is incomplete in exactly the way Continue exists for.
  "too_many_tool_calls",
]);

const TOOL_CALLS = new Set([
  "tool_calls",
  "tool_use",
  "function_call",
  // Anthropic's "I paused a long server-tool turn, send it back to me": the
  // turn is unfinished and continues with another request, which is what the
  // tool_calls branch already means to every caller.
  "pause_turn",
  // Gemini: the model asked for a tool the request did not declare.
  "unexpected_tool_call",
]);

export function normalizeFinishReason(reason: unknown): ChatFinishReason {
  const value = String(reason ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value === "stop" || value === "end_turn" || value === "complete" || value === "stop_sequence") return "stop";
  if (LENGTH.has(value)) return "length";
  if (TOOL_CALLS.has(value)) return "tool_calls";
  if (SENSITIVE.has(value)) return "sensitive";
  if (value === "model_context_window_exceeded" || value === "context_length_exceeded") return "model_context_window_exceeded";
  if (value === "network_error" || value === "network") return "network_error";
  if (value === "user_stopped" || value === "cancelled" || value === "canceled" || value === "abort") return "user_stopped";
  // DELIBERATELY unknown, not merely unmapped: Gemini's MALFORMED_FUNCTION_CALL,
  // LANGUAGE and OTHER describe a turn that ended for a reason Juno cannot
  // honestly restate as stop / length / safety, and guessing one of those would
  // put words in the provider's mouth. `tests/finish-reason.test.ts` pins the
  // full published enums so a NEW provider value can never quietly land here.
  return "unknown";
}

export function finishReasonTitle(reason: ChatFinishReason): string {
  switch (reason) {
    case "length":
      return "Response hit the token limit";
    case "network_error":
      return "Stream interrupted";
    case "model_context_window_exceeded":
      return "Context window exceeded";
    case "sensitive":
      return "Response stopped by safety filter";
    case "tool_calls":
      return "Tool call requested";
    case "user_stopped":
      return "Stopped by user";
    case "error":
      return "Generation failed";
    case "unknown":
      return "Stream ended unexpectedly";
    case "stop":
    default:
      return "Finished response";
  }
}

export function finishReasonDetail(reason: ChatFinishReason): string | undefined {
  switch (reason) {
    case "length":
      return "Use Continue to ask the model to pick up from the partial answer.";
    case "network_error":
      return "The partial answer was preserved. You can retry or continue from here.";
    case "model_context_window_exceeded":
      return "The conversation or attachments exceeded the model context window.";
    case "sensitive":
      return "The provider stopped the response for safety reasons.";
    case "tool_calls":
      return "This app did not provide executable tools for this request, so the partial answer was saved.";
    case "user_stopped":
      return "The partial answer was preserved.";
    case "unknown":
      return "The provider closed the stream without a recognized finish reason.";
    default:
      return undefined;
  }
}
