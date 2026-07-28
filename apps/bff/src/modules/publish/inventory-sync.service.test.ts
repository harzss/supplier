import type { ConfigService } from '@nestjs/config';
import type { PublishedProduct } from '@supplier/db';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import { InventorySyncService } from './inventory-sync.service';
import type { PlatformProductLockService } from './platform-product-lock.service';

const FINGERPRINT = 'a'.repeat(64);
const JOB = {
  id: 7n,
  inventorySyncAttempts: 1,
  inventoryLockedBy: 'worker-1',
  inventoryTargetFingerprint: FINGERPRINT,
  inventoryTargetVersion: 4,
} as PublishedProduct;

function productLocks(): PlatformProductLockService {
  return {
    acquire: vi.fn().mockResolvedValue('product-lock'),
    renew: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformProductLockService;
}

function inventoryRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 7n,
    platformProductId: '998877',
    inventorySyncAttempts: 1,
    inventoryLockedBy: 'worker-1',
    inventorySyncStatus: 'syncing',
    inventoryTargetFingerprint: FINGERPRINT,
    inventoryTargetVersion: 4,
    shop: {
      id: 2n,
      platform: 'douyin',
      platformShopId: 'demo-douyin-1',
    },
    sourceProduct: {
      availability: 'available',
      inventoryFingerprint: FINGERPRINT,
      inventoryVersion: 4,
      skuList: [
        { skuId: 'spec-white', stock: 12 },
        { skuId: 'spec-black', stock: 0 },
      ],
    },
    task: {
      userId: 1n,
      skuSnapshot: {
        douyin: {
          dimensions: ['颜色'],
          skus: [
            { sourceSkuId: 'spec-white', specName: '白色', price: 29, stock: 20 },
            { sourceSkuId: 'spec-black', specName: '黑色', price: 29, stock: 20 },
          ],
        },
      },
    },
    ...overrides,
  };
}

describe('InventorySyncService', () => {
  it('does not claim legacy demo inventory jobs in supabase auth mode', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      publishedProduct: {
        findFirst,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const service = new InventorySyncService(
      {
        get: (key: string) => (key === 'AUTH_MODE' ? 'supabase' : undefined),
      } as ConfigService,
      prisma,
      {} as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.claimNext('worker-1')).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shop: { NOT: { platformShopId: { startsWith: 'demo-' } } },
        }),
      }),
    );
  });

  it('syncs current source stock by the external SKU IDs stored at publish time', async () => {
    const syncInventory = vi.fn().mockResolvedValue(undefined);
    const offlineProduct = vi.fn();
    const prisma = {
      publishedProduct: {
        findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const adapters = {
      create: vi.fn().mockReturnValue({ syncInventory, offlineProduct }),
    } as unknown as PlatformAdapterFactory;
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      prisma,
      adapters,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('processed');

    expect(syncInventory).toHaveBeenCalledWith('mock-token', {
      platformProductId: '998877',
      idempotencyKey: `inventory-7-v4-${FINGERPRINT.slice(0, 24)}`,
      items: [
        { sourceSkuId: 'spec-white', stock: 12 },
        { sourceSkuId: 'spec-black', stock: 0 },
      ],
    });
    expect(offlineProduct).not.toHaveBeenCalled();
    expect(prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inventoryLockedBy: 'worker-1',
          inventorySyncAttempts: 1,
        }),
        data: expect.objectContaining({
          inventorySyncReason: 'stock_updated',
          inventorySyncStatus: 'synced',
        }),
      }),
    );
  });

  it('fails safe by offlining when a published source SKU disappears', async () => {
    const syncInventory = vi.fn();
    const offlineProduct = vi.fn().mockResolvedValue(undefined);
    const record = inventoryRecord({
      sourceProduct: {
        availability: 'available',
        inventoryFingerprint: FINGERPRINT,
        inventoryVersion: 4,
        skuList: [{ skuId: 'spec-white', stock: 12 }],
      },
    });
    const prisma = {
      publishedProduct: {
        findUnique: vi.fn().mockResolvedValue(record),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      prisma,
      {
        create: vi.fn().mockReturnValue({ syncInventory, offlineProduct }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await service.execute(JOB);

    expect(syncInventory).not.toHaveBeenCalled();
    expect(offlineProduct).toHaveBeenCalledWith('mock-token', '998877');
    expect(prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'offline',
          inventorySyncReason: 'source_sku_changed',
        }),
      }),
    );
  });

  it('moves repeated failures to dead after the configured attempt limit', async () => {
    const prisma = {
      publishedProduct: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaService;
    const service = new InventorySyncService(
      { get: vi.fn().mockReturnValue('3') } as unknown as ConfigService,
      prisma,
      {} as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    const result = await service.fail(
      { ...JOB, inventorySyncAttempts: 3 } as PublishedProduct,
      'platform unavailable',
    );

    expect(result).toBe('dead');
    expect(prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inventoryLockedBy: 'worker-1',
          inventorySyncAttempts: 3,
        }),
        data: expect.objectContaining({
          inventorySyncStatus: 'dead',
          inventoryNextRunAt: null,
          inventorySyncError: 'platform unavailable',
        }),
      }),
    );
  });

  it('rejects a job after another worker has taken ownership', async () => {
    const create = vi.fn();
    const updateMany = vi.fn();
    const prisma = {
      publishedProduct: {
        findUnique: vi.fn().mockResolvedValue(
          inventoryRecord({
            inventorySyncAttempts: 2,
            inventoryLockedBy: 'worker-2',
          }),
        ),
        updateMany,
      },
    } as unknown as PrismaService;
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      prisma,
      { create } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('stale');
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not complete after ownership changes during the platform call', async () => {
    const syncInventory = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      publishedProduct: {
        findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
        updateMany,
      },
    } as unknown as PrismaService;
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      prisma,
      {
        create: vi.fn().mockReturnValue({ syncInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('stale');
    expect(syncInventory).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inventoryLockedBy: 'worker-1',
          inventorySyncAttempts: 1,
        }),
      }),
    );
  });

  it('does not call the platform after job ownership changes while waiting for the product lock', async () => {
    const syncInventory = vi.fn();
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(inventoryRecord())
      .mockResolvedValueOnce(
        inventoryRecord({ inventorySyncAttempts: 2, inventoryLockedBy: 'worker-2' }),
      );
    const locks = productLocks();
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique,
          updateMany: vi.fn(),
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({ syncInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      locks,
    );

    await expect(service.execute(JOB)).resolves.toBe('stale');

    expect(syncInventory).not.toHaveBeenCalled();
    expect(locks.release).toHaveBeenCalledWith(7n, 'product-lock');
  });

  it('does not fail a job after another worker has taken ownership', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = new InventorySyncService(
      { get: vi.fn().mockReturnValue('3') } as unknown as ConfigService,
      { publishedProduct: { updateMany } } as unknown as PrismaService,
      {} as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.fail(JOB, 'late failure')).resolves.toBe('stale');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inventoryLockedBy: 'worker-1',
          inventorySyncAttempts: 1,
        }),
      }),
    );
  });

  it('rejects a manual retry when a worker claims the job concurrently', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      publishedProduct: {
        findFirst: vi.fn().mockResolvedValue({
          id: 7n,
          status: 'online',
          inventorySyncStatus: 'dead',
          inventorySyncAttempts: 3,
          inventoryTargetFingerprint: FINGERPRINT,
          inventoryTargetVersion: 4,
          sourceProduct: {
            inventoryFingerprint: FINGERPRINT,
            inventoryVersion: 4,
          },
        }),
        updateMany,
      },
    } as unknown as PrismaService;
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      prisma,
      {} as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.manualRetry(1n, '7')).rejects.toThrow('库存同步状态已变化，请刷新后重试');
  });
});
