/**
 * @module monitoring/metrics
 * @description In-process metrics collection with Prometheus-compatible export.
 * Tracks execution counts, durations, error rates, and cache performance.
 */

import { ExecutionMetrics } from '../core/types';

interface Counter {
  value: number;
  labels: Record<string, string>;
}
interface Histogram {
  buckets: Map<number, number>;
  sum: number;
  count: number;
  labels: Record<string, string>;
}

export class MetricsCollector {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, number>();

  private static readonly DURATION_BUCKETS = [
    10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
  ];

  // ── Recording ─────────────────────────────────────────────────────────────

  recordExecution(skillId: string, metrics: ExecutionMetrics): void {
    this.increment(`skill_executions_total`, { skill_id: skillId, status: 'success' });
    this.observeHistogram(`skill_duration_ms`, metrics.durationMs, { skill_id: skillId });

    if (metrics.retryCount > 0) {
      this.add(`skill_retries_total`, metrics.retryCount, { skill_id: skillId });
    }
    if (metrics.cacheHits > 0) {
      this.increment(`skill_cache_hits_total`, { skill_id: skillId });
    }
    if (metrics.apiCallCount > 0) {
      this.add(`skill_api_calls_total`, metrics.apiCallCount, { skill_id: skillId });
    }
    if (metrics.tokenUsage) {
      this.add(`llm_tokens_total`, metrics.tokenUsage.totalTokens, { skill_id: skillId });
    }
  }

  recordError(skillId: string, errorCode: string): void {
    this.increment(`skill_errors_total`, { skill_id: skillId, error_code: errorCode });
  }

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = this.buildKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value++;
    } else {
      this.counters.set(key, { value: 1, labels });
    }
  }

  add(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.buildKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.counters.set(key, { value, labels });
    }
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.buildKey(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, {
        buckets: new Map(MetricsCollector.DURATION_BUCKETS.map((b) => [b, 0])),
        sum: 0,
        count: 0,
        labels,
      });
    }

    const hist = this.histograms.get(key)!;
    hist.sum += value;
    hist.count++;

    for (const bucket of MetricsCollector.DURATION_BUCKETS) {
      if (value <= bucket) {
        hist.buckets.set(bucket, (hist.buckets.get(bucket) ?? 0) + 1);
      }
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /** Export metrics in Prometheus text format */
  toPrometheusFormat(): string {
    const lines: string[] = [];

    for (const [key, counter] of this.counters.entries()) {
      const metricName = key.split('{')[0];
      lines.push(`# TYPE ${metricName} counter`);
      lines.push(`${key} ${counter.value}`);
    }

    for (const [key, hist] of this.histograms.entries()) {
      const metricName = key.split('{')[0];
      lines.push(`# TYPE ${metricName} histogram`);
      const labelStr = this.labelsToString(hist.labels);

      let cumulativeCount = 0;
      for (const [bucket, count] of hist.buckets.entries()) {
        cumulativeCount += count;
        lines.push(
          `${metricName}_bucket{le="${bucket}"${labelStr ? ',' + labelStr : ''}} ${cumulativeCount}`,
        );
      }
      lines.push(`${metricName}_bucket{le="+Inf"${labelStr ? ',' + labelStr : ''}} ${hist.count}`);
      lines.push(`${metricName}_sum${labelStr ? '{' + labelStr + '}' : ''} ${hist.sum}`);
      lines.push(`${metricName}_count${labelStr ? '{' + labelStr + '}' : ''} ${hist.count}`);
    }

    for (const [name, value] of this.gauges.entries()) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }

    return lines.join('\n');
  }

  /** Export as a plain JSON snapshot */
  toJSON(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};

    for (const [key, counter] of this.counters.entries()) {
      snapshot[key] = counter.value;
    }
    for (const [key, hist] of this.histograms.entries()) {
      snapshot[key] = {
        count: hist.count,
        sum: hist.sum,
        avg: hist.count > 0 ? hist.sum / hist.count : 0,
        p99: this.estimatePercentile(hist, 99),
      };
    }

    return snapshot;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildKey(name: string, labels: Record<string, string>): string {
    if (Object.keys(labels).length === 0) return name;
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return `${name}{${labelStr}}`;
  }

  private labelsToString(labels: Record<string, string>): string {
    return Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }

  private estimatePercentile(hist: Histogram, p: number): number {
    const target = (p / 100) * hist.count;
    let cumulative = 0;
    for (const [bucket, count] of hist.buckets.entries()) {
      cumulative += count;
      if (cumulative >= target) return bucket;
    }
    return hist.sum / Math.max(hist.count, 1);
  }
}
