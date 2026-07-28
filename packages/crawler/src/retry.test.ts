import { describe, expect, it, vi } from 'vitest';
import { retry } from './retry';

describe('retry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const r = await retry(fn, { maxRetries: 2, baseMs: 1 });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(retry(fn, { maxRetries: 2, baseMs: 1 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('respects shouldRetry=false to short-circuit', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'));
    await expect(
      retry(fn, { maxRetries: 5, baseMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('eventually succeeds on flaky function', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('try again');
      return 'finally';
    });
    const r = await retry(fn, { maxRetries: 3, baseMs: 1 });
    expect(r).toBe('finally');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
