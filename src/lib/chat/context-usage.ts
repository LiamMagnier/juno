import type { ProviderRequestRecord } from "@/lib/llm/request-meter";
import type { ClientActivityEvent } from "@/types/chat";
import type { RunFact } from "@/types/run";

export type ContextUsage = Extract<RunFact, { key: "context_usage" }>;

/** Use normalized usage for one successful provider request. Turn totals can include several prompts. */
export function requestContextUsage(request: ProviderRequestRecord | null, windowTokens: number): ContextUsage | null {
  if (!request?.ok || !request.usageReported) return null;
  const { totalInput, cacheRead } = request.tokens;
  if (!Number.isSafeInteger(totalInput) || totalInput <= 0 || !Number.isSafeInteger(windowTokens) || windowTokens <= 0) return null;
  const cachedTokens = request.cacheReadReported ? Math.min(totalInput, cacheRead) : null;
  return { key: "context_usage", inputTokens: totalInput, cachedTokens, windowTokens };
}

export function contextUsageFrom(activity: readonly ClientActivityEvent[] | null | undefined): ContextUsage | null {
  if (!activity) return null;
  for (let i = activity.length - 1; i >= 0; i--) {
    const fact = activity[i].fact;
    if (fact?.key === "context_usage") return fact;
  }
  return null;
}
