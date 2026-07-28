import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit';

describe('TokenBucket', () => {
  it('allows up to capacity tokens immediately', async () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1 });
    const t0 = Date.now();
    await bucket.take();
    await bucket.take();
    await bucket.take();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('throttles when capacity exhausted', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 10 }); // 100ms 一个令牌
    await bucket.take();
    await bucket.take();
    const t0 = Date.now();
    await bucket.take();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });
});
