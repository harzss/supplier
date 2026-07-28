import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { PlatformProductLockService } from './platform-product-lock.service';

describe('PlatformProductLockService', () => {
  it('acquires, renews and releases only the owned product lock', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
    } as unknown as Redis;
    const service = new PlatformProductLockService(redis);

    const token = await service.acquire(7n);
    await service.renew(7n, token);
    await service.release(7n, token);

    expect(redis.set).toHaveBeenCalledWith(
      'platform-product:mutation:7',
      token,
      'PX',
      60_000,
      'NX',
    );
    expect(redis.eval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pexpire'),
      1,
      'platform-product:mutation:7',
      token,
      '60000',
    );
    expect(redis.eval).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('del'),
      1,
      'platform-product:mutation:7',
      token,
    );
  });

  it('rejects a concurrent mutation and fails closed when Redis is unavailable', async () => {
    const busy = new PlatformProductLockService({ set: vi.fn().mockResolvedValue(null) } as never);
    const unavailable = new PlatformProductLockService({
      set: vi.fn().mockRejectedValue('down'),
    } as never);

    await expect(busy.acquire(7n)).rejects.toBeInstanceOf(ConflictException);
    await expect(unavailable.acquire(7n)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects a caller that lost ownership before the platform write completed', async () => {
    const service = new PlatformProductLockService({ eval: vi.fn().mockResolvedValue(0) } as never);

    await expect(service.renew(7n, 'old-token')).rejects.toBeInstanceOf(ConflictException);
  });
});
