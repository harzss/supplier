import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeStateService } from '../../common/runtime-state.service';
import { PlatformProductLockService } from './platform-product-lock.service';

describe('PlatformProductLockService', () => {
  it('acquires, renews and releases only the owned product lock', async () => {
    const runtimeState = {
      acquireLease: vi.fn().mockResolvedValue('owned-token'),
      renewLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuntimeStateService;
    const service = new PlatformProductLockService(runtimeState);

    const token = await service.acquire(7n);
    await service.renew(7n, token);
    await service.release(7n, token);

    expect(runtimeState.acquireLease).toHaveBeenCalledWith('platform-product:mutation:7', 60_000);
    expect(runtimeState.renewLease).toHaveBeenCalledWith(
      'platform-product:mutation:7',
      token,
      60_000,
    );
    expect(runtimeState.releaseLease).toHaveBeenCalledWith('platform-product:mutation:7', token);
  });

  it('rejects a concurrent mutation and fails closed when runtime state is unavailable', async () => {
    const busy = new PlatformProductLockService({
      acquireLease: vi.fn().mockResolvedValue(null),
    } as never);
    const unavailable = new PlatformProductLockService({
      acquireLease: vi.fn().mockRejectedValue('down'),
    } as never);

    await expect(busy.acquire(7n)).rejects.toBeInstanceOf(ConflictException);
    await expect(unavailable.acquire(7n)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects a caller that lost ownership before the platform write completed', async () => {
    const service = new PlatformProductLockService({
      renewLease: vi.fn().mockResolvedValue(false),
    } as never);

    await expect(service.renew(7n, 'old-token')).rejects.toBeInstanceOf(ConflictException);
  });
});
