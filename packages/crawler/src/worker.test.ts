import { describe, expect, it, vi } from 'vitest';
import { MockAdapter } from './adapters/mock';
import { CrawlWorker } from './worker';

describe('CrawlWorker', () => {
  it('crawls a list of ids and reports success', async () => {
    const adapter = new MockAdapter({ latencyMs: 5 });
    const seen: string[] = [];
    const worker = new CrawlWorker({
      adapter,
      concurrency: 2,
      rateLimit: { capacity: 10, refillPerSec: 50 },
      onProduct: (p) => {
        seen.push(p.productId1688);
      },
    });
    const report = await worker.crawl(['a', 'b', 'c', 'd', 'e']);
    expect(report.total).toBe(5);
    expect(report.succeeded).toBe(5);
    expect(report.failed).toBe(0);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('counts not_found as non-fatal error', async () => {
    const adapter = new MockAdapter({ latencyMs: 1 });
    const onNotFound = vi.fn();
    const worker = new CrawlWorker({
      adapter,
      concurrency: 1,
      rateLimit: { capacity: 5, refillPerSec: 50 },
      onNotFound,
    });
    const report = await worker.crawl(['ok-1', 'missing-x']);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.errors[0]!.isFatal).toBe(false);
    expect(onNotFound).toHaveBeenCalledWith('missing-x');
  });

  it('retries rate-limited errors then fails after max retries', async () => {
    const adapter = new MockAdapter({ latencyMs: 1 });
    const onError = vi.fn();
    const worker = new CrawlWorker({
      adapter,
      concurrency: 1,
      rateLimit: { capacity: 5, refillPerSec: 50 },
      maxRetries: 2,
      retryBaseMs: 1,
      onError,
    });
    const report = await worker.crawl(['ratelimit-1']);
    expect(report.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports duration percentiles', async () => {
    const adapter = new MockAdapter({ latencyMs: 5 });
    const worker = new CrawlWorker({
      adapter,
      concurrency: 4,
      rateLimit: { capacity: 100, refillPerSec: 100 },
    });
    const report = await worker.crawl(Array.from({ length: 10 }, (_, i) => `n-${i}`));
    expect(report.durations.p50).toBeGreaterThan(0);
    expect(report.durations.p95).toBeGreaterThanOrEqual(report.durations.p50);
    expect(report.durations.max).toBeGreaterThanOrEqual(report.durations.p95);
  });

  it('progress callback fires for each item', async () => {
    const adapter = new MockAdapter({ latencyMs: 1 });
    const progress = vi.fn();
    const worker = new CrawlWorker({
      adapter,
      concurrency: 2,
      rateLimit: { capacity: 5, refillPerSec: 50 },
      onProgress: progress,
    });
    await worker.crawl(['x', 'y', 'z']);
    expect(progress).toHaveBeenCalledTimes(3);
    const lastCall = progress.mock.calls[progress.mock.calls.length - 1]!;
    expect(lastCall).toEqual([3, 3]);
  });
});
