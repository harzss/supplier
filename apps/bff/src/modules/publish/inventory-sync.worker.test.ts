import type { ConfigService } from '@nestjs/config';
import type { PublishedProduct } from '@supplier/db';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { InventorySyncService } from './inventory-sync.service';
import { InventorySyncWorker } from './inventory-sync.worker';

const JOB = { id: 7n } as PublishedProduct;

describe('InventorySyncWorker', () => {
  it('processes a claimed inventory job', async () => {
    const inventory = {
      claimNext: vi.fn().mockResolvedValue(JOB),
      execute: vi.fn().mockResolvedValue('processed'),
      fail: vi.fn(),
    } as unknown as InventorySyncService;
    const worker = new InventorySyncWorker(
      { get: vi.fn() } as unknown as ConfigService,
      inventory,
      { reconnect: vi.fn() } as unknown as PrismaService,
    );

    expect(await worker.runOnce()).toBe(true);
    expect(inventory.execute).toHaveBeenCalledWith(JOB);
    expect(inventory.fail).not.toHaveBeenCalled();
  });

  it('reschedules a failed inventory job', async () => {
    const inventory = {
      claimNext: vi.fn().mockResolvedValue(JOB),
      execute: vi.fn().mockRejectedValue(new Error('platform unavailable')),
      fail: vi.fn(),
    } as unknown as InventorySyncService;
    const worker = new InventorySyncWorker(
      { get: vi.fn() } as unknown as ConfigService,
      inventory,
      { reconnect: vi.fn() } as unknown as PrismaService,
    );

    await worker.runOnce();

    expect(inventory.fail).toHaveBeenCalledWith(JOB, 'platform unavailable');
  });
});
