import "server-only";
import { logSync } from "@/lib/logger";
import { observability } from "@/lib/observability";
import { summarizeTurnLatency, type TurnLatencySummary, type TurnTrace } from "./trace";

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
 *    the records of truth;
 *  - a failed saved-chat turn wakes the chat failure-rate watch
 *    (src/lib/router/failure-alert.ts), which counts from the durable
 *    `RoutingOutcome` rows, not from this ring, and mails the operator once
 *    per incident.
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
  // Private chats write no outcome row, so only a saved turn can move the
  // count. Loaded on the first failure: a healthy process never pays for it.
  if (trace.outcome === "failed" && trace.surface === "saved") {
    const note = { modelId: trace.model, errorClass: trace.error?.class ?? null };
    void import("@/lib/router/failure-alert")
      .then(({ chatFailureRateWatch }) => chatFailureRateWatch().noteFailedTurn(note))
      .catch(() => undefined);
  }
}

/**
 * Where the wait before the first token goes, over the turns this process
 * finished (the ring): server preparation and the person's wait, p50 and
 * p95 (`summarizeTurnLatency`). A live window, not the week of `chat.turn`
 * lines the owner measures from.
 */
export function turnLatencySummary(): TurnLatencySummary {
  return summarizeTurnLatency(ring);
}

/** The most recent turns this process finished, newest first. */
export function recentTurnTraces(limit = RING_SIZE): TurnTrace[] {
  return ring.slice(-limit).reverse();
}

/** Per-model latency/success from the same collector, for the diagnostics page. */
export function modelPerformance() {
  return observability.getAllModelSnapshots();
}
