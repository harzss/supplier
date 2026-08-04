import type { ConfigService } from '@nestjs/config';
import type { PublishedProduct } from '@supplier/db';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import { InventorySyncService } from './inventory-sync.service';
import type { PlatformProductLockService } from './platform-product-lock.service';

const FINGERPRINT = 'a'.repeat(64);
const BINDING_FINGERPRINT = 'b'.repeat(64);
const SOURCE_FINGERPRINT = 'c'.repeat(64);
const BINDING_GUARD = {
  id: 31n,
  revision: 2,
  sourceProductId: 22n,
  sourceFingerprint: SOURCE_FINGERPRINT,
  bindingFingerprint: BINDING_FINGERPRINT,
};
const JOB = {
  id: 7n,
  inventorySyncAttempts: 1,
  inventoryLockedBy: 'worker-1',
  inventoryTargetFingerprint: FINGERPRINT,
  inventoryTargetVersion: 4,
} as PublishedProduct;
const BOUND_JOB = { ...JOB, sourceBindingGuard: BINDING_GUARD } as PublishedProduct;

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
    sourceProductId: 10n,
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
    batchItems: [],
    sourceBindings: [],
    ...overrides,
  };
}

function sourceBinding(overrides: Record<string, unknown> = {}) {
  return {
    ...BINDING_GUARD,
    currentSlot: 1,
    skuRoutes: [
      {
        platformSkuKey: 'stable-white',
        sourceSpecId: 'new-spec-white',
        sourceSpecRequired: true,
        sourceUnitCost: 12,
        values: ['白色'],
      },
      {
        platformSkuKey: 'stable-black',
        sourceSpecId: 'new-spec-black',
        sourceSpecRequired: true,
        sourceUnitCost: 13,
        values: ['黑色'],
      },
    ],
    sourceProduct: {
      availability: 'available',
      inventoryFingerprint: FINGERPRINT,
      inventoryVersion: 4,
      skuList: [
        { skuId: 'new-spec-white', stock: 9 },
        { skuId: 'new-spec-black', stock: 3 },
      ],
    },
    ...overrides,
  };
}

function boundInventoryRecord(bindingOverrides: Record<string, unknown> = {}) {
  return inventoryRecord({ sourceBindings: [sourceBinding(bindingOverrides)] });
}

function platformInventory(items: Array<[string, number]>, state = 'online') {
  return {
    state,
    status: 4,
    checkStatus: 4,
    items: items.map(([sourceSkuId, stock]) => ({ sourceSkuId, stock })),
  };
}

function inventoryKey(
  items: Array<{ sourceSkuId: string; stock: number }>,
  bindingFingerprint?: string,
): string {
  const remainingFingerprint = createHash('sha256')
    .update(JSON.stringify(items))
    .digest('hex')
    .slice(0, 16);
  const bindingSegment = bindingFingerprint ? `-b${bindingFingerprint.slice(0, 24)}` : '';
  return `inventory-7-v4-${FINGERPRINT.slice(0, 24)}${bindingSegment}-${remainingFingerprint}`;
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
          batchItems: {
            none: expect.objectContaining({
              errorCode: { in: ['OFFLINE_WRITE_STARTED', 'OFFLINE_RESULT_UNKNOWN'] },
            }),
          },
        }),
      }),
    );
  });

  it('claims a job with the exact current source binding guard', async () => {
    const candidate = boundInventoryRecord({});
    Object.assign(candidate, {
      status: 'online',
      inventorySyncStatus: 'pending',
      inventorySyncAttempts: 0,
    });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findFirst: vi.fn().mockResolvedValue(candidate),
          findUnique: vi.fn().mockResolvedValue(candidate),
          updateMany,
        },
      } as unknown as PrismaService,
      {} as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.claimNext('worker-1')).resolves.toEqual(
      expect.objectContaining({ sourceBindingGuard: BINDING_GUARD }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          sourceBindings: {
            some: expect.objectContaining({
              ...BINDING_GUARD,
              currentSlot: 1,
            }),
          },
        }),
      }),
    );
  });

  it('releases a claimed inventory job when an offline result still needs verification', async () => {
    const syncInventory = vi.fn();
    const getProductInventory = vi.fn();
    const prisma = {
      publishedProduct: {
        findUnique: vi.fn().mockResolvedValue(inventoryRecord({ batchItems: [{ id: 51n }] })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const adapters = {
      create: vi.fn().mockReturnValue({ syncInventory, getProductInventory }),
    } as unknown as PlatformAdapterFactory;
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      prisma,
      adapters,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('stale');

    expect(adapters.create).not.toHaveBeenCalled();
    expect(syncInventory).not.toHaveBeenCalled();
    expect(prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inventorySyncStatus: 'pending',
          inventorySyncError: '商品下架结果待核验，库存同步已暂停',
        }),
      }),
    );
  });

  it('syncs current source stock by the external SKU IDs stored at publish time', async () => {
    const syncInventory = vi.fn().mockResolvedValue(undefined);
    const getProductInventory = vi
      .fn()
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 5],
          ['spec-black', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 12],
          ['spec-black', 0],
        ]),
      );
    const offlineProduct = vi.fn();
    const prisma = {
      publishedProduct: {
        findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const adapters = {
      create: vi.fn().mockReturnValue({ syncInventory, getProductInventory, offlineProduct }),
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
      idempotencyKey: inventoryKey([
        { sourceSkuId: 'spec-white', stock: 12 },
        { sourceSkuId: 'spec-black', stock: 0 },
      ]),
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
          skuInventorySnapshot: {
            version: 1,
            items: [
              { sourceSkuId: 'spec-black', stock: 0 },
              { sourceSkuId: 'spec-white', stock: 12 },
            ],
          },
        }),
      }),
    );
  });

  it('syncs a replacement source through stable platform SKU keys', async () => {
    const record = boundInventoryRecord();
    const syncInventory = vi.fn().mockResolvedValue(undefined);
    const getProductInventory = vi
      .fn()
      .mockResolvedValueOnce(
        platformInventory([
          ['stable-black', 8],
          ['stable-white', 5],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['stable-black', 3],
          ['stable-white', 9],
        ]),
      );
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(record),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({
          syncInventory,
          getProductInventory,
          offlineProduct: vi.fn(),
        }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(BOUND_JOB)).resolves.toBe('processed');

    const desired = [
      { sourceSkuId: 'stable-black', stock: 3 },
      { sourceSkuId: 'stable-white', stock: 9 },
    ];
    expect(syncInventory).toHaveBeenCalledWith('mock-token', {
      platformProductId: '998877',
      idempotencyKey: inventoryKey(desired, BINDING_FINGERPRINT),
      items: desired,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceBindings: {
            some: expect.objectContaining({
              ...BINDING_GUARD,
              currentSlot: 1,
              sourceProduct: {
                inventoryFingerprint: FINGERPRINT,
                inventoryVersion: 4,
              },
            }),
          },
        }),
        data: expect.objectContaining({
          skuInventorySnapshot: { version: 1, items: desired },
        }),
      }),
    );
  });

  it('syncs the published SKU subset when the replacement source has extra SKUs', async () => {
    const record = boundInventoryRecord({
      sourceProduct: {
        availability: 'available',
        inventoryFingerprint: FINGERPRINT,
        inventoryVersion: 4,
        skuList: [
          { skuId: 'new-spec-white', stock: 9 },
          { skuId: 'new-spec-black', stock: 3 },
          { skuId: 'new-spec-green', stock: 6 },
        ],
      },
    });
    const syncInventory = vi.fn().mockResolvedValue(undefined);
    const getProductInventory = vi
      .fn()
      .mockResolvedValueOnce(
        platformInventory([
          ['stable-black', 8],
          ['stable-white', 5],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['stable-black', 3],
          ['stable-white', 9],
        ]),
      );
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(record),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({
          syncInventory,
          getProductInventory,
          offlineProduct: vi.fn(),
        }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(BOUND_JOB)).resolves.toBe('processed');
    expect(syncInventory).toHaveBeenCalledWith(
      'mock-token',
      expect.objectContaining({
        items: [
          { sourceSkuId: 'stable-black', stock: 3 },
          { sourceSkuId: 'stable-white', stock: 9 },
        ],
      }),
    );
  });

  it.each([
    {
      name: 'missing routed source spec',
      bindingOverrides: {
        skuRoutes: [
          {
            platformSkuKey: 'stable-white',
            sourceSpecId: 'missing-spec',
            sourceSpecRequired: true,
            sourceUnitCost: 12,
            values: ['白色'],
          },
          {
            platformSkuKey: 'stable-black',
            sourceSpecId: 'new-spec-black',
            sourceSpecRequired: true,
            sourceUnitCost: 13,
            values: ['黑色'],
          },
        ],
      },
    },
    {
      name: 'duplicate routed source spec',
      bindingOverrides: {
        skuRoutes: [
          {
            platformSkuKey: 'stable-white',
            sourceSpecId: 'new-spec-white',
            sourceSpecRequired: true,
            sourceUnitCost: 12,
            values: ['白色'],
          },
          {
            platformSkuKey: 'stable-black',
            sourceSpecId: 'new-spec-white',
            sourceSpecRequired: true,
            sourceUnitCost: 13,
            values: ['黑色'],
          },
        ],
      },
    },
    {
      name: 'route without an exact source spec',
      bindingOverrides: {
        skuRoutes: [
          {
            platformSkuKey: 'stable-white',
            sourceSpecId: null,
            sourceSpecRequired: false,
            sourceUnitCost: 12,
            values: [],
          },
          {
            platformSkuKey: 'stable-black',
            sourceSpecId: 'new-spec-black',
            sourceSpecRequired: true,
            sourceUnitCost: 13,
            values: ['黑色'],
          },
        ],
      },
    },
  ])(
    'fails closed for invalid replacement source inventory: $name',
    async ({ bindingOverrides }) => {
      const record = boundInventoryRecord(bindingOverrides);
      const syncInventory = vi.fn();
      const getProductInventory = vi.fn();
      const offlineProduct = vi.fn().mockResolvedValue(undefined);
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const service = new InventorySyncService(
        { get: vi.fn() } as unknown as ConfigService,
        {
          publishedProduct: {
            findUnique: vi.fn().mockResolvedValue(record),
            updateMany,
          },
        } as unknown as PrismaService,
        {
          create: vi.fn().mockReturnValue({
            syncInventory,
            getProductInventory,
            getProductState: vi.fn().mockResolvedValue({
              state: 'offline',
              status: 1,
              checkStatus: 3,
            }),
            offlineProduct,
          }),
        } as unknown as PlatformAdapterFactory,
        {} as ShopTokenService,
        productLocks(),
      );

      await expect(service.execute(BOUND_JOB)).resolves.toBe('processed');
      expect(syncInventory).not.toHaveBeenCalled();
      expect(getProductInventory).not.toHaveBeenCalled();
      expect(offlineProduct).toHaveBeenCalledWith('mock-token', '998877');
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'offline',
            inventorySyncReason: 'source_sku_changed',
          }),
        }),
      );
    },
  );

  it('does not write inventory after the current source binding changes', async () => {
    const current = boundInventoryRecord();
    const changed = boundInventoryRecord({
      revision: 3,
      bindingFingerprint: 'd'.repeat(64),
    });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(changed);
    const getProductInventory = vi.fn().mockResolvedValue(
      platformInventory([
        ['stable-black', 8],
        ['stable-white', 5],
      ]),
    );
    const syncInventory = vi.fn();
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: { findUnique, updateMany: vi.fn() },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({
          syncInventory,
          getProductInventory,
          offlineProduct: vi.fn(),
        }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(BOUND_JOB)).resolves.toBe('stale');
    expect(getProductInventory).toHaveBeenCalledOnce();
    expect(syncInventory).not.toHaveBeenCalled();
  });

  it('requeues a claimed job to the current binding inventory target', async () => {
    const nextFingerprint = 'e'.repeat(64);
    const record = boundInventoryRecord({
      sourceProduct: {
        availability: 'available',
        inventoryFingerprint: nextFingerprint,
        inventoryVersion: 5,
        skuList: [
          { skuId: 'new-spec-white', stock: 10 },
          { skuId: 'new-spec-black', stock: 4 },
        ],
      },
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn();
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(record),
          updateMany,
        },
      } as unknown as PrismaService,
      { create } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(BOUND_JOB)).resolves.toBe('stale');
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceBindings: {
            some: expect.objectContaining({ ...BINDING_GUARD, currentSlot: 1 }),
          },
        }),
        data: expect.objectContaining({
          inventorySyncStatus: 'pending',
          inventoryTargetFingerprint: nextFingerprint,
          inventoryTargetVersion: 5,
        }),
      }),
    );
  });

  it('recovers without writing when platform inventory already matches the target', async () => {
    const syncInventory = vi.fn();
    const getProductInventory = vi.fn().mockResolvedValue(
      platformInventory([
        ['spec-black', 0],
        ['spec-white', 12],
      ]),
    );
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi
          .fn()
          .mockReturnValue({ syncInventory, getProductInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('processed');

    expect(getProductInventory).toHaveBeenCalledOnce();
    expect(syncInventory).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inventorySyncStatus: 'synced',
          skuInventorySnapshot: {
            version: 1,
            items: [
              { sourceSkuId: 'spec-black', stock: 0 },
              { sourceSkuId: 'spec-white', stock: 12 },
            ],
          },
        }),
      }),
    );
  });

  it('retries only remaining SKUs with a stable key after partial platform writes', async () => {
    const allItems = [
      { sourceSkuId: 'spec-white', stock: 12 },
      { sourceSkuId: 'spec-black', stock: 0 },
    ];
    const remainingItems = [{ sourceSkuId: 'spec-black', stock: 0 }];
    const initial = platformInventory([
      ['spec-white', 5],
      ['spec-black', 8],
    ]);
    const partial = platformInventory([
      ['spec-white', 12],
      ['spec-black', 8],
    ]);
    const desired = platformInventory([
      ['spec-white', 12],
      ['spec-black', 0],
    ]);
    const getProductInventory = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(desired);
    const syncInventory = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi
          .fn()
          .mockReturnValue({ syncInventory, getProductInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).rejects.toThrow('平台尚未确认全部 SKU 新库存');
    await expect(service.execute(JOB)).rejects.toThrow('平台尚未确认全部 SKU 新库存');
    await expect(service.execute(JOB)).resolves.toBe('processed');

    expect(syncInventory).toHaveBeenNthCalledWith(1, 'mock-token', {
      platformProductId: '998877',
      idempotencyKey: inventoryKey(allItems),
      items: allItems,
    });
    expect(syncInventory).toHaveBeenNthCalledWith(2, 'mock-token', {
      platformProductId: '998877',
      idempotencyKey: inventoryKey(remainingItems),
      items: remainingItems,
    });
    expect(syncInventory).toHaveBeenNthCalledWith(3, 'mock-token', {
      platformProductId: '998877',
      idempotencyKey: inventoryKey(remainingItems),
      items: remainingItems,
    });
    expect(inventoryKey(allItems)).not.toBe(inventoryKey(remainingItems));
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it('recovers a known item failure only when platform readback confirms every SKU', async () => {
    const syncInventory = vi
      .fn()
      .mockRejectedValue(new Error('Douyin inventory sync failed for item 1'));
    const getProductInventory = vi
      .fn()
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 5],
          ['spec-black', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 12],
          ['spec-black', 0],
        ]),
      );
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi
          .fn()
          .mockReturnValue({ syncInventory, getProductInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('processed');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ inventorySyncStatus: 'synced' }),
      }),
    );
  });

  it('keeps a known partial item failure retryable instead of committing it', async () => {
    const syncInventory = vi
      .fn()
      .mockRejectedValue(new Error('Douyin inventory sync failed for item 2'));
    const getProductInventory = vi
      .fn()
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 5],
          ['spec-black', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 12],
          ['spec-black', 8],
        ]),
      );
    const updateMany = vi.fn();
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi
          .fn()
          .mockReturnValue({ syncInventory, getProductInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).rejects.toThrow('Douyin inventory sync failed for item 2');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('quarantines an unknown write and stays offline when v4 lands after v5', async () => {
    let platformState = 'online' as 'online' | 'offline';
    let platformStocks = [
      ['spec-white', 5],
      ['spec-black', 8],
    ] as Array<[string, number]>;
    let applyLateV4 = () => undefined;
    const getProductInventory = vi
      .fn()
      .mockImplementation(async () => platformInventory(platformStocks, platformState));
    const syncInventory = vi.fn().mockImplementationOnce(async (_token, request) => {
      applyLateV4 = () => {
        platformStocks = request.items.map((item) => [item.sourceSkuId, item.stock]);
      };
      const error = new Error('Douyin inventory sync request failed');
      error.name = 'PlatformMutationResultUnknownError';
      throw error;
    });
    const offlineProduct = vi.fn().mockImplementation(async () => {
      platformState = 'offline';
    });
    const getProductState = vi.fn().mockImplementation(async () => ({
      state: platformState,
      status: platformState === 'offline' ? 1 : 0,
      checkStatus: 3,
    }));
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({
          syncInventory,
          getProductInventory,
          getProductState,
          offlineProduct,
        }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('processed');

    platformStocks = [
      ['spec-white', 2],
      ['spec-black', 3],
    ];
    applyLateV4();
    expect(platformStocks).toEqual([
      ['spec-white', 12],
      ['spec-black', 0],
    ]);
    expect(platformState).toBe('offline');
    expect(offlineProduct).toHaveBeenCalledWith('mock-token', '998877');
    expect(getProductState).toHaveBeenCalledWith('mock-token', '998877');
    expect(getProductInventory).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 7n, platformProductId: '998877', status: 'online' },
        data: expect.objectContaining({
          status: 'offline',
          inventorySyncStatus: 'pending',
          inventorySyncReason: 'inventory_result_unknown',
        }),
      }),
    );
    const quarantineData = updateMany.mock.calls[1]![0].data;
    expect(quarantineData).not.toHaveProperty('inventoryTargetFingerprint');
    expect(quarantineData).not.toHaveProperty('inventoryTargetVersion');
  });

  it('does not mark an old target synced when the source changed before completion', async () => {
    const syncInventory = vi.fn();
    const getProductInventory = vi.fn().mockResolvedValue(
      platformInventory([
        ['spec-white', 12],
        ['spec-black', 0],
      ]),
    );
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi
          .fn()
          .mockReturnValue({ syncInventory, getProductInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('stale');

    expect(syncInventory).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceProduct: {
            inventoryFingerprint: FINGERPRINT,
            inventoryVersion: 4,
          },
        }),
        data: expect.objectContaining({ inventorySyncStatus: 'synced' }),
      }),
    );
  });

  it('refuses an online inventory write when the adapter cannot read it back', async () => {
    const syncInventory = vi.fn();
    const updateMany = vi.fn();
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({ syncInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).rejects.toThrow(
      '当前平台无法回读 SKU 库存，拒绝执行库存同步',
    );
    expect(syncInventory).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'duplicate source IDs',
      sourceSkus: [
        { skuId: 'spec-white', stock: 12 },
        { skuId: 'spec-white', stock: 0 },
      ],
    },
    {
      name: 'missing source ID',
      sourceSkus: [{ stock: 12 }, { skuId: 'spec-black', stock: 0 }],
    },
    {
      name: 'fractional stock',
      sourceSkus: [
        { skuId: 'spec-white', stock: 1.5 },
        { skuId: 'spec-black', stock: 0 },
      ],
    },
    {
      name: 'negative stock',
      sourceSkus: [
        { skuId: 'spec-white', stock: -1 },
        { skuId: 'spec-black', stock: 0 },
      ],
    },
    {
      name: 'unsafe integer stock',
      sourceSkus: [
        { skuId: 'spec-white', stock: Number.MAX_SAFE_INTEGER + 1 },
        { skuId: 'spec-black', stock: 0 },
      ],
    },
    {
      name: 'extra current SKU',
      sourceSkus: [
        { skuId: 'spec-white', stock: 12 },
        { skuId: 'spec-black', stock: 0 },
        { skuId: 'spec-green', stock: 3 },
      ],
    },
    {
      name: 'mismatched current SKU set',
      sourceSkus: [
        { skuId: 'spec-white', stock: 12 },
        { skuId: 'spec-blue', stock: 0 },
      ],
    },
  ])('fails closed for invalid current inventory: $name', async ({ sourceSkus }) => {
    const base = inventoryRecord();
    const syncInventory = vi.fn();
    const getProductInventory = vi.fn();
    const offlineProduct = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(
            inventoryRecord({
              sourceProduct: { ...base.sourceProduct, skuList: sourceSkus },
            }),
          ),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({
          syncInventory,
          getProductInventory,
          getProductState: vi.fn().mockResolvedValue({
            state: 'offline',
            status: 1,
            checkStatus: 3,
          }),
          offlineProduct,
        }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('processed');
    expect(syncInventory).not.toHaveBeenCalled();
    expect(getProductInventory).not.toHaveBeenCalled();
    expect(offlineProduct).toHaveBeenCalledWith('mock-token', '998877');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'offline',
          inventorySyncReason: 'source_sku_changed',
        }),
      }),
    );
  });

  it('fails closed for duplicate external SKU IDs in the publish snapshot', async () => {
    const base = inventoryRecord();
    const syncInventory = vi.fn();
    const getProductInventory = vi.fn();
    const offlineProduct = vi.fn().mockResolvedValue(undefined);
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(
            inventoryRecord({
              task: {
                ...base.task,
                skuSnapshot: {
                  douyin: {
                    dimensions: ['颜色'],
                    skus: [
                      { sourceSkuId: 'spec-white', stock: 20 },
                      { sourceSkuId: 'spec-white', stock: 20 },
                    ],
                  },
                },
              },
            }),
          ),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({
          syncInventory,
          getProductInventory,
          getProductState: vi.fn().mockResolvedValue({
            state: 'offline',
            status: 1,
            checkStatus: 3,
          }),
          offlineProduct,
        }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).resolves.toBe('processed');
    expect(syncInventory).not.toHaveBeenCalled();
    expect(getProductInventory).not.toHaveBeenCalled();
    expect(offlineProduct).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'duplicate IDs',
      items: [
        { sourceSkuId: 'spec-white', stock: 12 },
        { sourceSkuId: 'spec-white', stock: 0 },
      ],
    },
    { name: 'missing SKU', items: [{ sourceSkuId: 'spec-white', stock: 12 }] },
    {
      name: 'extra SKU',
      items: [
        { sourceSkuId: 'spec-white', stock: 12 },
        { sourceSkuId: 'spec-black', stock: 0 },
        { sourceSkuId: 'spec-green', stock: 3 },
      ],
    },
    {
      name: 'mismatched set',
      items: [
        { sourceSkuId: 'spec-white', stock: 12 },
        { sourceSkuId: 'spec-blue', stock: 0 },
      ],
    },
    {
      name: 'fractional stock',
      items: [
        { sourceSkuId: 'spec-white', stock: 12.5 },
        { sourceSkuId: 'spec-black', stock: 0 },
      ],
    },
    {
      name: 'negative stock',
      items: [
        { sourceSkuId: 'spec-white', stock: 12 },
        { sourceSkuId: 'spec-black', stock: -1 },
      ],
    },
  ])('rejects invalid platform readback before writing: $name', async ({ items }) => {
    const syncInventory = vi.fn();
    const getProductInventory = vi.fn().mockResolvedValue({
      state: 'online',
      status: 4,
      checkStatus: 4,
      items,
    });
    const updateMany = vi.fn();
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(inventoryRecord()),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi
          .fn()
          .mockReturnValue({ syncInventory, getProductInventory, offlineProduct: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).rejects.toThrow(
      '平台返回的 SKU 库存不完整，无法确认同步结果',
    );
    expect(syncInventory).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
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
        create: vi.fn().mockReturnValue({
          syncInventory,
          getProductState: vi.fn().mockResolvedValue({
            state: 'offline',
            status: 1,
            checkStatus: 3,
          }),
          offlineProduct,
        }),
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
          platformStatusRaw: 1,
          platformCheckStatusRaw: 3,
        }),
      }),
    );
  });

  it('does not mark an unavailable source offline until platform readback confirms it', async () => {
    const base = inventoryRecord();
    const offlineProduct = vi.fn().mockResolvedValue(undefined);
    const getProductState = vi.fn().mockResolvedValue({
      state: 'online',
      status: 0,
      checkStatus: 3,
    });
    const updateMany = vi.fn();
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
        publishedProduct: {
          findUnique: vi.fn().mockResolvedValue(
            inventoryRecord({
              sourceProduct: { ...base.sourceProduct, availability: 'out_of_stock' },
            }),
          ),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        create: vi.fn().mockReturnValue({
          syncInventory: vi.fn(),
          getProductState,
          offlineProduct,
        }),
      } as unknown as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.execute(JOB)).rejects.toThrow('平台尚未确认商品下架');
    expect(offlineProduct).toHaveBeenCalledWith('mock-token', '998877');
    expect(getProductState).toHaveBeenCalledWith('mock-token', '998877');
    expect(updateMany).not.toHaveBeenCalled();
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

  it('fails a bound job only while the same binding is current', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn().mockReturnValue('3') } as unknown as ConfigService,
      { publishedProduct: { updateMany } } as unknown as PrismaService,
      {} as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.fail(BOUND_JOB, 'platform unavailable')).resolves.toBe('retry_wait');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceBindings: {
            some: expect.objectContaining({ ...BINDING_GUARD, currentSlot: 1 }),
          },
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
    const getProductInventory = vi
      .fn()
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 5],
          ['spec-black', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['spec-white', 12],
          ['spec-black', 0],
        ]),
      );
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
        create: vi
          .fn()
          .mockReturnValue({ syncInventory, getProductInventory, offlineProduct: vi.fn() }),
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

  it('manually retries against the current replacement source', async () => {
    const nextFingerprint = 'f'.repeat(64);
    const binding = sourceBinding({
      sourceProduct: {
        availability: 'available',
        inventoryFingerprint: nextFingerprint,
        inventoryVersion: 8,
        skuList: [
          { skuId: 'new-spec-white', stock: 15 },
          { skuId: 'new-spec-black', stock: 7 },
        ],
      },
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new InventorySyncService(
      { get: vi.fn() } as unknown as ConfigService,
      {
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
            sourceBindings: [binding],
          }),
          updateMany,
        },
      } as unknown as PrismaService,
      {} as PlatformAdapterFactory,
      {} as ShopTokenService,
      productLocks(),
    );

    await expect(service.manualRetry(1n, '7')).resolves.toEqual({
      publishedProductId: '7',
      queued: true,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceBindings: {
            some: expect.objectContaining({ ...BINDING_GUARD, currentSlot: 1 }),
          },
        }),
        data: expect.objectContaining({
          inventorySyncStatus: 'pending',
          inventoryTargetFingerprint: nextFingerprint,
          inventoryTargetVersion: 8,
        }),
      }),
    );
  });
});
