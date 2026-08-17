/**
 * Juno Production Observability and Metrics Service
 *
 * Captures privacy-preserving operational metrics across LLM requests,
 * Work runs, tool executions, native sync, and latency percentiles.
 * Never records raw prompts, tokens containing PII, or sensitive payloads.
 */

export interface MetricEvent {
  metric: string;
  value: number;
  tags?: Record<string, string | number | boolean>;
  timestamp?: number;
}

export interface LatencyRecord {
  requestId?: string;
  operation: string;
  durationMs: number;
  ttftMs?: number;
  modelId?: string;
  provider?: string;
  success: boolean;
  errorCode?: string;
  toolName?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ModelPerformanceSnapshot {
  modelId: string;
  provider: string;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  avgTtftMs: number;
  p95LatencyMs: number;
  p95TtftMs: number;
  lastUpdated: string;
}

class MetricsCollector {
  private latencies: LatencyRecord[] = [];
  private readonly maxRecords = 5000;

  public recordLatency(record: LatencyRecord): void {
    const sanitizedRecord: LatencyRecord = {
      ...record,
      durationMs: Math.max(0, record.durationMs),
      ttftMs: record.ttftMs !== undefined ? Math.max(0, record.ttftMs) : undefined,
    };

    this.latencies.push(sanitizedRecord);

    if (this.latencies.length > this.maxRecords) {
      this.latencies.splice(0, this.latencies.length - this.maxRecords);
    }

    if (process.env.NODE_ENV === "production") {
      this.emitStructuredLog("latency", sanitizedRecord.durationMs, {
        operation: sanitizedRecord.operation,
        model: sanitizedRecord.modelId || "none",
        provider: sanitizedRecord.provider || "none",
        success: sanitizedRecord.success,
        ttftMs: sanitizedRecord.ttftMs || 0,
        reqId: sanitizedRecord.requestId || "unknown",
      });
    }
  }

  public recordMetric(metric: string, value: number, tags: Record<string, string | number | boolean> = {}): void {
    this.emitStructuredLog(metric, value, tags);
  }

  private emitStructuredLog(metric: string, value: number, tags: Record<string, string | number | boolean>): void {
    const line = JSON.stringify({
      _juno_metric: true,
      metric,
      value,
      tags,
      timestamp: Date.now(),
      version: "1.2.0",
    });
    if (process.env.NODE_ENV === "production") {
      console.log(line);
    }
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[index];
  }

  public getModelPerformance(modelId: string): ModelPerformanceSnapshot | null {
    const relevant = this.latencies.filter((l) => l.modelId === modelId);
    if (relevant.length === 0) return null;

    const successes = relevant.filter((l) => l.success).length;
    const durations = relevant.map((l) => l.durationMs);
    const ttfts = relevant.map((l) => l.ttftMs).filter((t): t is number => t !== undefined);

    const avgLatency = durations.reduce((acc, d) => acc + d, 0) / durations.length;
    const avgTtft = ttfts.length > 0 ? ttfts.reduce((acc, t) => acc + t, 0) / ttfts.length : 0;

    return {
      modelId,
      provider: relevant[0].provider || "unknown",
      requests: relevant.length,
      successRate: successes / relevant.length,
      avgLatencyMs: Math.round(avgLatency),
      avgTtftMs: Math.round(avgTtft),
      p95LatencyMs: Math.round(this.percentile(durations, 95)),
      p95TtftMs: Math.round(this.percentile(ttfts, 95)),
      lastUpdated: new Date().toISOString(),
    };
  }

  public getAllModelSnapshots(): ModelPerformanceSnapshot[] {
    const models = Array.from(new Set(this.latencies.map((l) => l.modelId).filter(Boolean))) as string[];
    return models
      .map((id) => this.getModelPerformance(id))
      .filter((s): s is ModelPerformanceSnapshot => s !== null);
  }
}

export const observability = new MetricsCollector();
