import type { ChatFinishReason } from "@/types/chat";

export function normalizeFinishReason(reason: unknown): ChatFinishReason {
  const value = String(reason ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value === "stop" || value === "end_turn" || value === "complete") return "stop";
  if (value === "length" || value === "max_tokens" || value === "max_output_tokens") return "length";
  if (value === "tool_calls" || value === "tool_use") return "tool_calls";
  if (value === "sensitive" || value === "content_filter" || value === "safety") return "sensitive";
  if (value === "model_context_window_exceeded" || value === "context_length_exceeded") return "model_context_window_exceeded";
  if (value === "network_error" || value === "network") return "network_error";
  if (value === "user_stopped" || value === "cancelled" || value === "canceled" || value === "abort") return "user_stopped";
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
