/**
 * A rejected request is not missing token telemetry. In particular, converting
 * a 401 or a 429 into chars/4 invents a charge for a request the provider did
 * not accept. Only explicit HTTP rejections before ANY provider event qualify;
 * a timeout, disconnect or partly consumed stream remains conservatively billed.
 * Message text is deliberately ignored: "429" in an arbitrary exception is
 * not evidence that an HTTP request was rejected.
 */
export function isUnconsumedProviderRejection(
  error: unknown,
  observed: { receivedEvent: boolean; aborted: boolean },
): boolean {
  if (observed.receivedEvent || observed.aborted || typeof error !== "object" || error === null) return false;
  const e = error as { status?: unknown; statusCode?: unknown };
  const status = typeof e.status === "number" ? e.status : e.statusCode;
  if (typeof status !== "number") return false;
  // 408/409/5xx can follow accepted work; do not treat them as free. The SDKs
  // and GeminiProviderError expose their HTTP rejection status at this level.
  return [400, 401, 402, 403, 404, 413, 422, 429].includes(status);
}
