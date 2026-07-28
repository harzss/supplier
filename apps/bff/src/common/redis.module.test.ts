import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { RedisLifecycle } from './redis.module';

describe('RedisLifecycle', () => {
  it('quits an active Redis connection during application shutdown', async () => {
    const client = {
      status: 'ready',
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    } as unknown as Redis;

    await new RedisLifecycle(client).onApplicationShutdown();

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('forces disconnect when graceful quit fails', async () => {
    const client = {
      status: 'ready',
      quit: vi.fn().mockRejectedValue(new Error('connection lost')),
      disconnect: vi.fn(),
    } as unknown as Redis;

    await new RedisLifecycle(client).onApplicationShutdown();

    expect(client.disconnect).toHaveBeenCalledWith(false);
  });
});
