import type { ModelInfo } from "@/lib/models";
import { estimateGenerationCostUsd, normalizeUsage, type GenerationCostOpts } from "@/lib/pricing";

/**
 * A tool turn is several provider requests. Long-context surcharges and the
 * served speed tier apply to each request, never to their cumulative tokens.
 * Reconcile the request receipts before using them: an interrupted adapter
 * can have emitted usage without closing its request meter. In that case the
 * aggregate estimate remains the fallback, retaining any verified premium
 * already consumed by completed requests.
 *
 * Only server-side adapter receipts reach this function. A caller-supplied
 * dollar figure cannot stand in for the token buckets being reconciled here.
 */
export function estimateTurnCostUsd(
  model: ModelInfo,
  total: GenerationCostOpts,
  requests?: readonly GenerationCostOpts[]
): ReturnType<typeof estimateGenerationCostUsd> {
  const fallback = estimateGenerationCostUsd(model, total);
  if (!requests?.length) return fallback;

  const counts = [
    "promptTokens", "completionTokens", "reasoningTokens", "totalTokens",
    "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h",
    "webSearchRequests", "xSearchRequests", "toolFeesUsd",
    "promptChars", "completionChars", "reasoningChars",
  ] as const;
  const receipts = requests.filter((request) => !counts.some((key) => {
    const value = request[key];
    return value != null && (!Number.isFinite(value) || value < 0);
  }));
  if (!receipts.length) return fallback;

  const priced = receipts.map((request) => estimateGenerationCostUsd(model, {
    ...request,
    fastMode: request.fastMode ?? total.fastMode,
    batch: request.batch ?? total.batch,
  }));
  const sum = (select: (request: GenerationCostOpts) => number) =>
    receipts.reduce((value, request) => value + select(request), 0);
  const input = priced.reduce((value, request) => value + request.promptTokens, 0);
  const output = priced.reduce((value, request) => value + request.completionTokens, 0);
  const normaliseCache = (request: GenerationCostOpts) => normalizeUsage(model.provider, {
    cacheRead: request.cacheRead ?? undefined,
    cacheWrite: request.cacheWrite ?? undefined,
    cacheWrite5m: request.cacheWrite5m ?? undefined,
    cacheWrite1h: request.cacheWrite1h ?? undefined,
  });
  const aggregateCache = normaliseCache(total);
  // Output may be higher when separate reasoning-only requests were lifted
  // individually. It must never fall below the aggregate's character floor.
  const covered = receipts.length === requests.length &&
    input === fallback.promptTokens && output >= fallback.completionTokens &&
    (["cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h"] as const).every(
      (key) => sum((request) => normaliseCache(request)[key]) === aggregateCache[key]
    ) &&
    (["webSearchRequests", "xSearchRequests", "toolFeesUsd"] as const).every(
      (key) => sum((request) => request[key] ?? 0) === (total[key] ?? 0)
    );
  const knownCost = priced.reduce((value, request) => value + request.costUsd, 0);
  const knownToolFees = priced.reduce((value, request) => value + request.toolFeesUsd, 0);
  if (!covered) {
    // The final tier cannot erase a premium paid by an earlier request. Keep
    // the aggregate estimate for unmatched usage and add only known positive
    // tier differences. Cheaper receipts cannot discount incomplete coverage,
    // and no missing request boundary or cache allocation is guessed here.
    const knownPremium = priced.reduce((value, request, index) => value + Math.max(
      0,
      request.costUsd - estimateGenerationCostUsd(model, {
        ...receipts[index],
        fastMode: total.fastMode ?? false,
        batch: total.batch ?? false,
      }).costUsd
    ), 0);
    return {
      ...fallback,
      costUsd: Math.max(fallback.costUsd + knownPremium, knownCost),
      toolFeesUsd: Math.max(fallback.toolFeesUsd, knownToolFees),
    };
  }

  return {
    costUsd: knownCost,
    promptTokens: input,
    completionTokens: output,
    cacheRead: aggregateCache.cacheRead,
    toolFeesUsd: knownToolFees,
  };
}
