import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeStateService } from './runtime-state.service';
import { skipReadOnlyThrottle, SupabaseThrottlerStorage } from './supabase-throttler-storage';

describe('SupabaseThrottlerStorage', () => {
  it('maps an atomic Supabase fixed-window decision to Nest throttler state', async () => {
    const runtimeState = {
      takeFixedWindow: vi.fn().mockResolvedValue({
        allowed: false,
        count: 121,
        retryAfterMs: 12_001,
        timeToExpireMs: 12_001,
      }),
    } as unknown as RuntimeStateService;
    const storage = new SupabaseThrottlerStorage(runtimeState);

    await expect(
      storage.increment('request-hash', 60_000, 120, 60_000, 'default'),
    ).resolves.toEqual({
      totalHits: 121,
      timeToExpire: 13,
      isBlocked: true,
      timeToBlockExpire: 13,
    });
    expect(runtimeState.takeFixedWindow).toHaveBeenCalledWith(
      'http-rate:default:request-hash',
      120,
      60_000,
    );
  });

  it('rejects a block window that cannot be represented by the shared counter', async () => {
    const runtimeState = { takeFixedWindow: vi.fn() } as unknown as RuntimeStateService;
    const storage = new SupabaseThrottlerStorage(runtimeState);

    await expect(storage.increment('key', 60_000, 120, 30_000, 'default')).rejects.toThrow(
      'blockDuration to equal ttl',
    );
    expect(runtimeState.takeFixedWindow).not.toHaveBeenCalled();
  });

  it('skips shared counters only for read-only HTTP methods', () => {
    const context = (method: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ method }) }),
      }) as unknown as ExecutionContext;

    expect(skipReadOnlyThrottle(context('GET'))).toBe(true);
    expect(skipReadOnlyThrottle(context('HEAD'))).toBe(true);
    expect(skipReadOnlyThrottle(context('OPTIONS'))).toBe(true);
    expect(skipReadOnlyThrottle(context('POST'))).toBe(false);
    expect(skipReadOnlyThrottle(context('DELETE'))).toBe(false);
  });
});
