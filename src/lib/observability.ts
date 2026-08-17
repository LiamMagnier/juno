/**
 * Juno Production Observability and Metrics Service
 *
 * Captures privacy-preserving operational metrics across LLM requests,
 * Work runs, tool executions, and latency percentiles.
 * Never records raw prompts, tokens containing PII, or sensitive payloads.
 */

export interface MetricEvent {
  metric: string;
  value: number;
  tags?: Record<string, string | number | boolean>;
  timestamp?: number;
}

export interface LatencyRecord {
  operation: string;
  durationMs: number;
  ttftMs?: number;
  modelId?: string;
  provider?: string;
  success: boolean;
  errorCode?: string;
}

export interface ModelPerformanceSnapshot {
  modelId: string;
  provider: string;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  avgTtftMs: number;
  lastUpdated: string;
}

// In-memory sliding window aggregation buffer
class MetricsCollector {
  private latencies: LatencyRecord[] = [];
  private readonly maxRecords = 2000;

  public recordLatency(record: LatencyRecord): void {
    this.latencies.push({
      ...record,
      durationMs: Math.max(0, record.durationMs),
    });

    if (this.latencies.length > this.maxRecords) {
      this.latencies.splice(0, this.latencies.length - this.maxRecords);
    }
  }

  public recordMetric(metric: string, value: number, tags: Record<string, string | number | boolean> = {}): void {
    // Log structured metric line for cloud log aggregation (Datadog/CloudWatch/Prometheus)
    if (process.env.NODE_ENV === "production") {
      console.log(JSON.stringify({
        _metric: true,
        metric,
        value,
        tags,
        timestamp: Date.now(),
      }));
    }
  }

  public getModelPerformance(modelId: string): ModelPerformanceSnapshot | null {
    const relevant = this.latencies.filter((l) => l.modelId === modelId);
    if (relevant.length === 0) return null;

    const successes = relevant.filter((l) => l.success).length;
    const avgLatency = relevant.reduce((acc, l) => acc + l.durationMs, 0) / relevant.length;
    const ttftRecords = relevant.filter((l) => l.ttftMs !== undefined);
    const avgTtft = ttftRecords.length > 0
      ? ttftRecords.reduce((acc, l) => acc + (l.ttftMs ?? 0), 0) / ttftRecords.length
      : 0;

    return {
      modelId,
      provider: relevant[0].provider || "unknown",
      requests: relevant.length,
      successRate: successes / relevant.length,
      avgLatencyMs: Math.round(avgLatency),
      avgTtftMs: Math.round(avgTtft),
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
