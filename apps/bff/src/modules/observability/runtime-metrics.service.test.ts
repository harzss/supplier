import { describe, expect, it } from 'vitest';
import { RuntimeMetricsService } from './runtime-metrics.service';

describe('RuntimeMetricsService', () => {
  it('tracks total and rolling five-minute 5xx rates', () => {
    const metrics = new RuntimeMetricsService();
    const now = Date.now();
    metrics.record(200, 10, now);
    metrics.record(503, 20, now);
    metrics.record(500, 30, now - 10 * 60_000);

    expect(metrics.snapshot(5 * 60_000, now)).toMatchObject({
      requests: 2,
      serverErrors: 1,
      serverErrorRate: 0.5,
      totalRequests: 3,
      totalServerErrors: 2,
      totalDurationMs: 60,
    });
  });
});
