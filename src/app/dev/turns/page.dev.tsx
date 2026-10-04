import { notFound } from "next/navigation";
import { TurnsAdmin } from "@/components/admin/turns-admin";
import { createTurnTrace, type TurnTrace, type TurnTraceStart } from "@/lib/chat/turn/trace";

/**
 * Dev-only gallery for the owner Turns diagnostics (/admin/turns), over
 * traces built by the real recorder: a completed tool-using turn, a rate
 * limited one, a stop, a stall and a private turn. Not linked; 404s in
 * production.
 */
function fixture(start: Partial<TurnTraceStart>, steps: (trace: ReturnType<typeof createTurnTrace>) => TurnTrace | null): TurnTrace {
  let t = Date.parse("2026-10-04T10:00:00Z");
  const base: TurnTraceStart = {
    runId: `gen-${Math.random().toString(16).slice(2, 10)}`,
    requestId: `req-${Math.random().toString(16).slice(2, 10)}`,
    accountId: "cmuser0001",
    conversationId: "cmconv0001",
    surface: "saved",
    client: "web",
    agentId: null,
    model: { id: "claude-sonnet-5", provider: "anthropic" },
    requestedModel: "claude-sonnet-5",
    rerouted: false,
    reasoningEffort: "medium",
    features: { webSearch: false, research: false, connectors: 0, actingTools: 0, skill: false, artifactEdit: false, regenerate: false },
    ...start,
  };
  const trace = createTurnTrace(base, () => {}, () => (t += 700));
  return steps(trace)!;
}

export default function TurnsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const traces = [
    fixture({ features: { webSearch: false, research: false, connectors: 1, actingTools: 1, skill: false, artifactEdit: false, regenerate: false } }, (trace) => {
      trace.observe({ kind: "tool_call", server: "GitHub", name: "search_issues", callId: "a" });
      trace.observe({ kind: "text", text: "x", startedWriting: true });
      trace.observe({ kind: "tool_result", server: "GitHub", name: "search_issues", callId: "a", result: "", ok: true, durationMs: 840 });
      trace.noteApproval();
      return trace.finish({ finishReason: "stop", outcome: "completed", usage: { promptTokens: 4120, completionTokens: 612, cacheReadTokens: 3800, costUsd: 0.0187 } });
    }),
    fixture({ model: { id: "gpt-5.6", provider: "openai" }, requestedModel: "juno:auto", rerouted: true }, (trace) =>
      trace.finish({
        finishReason: "error",
        outcome: "failed",
        failureCode: "GENERATION_FAILED",
        error: Object.assign(new Error("429"), { status: 429 }),
      })
    ),
    fixture({}, (trace) => {
      trace.observe({ kind: "text", text: "x", startedWriting: true });
      return trace.finish({ finishReason: "user_stopped", outcome: "partial", cancellation: { userStopped: true }, usage: { promptTokens: 900, completionTokens: 80, costUsd: 0.002 } });
    }),
    fixture({ model: { id: "gemini-3-pro", provider: "google" } }, (trace) =>
      trace.finish({ finishReason: "error", outcome: "failed", failureCode: "GENERATION_FAILED", cancellation: { stalled: true } })
    ),
    fixture({ surface: "private", conversationId: null }, (trace) => {
      trace.observe({ kind: "text", text: "x", startedWriting: true });
      return trace.finish({ finishReason: "stop", outcome: "completed", usage: { promptTokens: 300, completionTokens: 120, costUsd: 0.0009 } });
    }),
  ];
  const models = [
    { modelId: "claude-sonnet-5", provider: "anthropic", requests: 41, successRate: 0.976, avgLatencyMs: 5200, avgTtftMs: 900, p95LatencyMs: 14800, p95TtftMs: 2100, lastUpdated: "" },
    { modelId: "gpt-5.6", provider: "openai", requests: 9, successRate: 0.778, avgLatencyMs: 7100, avgTtftMs: 1300, p95LatencyMs: 22100, p95TtftMs: 4200, lastUpdated: "" },
  ];
  return <TurnsAdmin traces={traces} models={models} />;
}
