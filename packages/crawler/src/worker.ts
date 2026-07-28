import { CrawlerError, type SourceAdapter } from './adapter';
import { TokenBucket, type TokenBucketOptions } from './rate-limit';
import { retry } from './retry';
import type { CrawlError, CrawledProduct, CrawlReport } from './types';

export interface CrawlWorkerOptions {
  adapter: SourceAdapter;
  /** 限流配置；不传走默认 5 QPS */
  rateLimit?: TokenBucketOptions;
  /** 单条最大重试次数 */
  maxRetries?: number;
  /** 退避起始毫秒 */
  retryBaseMs?: number;
  /** 并发度 */
  concurrency?: number;
  /** 命中产物时回调；不入库时只看回调结果 */
  onProduct?: (product: CrawledProduct) => Promise<void> | void;
  /** 平台明确返回不存在或已下架时回调。 */
  onNotFound?: (productId1688: string) => Promise<void> | void;
  /** 失败回调（重试耗尽或致命错误） */
  onError?: (err: CrawlError) => void;
  /** 进度回调（每完成 1 条触发） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 通用采集 Worker：
 *   - 限流：令牌桶
 *   - 重试：指数退避（仅 retryable 错误）
 *   - 并发：固定 worker 池
 *   - 优雅降级：not_found 不算失败
 */
export class CrawlWorker {
  private readonly limiter: TokenBucket;

  constructor(private readonly opts: CrawlWorkerOptions) {
    this.limiter = new TokenBucket(opts.rateLimit ?? { capacity: 5, refillPerSec: 5 });
  }

  async crawl(productIds: string[]): Promise<CrawlReport> {
    const total = productIds.length;
    const concurrency = Math.max(1, this.opts.concurrency ?? 4);
    const durations: number[] = [];
    const errors: CrawlError[] = [];
    let succeeded = 0;
    let done = 0;

    const queue = [...productIds];
    const runWorker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        const t0 = Date.now();
        try {
          await this.limiter.take();
          const product = await retry(() => this.opts.adapter.fetchProduct(id), {
            maxRetries: this.opts.maxRetries ?? 2,
            baseMs: this.opts.retryBaseMs ?? 300,
            shouldRetry: (err) => err instanceof CrawlerError && err.retryable,
          });
          if (product) {
            await this.opts.onProduct?.(product);
            succeeded++;
          } else {
            await this.opts.onNotFound?.(id);
            errors.push({ productId1688: id, reason: 'not_found', retryCount: 0, isFatal: false });
          }
        } catch (err) {
          const isFatal = !(err instanceof CrawlerError && err.retryable);
          const e: CrawlError = {
            productId1688: id,
            reason: (err as Error).message,
            retryCount: this.opts.maxRetries ?? 2,
            isFatal,
          };
          errors.push(e);
          this.opts.onError?.(e);
        } finally {
          durations.push(Date.now() - t0);
          done++;
          this.opts.onProgress?.(done, total);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

    return {
      total,
      succeeded,
      failed: errors.length,
      durations: percentiles(durations),
      errors,
    };
  }
}

function percentiles(arr: number[]): { p50: number; p95: number; max: number } {
  if (arr.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  return { p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1]! };
}
