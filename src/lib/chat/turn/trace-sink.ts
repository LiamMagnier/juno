import "server-only";
import { logSync } from "@/lib/logger";
import { observability } from "@/lib/observability";
import type { TurnTrace } from "./trace";

/*
 * Where a finished turn's trace goes (BRIEF §47), through what the repo
 * already has:
 *
 *  - `logSync("info" | "warn", "chat.turn", …)` — the structured JSON line PM2
 *    captures (src/lib/logger.ts), grep-then-jq-able and shipper-ready;
 *  - `observability.recordLatency` — the in-process model performance
 *    collector (src/lib/observability.ts), so per-model success rate and p95
 *    latency/TTFT come from real turns;
 *  - a bounded in-process ring buffer read by the owner-only diagnostics page
 *    (/admin/turns). Per process and lost on restart: a live window for an
 *    operator, not a ledger. The spend ledger and the durable receipt remain
 *    the records of truth.
 */

const RING_SIZE = 200;
const ring: TurnTrace[] = [];

export function emitTurnTrace(trace: TurnTrace): void {
  ring.push(trace);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  logSync(trace.outcome === "failed" ? "warn" : "info", "chat.turn", { ...trace });
  observability.recordLatency({
    requestId: trace.requestId ?? undefined,
    operation: `chat.${trace.surface}`,
    durationMs: trace.latency.totalMs,
    ttftMs: trace.latency.ttftMs ?? undefined,
    modelId: trace.model,
    provider: trace.provider,
    success: trace.outcome !== "failed",
    errorCode: trace.failureCode ?? undefined,
    tokensIn: trace.usage.promptTokens ?? undefined,
    tokensOut: trace.usage.completionTokens ?? undefined,
  });
}

/** The most recent turns this process finished, newest first. */
export function recentTurnTraces(limit = RING_SIZE): TurnTrace[] {
  return ring.slice(-limit).reverse();
}

/** Per-model latency/success from the same collector, for the diagnostics page. */
export function modelPerformance() {
  return observability.getAllModelSnapshots();
}
