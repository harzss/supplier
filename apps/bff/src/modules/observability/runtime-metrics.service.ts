import { Injectable } from '@nestjs/common';

interface MetricBucket {
  total: number;
  serverErrors: number;
}

export interface RuntimeMetricSnapshot {
  requests: number;
  serverErrors: number;
  serverErrorRate: number;
  totalRequests: number;
  totalServerErrors: number;
  totalDurationMs: number;
  startedAt: string;
}

const BUCKET_MS = 60_000;
const MAX_WINDOW_MS = 15 * 60_000;

/** 进程内低成本请求指标；多副本场景由 Prometheus 汇总。 */
@Injectable()
export class RuntimeMetricsService {
  private readonly startedAt = new Date();
  private readonly buckets = new Map<number, MetricBucket>();
  private totalRequests = 0;
  private totalServerErrors = 0;
  private totalDurationMs = 0;

  record(statusCode: number, durationMs: number, now = Date.now()): void {
    const bucketKey = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const bucket = this.buckets.get(bucketKey) ?? { total: 0, serverErrors: 0 };
    bucket.total++;
    this.totalRequests++;
    this.totalDurationMs += Math.max(0, Math.round(durationMs));
    if (statusCode >= 500) {
      bucket.serverErrors++;
      this.totalServerErrors++;
    }
    this.buckets.set(bucketKey, bucket);
    this.prune(now);
  }

  snapshot(windowMs = 5 * 60_000, now = Date.now()): RuntimeMetricSnapshot {
    const lowerBound = now - Math.min(Math.max(windowMs, BUCKET_MS), MAX_WINDOW_MS);
    let requests = 0;
    let serverErrors = 0;
    for (const [timestamp, bucket] of this.buckets) {
      if (timestamp + BUCKET_MS <= lowerBound) continue;
      requests += bucket.total;
      serverErrors += bucket.serverErrors;
    }
    return {
      requests,
      serverErrors,
      serverErrorRate: requests ? serverErrors / requests : 0,
      totalRequests: this.totalRequests,
      totalServerErrors: this.totalServerErrors,
      totalDurationMs: this.totalDurationMs,
      startedAt: this.startedAt.toISOString(),
    };
  }

  private prune(now: number): void {
    const lowerBound = now - MAX_WINDOW_MS - BUCKET_MS;
    for (const timestamp of this.buckets.keys()) {
      if (timestamp < lowerBound) this.buckets.delete(timestamp);
    }
  }
}
