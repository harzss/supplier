import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import type { PlatformProductLockService } from './platform-product-lock.service';
import { ProductBatchService, type ProductBatchExecutionRecord } from './product-batch.service';

const NOW = new Date('2026-08-04T08:00:00.000Z');
const CLIENT_REQUEST_ID = '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1';
const USER = { userId: 1n, plan: 'pro' } as CurrentUser;

describe('ProductBatchService', () => {
  it('replays the same preview request without creating another task', async () => {
    const fixture = createFixture();
    const replay = taskRecord({
      requestFingerprint: fingerprint('offline', ['11', '12']),
      items: [],
    });
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(replay);

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'offline',
        publishedProductIds: ['12', '11'],
      }),
    ).resolves.toMatchObject({ taskId: '41', status: 'preview' });

    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.findMany).not.toHaveBeenCalled();
  });

  it('rejects a replay key that was used for a different target set', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(
      taskRecord({ requestFingerprint: fingerprint('offline', ['11']), items: [] }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'offline',
        publishedProductIds: ['12'],
      }),
    ).rejects.toThrow('该请求标识已用于不同的批量操作');
  });

  it('does not create a preview when a selected product is outside the current tenant', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([]);

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'offline',
        publishedProductIds: ['11'],
      }),
    ).rejects.toThrow('部分商品不存在、已失效或不属于当前账号');

    expect(fixture.prisma.publishedProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ task: { userId: 1n } }),
      }),
    );
    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
  });

  it('confirms an unchanged preview and queues its pending items', async () => {
    const fixture = createFixture();
    const initial = taskRecord({ items: [taskItem()] });
    const queued = taskRecord({ status: 'queued', confirmedAt: NOW, items: [taskItem()] });
    fixture.prisma.productBatchTask.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(queued);

    const result = await fixture.service.execute(USER, '41', { previewRevision: 1 });

    expect(result.status).toBe('queued');
    expect(fixture.prisma.productBatchTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 41n,
        userId: 1n,
        status: 'preview',
        stateRevision: 1,
        previewRevision: 1,
      },
      data: {
        status: 'queued',
        stateRevision: { increment: 1 },
        confirmedAt: expect.any(Date),
      },
    });
  });

  it('rejects confirmation when the preview revision no longer matches', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ previewRevision: 2, items: [taskItem()] }),
    );

    await expect(fixture.service.execute(USER, '41', { previewRevision: 1 })).rejects.toThrow(
      '批量预览已变化',
    );

    expect(fixture.prisma.productBatchTask.updateMany).not.toHaveBeenCalled();
  });

  it('cancels only items that have not started', async () => {
    const fixture = createFixture();
    const pending = taskItem();
    const initial = taskRecord({ status: 'queued', confirmedAt: NOW, items: [pending] });
    const cancelled = taskRecord({
      status: 'cancelled',
      confirmedAt: NOW,
      cancelRequestedAt: NOW,
      finishedAt: NOW,
      items: [taskItem({ status: 'cancelled', finishedAt: NOW })],
    });
    fixture.prisma.productBatchTask.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(cancelled);
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'cancelling',
      confirmedAt: NOW,
      cancelRequestedAt: NOW,
      items: [{ status: 'cancelled' }],
    });

    await expect(fixture.service.cancel(USER, '41')).resolves.toMatchObject({
      status: 'cancelled',
    });

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith({
      where: { taskId: 41n, status: { in: ['pending', 'retry_wait'] } },
      data: expect.objectContaining({
        status: 'cancelled',
        lockedAt: null,
        lockedBy: null,
      }),
    });
  });

  it('retries failed items without resetting successful items', async () => {
    const fixture = createFixture();
    const failed = taskItem({ id: 51n, status: 'failed', finishedAt: NOW });
    const succeeded = taskItem({ id: 52n, status: 'succeeded', finishedAt: NOW });
    const initial = taskRecord({ status: 'partial', confirmedAt: NOW, items: [failed, succeeded] });
    const queued = taskRecord({
      status: 'queued',
      confirmedAt: NOW,
      items: [taskItem({ id: 51n }), succeeded],
    });
    fixture.prisma.productBatchTask.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(queued);

    await expect(fixture.service.retry(USER, '41', {})).resolves.toMatchObject({
      status: 'queued',
    });

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [51n] }, status: 'failed' },
      data: expect.objectContaining({
        status: 'pending',
        attempts: 0,
        errorCode: null,
        errorMessage: null,
      }),
    });
  });

  it('rejects a duplicate retry when another request already moved the failed item', async () => {
    const fixture = createFixture();
    const failed = taskItem({ id: 51n, status: 'failed', finishedAt: NOW });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ status: 'partial', confirmedAt: NOW, items: [failed] }),
    );
    fixture.prisma.productBatchItem.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(fixture.service.retry(USER, '41', {})).rejects.toThrow('失败项状态已变化，请刷新');
  });

  it('claims an item with compare-and-set and retries after a lost race', async () => {
    const fixture = createFixture();
    const candidate = {
      id: 51n,
      taskId: 41n,
      status: 'pending',
      attempts: 0,
      startedAt: null,
    };
    const claimed = executionRecord();
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(candidate);
    fixture.prisma.productBatchItem.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    fixture.prisma.productBatchItem.findUnique.mockResolvedValue(claimed);

    await expect(fixture.service.claimNext('worker-1')).resolves.toEqual(claimed);

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 51n,
        status: 'pending',
        attempts: 0,
        task: { cancelRequestedAt: null, status: { in: ['queued', 'running'] } },
      },
      data: expect.objectContaining({
        status: 'running',
        attempts: { increment: 1 },
        lockedBy: 'worker-1',
      }),
    });
  });

  it('recovers a stale running item into retry wait before claiming new work', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchItem.findMany.mockResolvedValue([
      {
        id: 51n,
        taskId: 41n,
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        lockedBy: 'dead-worker',
        task: { cancelRequestedAt: null },
      },
    ]);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(null);
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'running',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'retry_wait' }],
    });

    await expect(fixture.service.claimNext('worker-2')).resolves.toBeNull();

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 51n,
        status: 'running',
        attempts: 1,
        lockedBy: 'dead-worker',
      },
      data: expect.objectContaining({
        status: 'retry_wait',
        errorCode: 'WORKER_STALE',
        lockedAt: null,
        lockedBy: null,
      }),
    });
    expect(fixture.prisma.productBatchTask.updateMany).toHaveBeenCalledWith({
      where: { id: 41n, stateRevision: 1 },
      data: { status: 'queued', stateRevision: { increment: 1 }, finishedAt: null },
    });
  });

  it('reconciles an active task whose items were already terminal after an interrupted refresh', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findMany.mockResolvedValue([{ id: 41n }]);
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'running',
      stateRevision: 3,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'succeeded' }],
    });
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(null);

    await expect(fixture.service.claimNext('worker-2')).resolves.toBeNull();

    expect(fixture.prisma.productBatchTask.updateMany).toHaveBeenCalledWith({
      where: { id: 41n, stateRevision: 3 },
      data: {
        status: 'succeeded',
        stateRevision: { increment: 1 },
        finishedAt: expect.any(Date),
      },
    });
  });

  it('retries task aggregation when another worker wins the state revision CAS', async () => {
    const fixture = createFixture();
    const item = executionRecord({ attempts: 3, maxAttempts: 3 });
    fixture.prisma.productBatchTask.findUnique
      .mockResolvedValueOnce({
        id: 41n,
        status: 'running',
        stateRevision: 5,
        confirmedAt: NOW,
        cancelRequestedAt: null,
        items: [{ status: 'running' }],
      })
      .mockResolvedValueOnce({
        id: 41n,
        status: 'running',
        stateRevision: 6,
        confirmedAt: NOW,
        cancelRequestedAt: null,
        items: [{ status: 'failed' }],
      });
    fixture.prisma.productBatchTask.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(fixture.service.failClaimedItem(item, new Error('platform failed'))).resolves.toBe(
      'failed',
    );

    expect(fixture.prisma.productBatchTask.updateMany).toHaveBeenLastCalledWith({
      where: { id: 41n, stateRevision: 6 },
      data: {
        status: 'failed',
        stateRevision: { increment: 1 },
        finishedAt: expect.any(Date),
      },
    });
  });

  it('persists an offline result only after a real platform readback confirms it', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.offlineProduct.mockResolvedValue(undefined);
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.adapter.getProductState).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 11n,
          mutationRevision: 1,
          status: 'online',
        }),
        data: expect.objectContaining({
          status: 'offline',
          mutationRevision: { increment: 1 },
          inventorySyncReason: 'manual_batch_offline',
          platformStatusRaw: 1,
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({ reason: 'offline_confirmed', recovered: false }),
        }),
      }),
    );
  });

  it('fails closed before offlining when a real adapter cannot read product state', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    const offlineProduct = vi.fn();
    fixture.prepareExecution(item);
    fixture.adapters.create.mockReturnValue({ offlineProduct });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '当前平台无法回读商品状态，拒绝执行下架',
    );

    expect(offlineProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
  });

  it('reconciles a recovered retry that is already offline without repeating the mutation', async () => {
    const fixture = createFixture();
    const item = executionRecord({ attempts: 2 });
    fixture.prepareExecution(item);
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.getProductState).toHaveBeenCalledOnce();
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'offline',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'platform_result_recovered',
            recovered: true,
          }),
        }),
      }),
    );
  });

  it('recovers an unknown offline response by reading the platform state', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.offlineProduct.mockRejectedValue(new Error('request timed out'));
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.getProductState).toHaveBeenCalledOnce();
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'platform_result_recovered',
            recovered: true,
          }),
        }),
      }),
    );
  });

  it('stops before calling the platform when the product revision changed after preview', async () => {
    const fixture = createFixture();
    const claimed = executionRecord();
    const changed = executionRecord({
      publishedProduct: publishedProduct({ mutationRevision: 2, task: { userId: 1n } }),
    });
    fixture.prisma.productBatchItem.findUnique.mockResolvedValue(changed);

    await expect(fixture.service.executeClaimed(claimed)).rejects.toThrow('商品已在预览后发生变化');

    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
    expect(fixture.productLocks.release).toHaveBeenCalledWith(11n, 'product-lock');
  });
});

function createFixture() {
  const adapter = {
    offlineProduct: vi.fn(),
    getProductState: vi.fn(),
  };
  const prisma = {
    $transaction: vi.fn().mockImplementation(async (operations: unknown) => {
      if (typeof operations === 'function') {
        return operations(prisma);
      }
      return Array.isArray(operations) ? Promise.all(operations) : operations;
    }),
    productBatchTask: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    productBatchItem: {
      count: vi.fn().mockResolvedValue(1),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    publishedProduct: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const entitlement = { assertFeature: vi.fn() };
  const adapters = { create: vi.fn().mockReturnValue(adapter) };
  const shopTokens = { getAccessToken: vi.fn().mockResolvedValue('shop-token') };
  const productLocks = {
    acquire: vi.fn().mockResolvedValue('product-lock'),
    renew: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const configValues: Record<string, string> = {
    AUTH_MODE: 'supabase',
    PRODUCT_BATCH_ENABLED: 'true',
    PRODUCT_BATCH_MAX_ATTEMPTS: '3',
  };
  const service = new ProductBatchService(
    { get: vi.fn((key: string) => configValues[key]) } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    entitlement as unknown as EntitlementService,
    adapters as unknown as PlatformAdapterFactory,
    shopTokens as unknown as ShopTokenService,
    productLocks as unknown as PlatformProductLockService,
  );
  return {
    service,
    prisma,
    adapter,
    adapters,
    productLocks,
    prepareExecution(item: ProductBatchExecutionRecord) {
      prisma.productBatchItem.findUnique.mockResolvedValue(item);
      prisma.productBatchTask.findUnique.mockResolvedValue({
        id: item.taskId,
        status: 'running',
        stateRevision: 1,
        confirmedAt: NOW,
        cancelRequestedAt: null,
        items: [{ status: 'succeeded' }],
      });
    },
  };
}

function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 41n,
    userId: 1n,
    clientRequestId: CLIENT_REQUEST_ID,
    requestFingerprint: fingerprint('offline', ['11']),
    action: 'offline',
    status: 'preview',
    stateRevision: 1,
    previewRevision: 1,
    cancelRequestedAt: null,
    confirmedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    items: [],
    ...overrides,
  };
}

function taskItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 51n,
    taskId: 41n,
    publishedProductId: 11n,
    ordinal: 0,
    status: 'pending',
    expectedMutationRevision: 1,
    beforeSnapshot: {
      status: 'online',
      platformProductId: '998877',
      shopId: '21',
    },
    desiredSnapshot: { status: 'offline' },
    result: null,
    errorCode: null,
    errorMessage: null,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: NOW,
    lockedAt: null,
    lockedBy: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    publishedProduct: publishedProduct(),
    ...overrides,
  };
}

function executionRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...taskItem({
      status: 'running',
      attempts: 1,
      lockedAt: NOW,
      lockedBy: 'worker-1',
      startedAt: NOW,
    }),
    task: {
      id: 41n,
      userId: 1n,
      clientRequestId: CLIENT_REQUEST_ID,
      requestFingerprint: fingerprint('offline', ['11']),
      action: 'offline',
      status: 'running',
      stateRevision: 1,
      previewRevision: 1,
      cancelRequestedAt: null,
      confirmedAt: NOW,
      startedAt: NOW,
      finishedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    publishedProduct: publishedProduct({ task: { userId: 1n } }),
    ...overrides,
  } as unknown as ProductBatchExecutionRecord;
}

function publishedProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 11n,
    taskId: 101n,
    shopId: 21n,
    sourceProductId: 31n,
    platformProductId: '998877',
    title: '测试商品',
    mainImage: null,
    salePrice: 29.9,
    status: 'online',
    mutationRevision: 1,
    inventorySyncStatus: 'synced',
    publishedAt: NOW,
    shop: {
      id: 21n,
      shopName: '真实抖店',
      platform: 'douyin',
      platformShopId: 'real-douyin-shop',
      role: 'seller',
      status: 'active',
      accessTokenEnc: 'encrypted',
    },
    sourceProduct: {
      productId1688: '16880001',
      availability: 'available',
      mainImage: null,
    },
    ...overrides,
  };
}

function fingerprint(action: string, ids: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ action, publishedProductIds: [...ids].sort() }))
    .digest('hex');
}
