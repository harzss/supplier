/**
 * 简易令牌桶限流器。
 * 用法：
 *   const limiter = new TokenBucket({ capacity: 10, refillPerSec: 5 });
 *   await limiter.take();
 *   ... do request ...
 */
export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly opts: TokenBucketOptions) {
    this.tokens = opts.capacity;
    this.lastRefill = Date.now();
  }

  /** 获取一个令牌；不够时按补充速率精确等待 */
  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const need = 1 - this.tokens;
      const waitMs = Math.max(5, Math.ceil((need / this.opts.refillPerSec) * 1000));
      await sleep(waitMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.opts.capacity, this.tokens + elapsed * this.opts.refillPerSec);
    this.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
