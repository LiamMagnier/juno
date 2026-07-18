/**
 * Merge provider usage events without undercounting.
 *
 * Anthropic (and others) stream partial usage: message_start often has input +
 * cache, message_delta often has only output_tokens — and some hosts emit
 * input_tokens:0 on intermediate deltas. Taking the last event wholesale or
 * treating 0 as authoritative wiped real prompt/cache counts and produced
 * absurd message costs like "~$0.0006" for a full Claude turn.
 */

export type UsageAccumulator = {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearchRequests?: number;
  xSearchRequests?: number;
  fast?: boolean;
};

/** Keep the higher of two non-negative token counts; ignore null/undefined. */
function preferHigher(prev: number | undefined, next: number | undefined | null): number | undefined {
  if (next == null || !Number.isFinite(next)) return prev;
  const n = Math.max(0, Math.floor(next));
  if (prev == null) return n;
  // Never let a partial 0/low wipe a previously observed real total.
  return Math.max(prev, n);
}

/**
 * Fold one usage event into an accumulator. Token-like fields take the max;
 * `fast` is sticky once true (or set explicitly when provided).
 */
export function mergeUsage(acc: UsageAccumulator, ev: UsageAccumulator): UsageAccumulator {
  return {
    input: preferHigher(acc.input, ev.input),
    output: preferHigher(acc.output, ev.output),
    reasoning: preferHigher(acc.reasoning, ev.reasoning),
    total: preferHigher(acc.total, ev.total),
    cacheRead: preferHigher(acc.cacheRead, ev.cacheRead),
    cacheWrite: preferHigher(acc.cacheWrite, ev.cacheWrite),
    cacheWrite5m: preferHigher(acc.cacheWrite5m, ev.cacheWrite5m),
    cacheWrite1h: preferHigher(acc.cacheWrite1h, ev.cacheWrite1h),
    webSearchRequests: preferHigher(acc.webSearchRequests, ev.webSearchRequests),
    xSearchRequests: preferHigher(acc.xSearchRequests, ev.xSearchRequests),
    fast: ev.fast != null ? ev.fast : acc.fast,
  };
}

/** Total input tokens for display/storage: fresh + cache read + cache write. */
export function totalInputTokens(u: UsageAccumulator): number {
  const writeSplit = (u.cacheWrite5m ?? 0) + (u.cacheWrite1h ?? 0);
  const write = writeSplit > 0 ? writeSplit : (u.cacheWrite ?? 0);
  return Math.max(0, u.input ?? 0) + Math.max(0, u.cacheRead ?? 0) + write;
}
