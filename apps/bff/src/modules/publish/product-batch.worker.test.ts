import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { ProductBatchExecutionRecord, ProductBatchService } from './product-batch.service';
import { ProductBatchWorker } from './product-batch.worker';

const ITEM = {
  id: 51n,
  taskId: 41n,
  attempts: 1,
  maxAttempts: 3,
} as ProductBatchExecutionRecord;

describe('ProductBatchWorker', () => {
  it('records a claimed item failure through the batch service', async () => {
    const error = new Error('platform unavailable');
    const batches = {
      claimNext: vi.fn().mockResolvedValue(ITEM),
      executeClaimed: vi.fn().mockRejectedValue(error),
      failClaimedItem: vi.fn().mockResolvedValue('retry_wait'),
    } as unknown as ProductBatchService;
    const worker = new ProductBatchWorker({ get: vi.fn() } as unknown as ConfigService, batches, {
      reconnect: vi.fn(),
    } as unknown as PrismaService);

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(batches.failClaimedItem).toHaveBeenCalledWith(ITEM, error);
  });

  it('reconnects the database when persisting an item failure loses its connection', async () => {
    const platformError = new Error('platform unavailable');
    const databaseError = Object.assign(new Error("Can't reach database server"), {
      code: 'P1001',
    });
    const batches = {
      claimNext: vi.fn().mockResolvedValue(ITEM),
      executeClaimed: vi.fn().mockRejectedValue(platformError),
      failClaimedItem: vi.fn().mockRejectedValue(databaseError),
    } as unknown as ProductBatchService;
    const prisma = { reconnect: vi.fn().mockResolvedValue(undefined) };
    const worker = new ProductBatchWorker(
      { get: vi.fn() } as unknown as ConfigService,
      batches,
      prisma as unknown as PrismaService,
    );

    await expect(worker.runOnce()).rejects.toBe(databaseError);

    expect(batches.failClaimedItem).toHaveBeenCalledWith(ITEM, platformError);
    expect(prisma.reconnect).toHaveBeenCalledOnce();
  });
});
