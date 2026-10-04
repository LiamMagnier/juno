import { AdminNav } from "@/components/admin/admin-nav";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import type { TurnTrace } from "@/lib/chat/turn/trace";
import type { ModelPerformanceSnapshot } from "@/lib/observability";

/*
 * Chat turn diagnostics: what each recent turn did, in the trace's own
 * redacted terms (ids, model, timings, tool names, counts, outcome). A plain
 * ledger — hairlines, mono annotations, no status chips — because an operator
 * reads it row by row, and because the trace holds no content to show.
 */

function ms(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

function cancellationNote(trace: TurnTrace): string | null {
  const c = trace.cancellation;
  const parts = [
    c.userStopped && "stopped by user",
    c.budgetHalted && "budget halt",
    c.stalled && "provider stalled",
    c.shutdown && "process shutdown",
    c.leaseLost && "lease lost",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function TurnRow({ trace }: { trace: TurnTrace }) {
  const tools = trace.toolCalls;
  const failedTools = tools.filter((call) => call.ok === false).length;
  const cancellation = cancellationNote(trace);
  return (
    <li className="grid gap-1 border-b border-border/60 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm text-foreground">
          {trace.outcome ?? "unfinished"}
          <span className="text-muted-foreground"> · {trace.finishReason ?? "—"}</span>
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {new Date(trace.startedAt).toLocaleTimeString("en-GB")} · {ms(trace.latency.totalMs)} total · first token{" "}
          {ms(trace.latency.ttftMs)}
        </span>
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        {trace.surface} · {trace.provider}/{trace.model}
        {trace.requestedModel ? ` (asked ${trace.requestedModel})` : ""}
        {trace.reasoningEffort ? ` · ${trace.reasoningEffort}` : ""} · {trace.usage.promptTokens ?? "—"} in /{" "}
        {trace.usage.completionTokens ?? "—"} out · {usd(trace.usage.costUsd)}
      </div>
      {(tools.length > 0 || trace.approvals > 0) && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {tools.length} tool call{tools.length === 1 ? "" : "s"}
          {failedTools ? ` (${failedTools} failed)` : ""}: {tools.map((call) => call.name).join(", ") || "—"}
          {trace.approvals ? ` · ${trace.approvals} approval${trace.approvals === 1 ? "" : "s"} asked` : ""}
        </div>
      )}
      {(trace.error || trace.failureCode || cancellation) && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {[
            trace.failureCode,
            trace.error && `${trace.error.class}${trace.error.status ? ` ${trace.error.status}` : ""}${trace.error.retryable ? " (retryable)" : ""}`,
            cancellation,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      <div className="font-mono text-[11px] text-muted-foreground/70">
        run {trace.runId}
        {trace.requestId ? ` · request ${trace.requestId}` : ""} · account {trace.accountId}
        {trace.conversationId ? ` · chat ${trace.conversationId}` : ""}
      </div>
    </li>
  );
}

export function TurnsAdmin({ traces, models }: { traces: TurnTrace[]; models: ModelPerformanceSnapshot[] }) {
  return (
    <AppPage measure="wide" contentClassName="flex flex-col gap-8">
      <AppPageHeader
        className="mb-0"
        eyebrow="Owner"
        heading="Turns"
        lede="Recent chat turns on this server process, as their redacted traces. No message text is recorded."
        actions={<AdminNav current="turns" />}
      />

      <section aria-labelledby="models-heading" className="grid gap-2">
        <h2 id="models-heading" className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          By model
        </h2>
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">No turns have finished on this process since it started.</p>
        ) : (
          <ul className="border-t border-border/60">
            {models.map((model) => (
              <li
                key={model.modelId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-border/60 py-2"
              >
                <span className="text-sm">{model.provider}/{model.modelId}</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {model.requests} turns · {Math.round(model.successRate * 100)}% ok · p95 {ms(model.p95LatencyMs)} · p95
                  first token {ms(model.p95TtftMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="turns-heading" className="grid gap-2">
        <h2 id="turns-heading" className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          Latest {traces.length} turns
        </h2>
        {traces.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet. Traces are per process and start empty after a restart.</p>
        ) : (
          <ul className="border-t border-border/60">
            {traces.map((trace) => (
              <TurnRow key={`${trace.runId}-${trace.startedAt}`} trace={trace} />
            ))}
          </ul>
        )}
      </section>
    </AppPage>
  );
}
