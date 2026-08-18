import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CrawlerError, type CrawledProduct } from '@supplier/crawler';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import type {
  SourceImportAdapterFactory,
  SourceImportRateLimiter,
} from './source-import-adapter.service';
import { SourceImportService, type SourceImportExecutionRecord } from './source-import.service';

const NOW = new Date('2026-08-04T12:00:00.000Z');
const CLIENT_REQUEST_ID = '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1';
const USER: CurrentUser = {
  userId: 1n,
  plan: 'pro',
  entitlementSource: 'internal_beta',
  accessStatus: 'active',
  entitlementRevision: 1,
};

afterEach(() => vi.useRealTimers());

describe('SourceImportService preview and task controls', () => {
  it('replays the same client request id without creating or fetching remote data', async () => {
    const fixture = createFixture();
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      taskRecord({
        buyerShopId: 21n,
        requestFingerprint: fingerprint(['1001', '1002'], 21n),
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        buyerShopId: '21',
        references: ['1002', '1001'],
      }),
    ).resolves.toMatchObject({ taskId: '41', clientRequestId: CLIENT_REQUEST_ID });

    expect(fixture.prisma.sourceImportTask.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          uk_source_import_user_client_request: {
            userId: USER.userId,
            clientRequestId: CLIENT_REQUEST_ID,
          },
        },
      }),
    );
    expect(fixture.prisma.sourceImportTask.create).not.toHaveBeenCalled();
    expect(fixture.adapters.resolveBuyerShop).not.toHaveBeenCalled();
    expect(fixture.adapters.create).not.toHaveBeenCalled();
  });

  it('recovers an omitted-buyer replay even if the original default buyer is no longer active', async () => {
    const fixture = createFixture();
    fixture.adapters.resolveBuyerShop.mockRejectedValue(new Error('buyer authorization expired'));
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      taskRecord({
        buyerShopId: 21n,
        requestFingerprint: fingerprint(['1001'], 21n),
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        references: ['1001'],
      }),
    ).resolves.toMatchObject({ taskId: '41', buyerShopId: '21' });
    expect(fixture.adapters.resolveBuyerShop).not.toHaveBeenCalled();
  });

  it('rejects reuse of a client request id with different parameters', async () => {
    const fixture = createFixture();
    fixture.adapters.resolveBuyerShop.mockResolvedValue(null);
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      taskRecord({ requestFingerprint: fingerprint(['1001'], null) }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        references: ['1002'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.prisma.sourceImportTask.create).not.toHaveBeenCalled();
  });

  it('scopes previews and existing collection state to the current tenant', async () => {
    const fixture = createFixture();
    const otherUser: CurrentUser = {
      userId: 7n,
      plan: 'pro',
      entitlementSource: 'internal_beta',
      accessStatus: 'active',
      entitlementRevision: 1,
    };
    fixture.adapters.resolveBuyerShop.mockResolvedValue(null);
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(null);
    fixture.prisma.sourceProduct.findMany.mockResolvedValue([]);
    fixture.prisma.sourceImportTask.create.mockResolvedValue(
      taskRecord({ userId: otherUser.userId, requestFingerprint: fingerprint(['1001'], null) }),
    );

    await fixture.service.createPreview(otherUser, {
      clientRequestId: CLIENT_REQUEST_ID,
      references: ['https://detail.1688.com/offer/1001.html?spm=tracking-secret#detail'],
    });

    expect(fixture.adapters.resolveBuyerShop).toHaveBeenCalledWith(otherUser.userId, undefined);
    expect(fixture.prisma.sourceProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          userSourceProducts: {
            where: { userId: otherUser.userId },
            select: { id: true },
          },
        }),
      }),
    );
    expect(fixture.prisma.sourceImportTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: otherUser.userId,
          items: {
            create: [
              expect.objectContaining({
                offerId: '1001',
                beforeSnapshot: expect.objectContaining({ reference: '1001' }),
              }),
            ],
          },
        }),
      }),
    );
    expect(fixture.adapters.create).not.toHaveBeenCalled();
  });

  it('never returns a task that belongs to another tenant', async () => {
    const fixture = createFixture();
    fixture.prisma.sourceImportTask.findFirst.mockResolvedValue(null);

    await expect(fixture.service.detail(USER, '41')).rejects.toBeInstanceOf(NotFoundException);
    expect(fixture.prisma.sourceImportTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 41n, userId: USER.userId } }),
    );
  });

  it('executes only the exact preview revision and returns the queued snapshot', async () => {
    const fixture = createFixture();
    const preview = taskRecord({ status: 'preview', previewRevision: 3 });
    const queued = taskRecord({ status: 'queued', previewRevision: 3, confirmedAt: NOW });
    fixture.prisma.sourceImportTask.findFirst
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(queued);

    await expect(
      fixture.service.execute(USER, '41', { previewRevision: 3 }),
    ).resolves.toMatchObject({
      status: 'queued',
      previewRevision: 3,
    });
    expect(fixture.prisma.sourceImportTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 41n,
          userId: USER.userId,
          status: 'preview',
          stateRevision: 1,
          previewRevision: 3,
        }),
        data: expect.objectContaining({ status: 'queued', stateRevision: { increment: 1 } }),
      }),
    );
  });

  it('cancels pending work without racing a running item commit', async () => {
    const fixture = createFixture();
    const pending = taskItem({ status: 'pending' });
    const initial = taskRecord({ status: 'running', confirmedAt: NOW, items: [pending] });
    const cancelledItem = taskItem({ status: 'cancelled', finishedAt: NOW });
    const cancelled = taskRecord({
      status: 'cancelled',
      stateRevision: 3,
      confirmedAt: NOW,
      cancelRequestedAt: NOW,
      finishedAt: NOW,
      items: [cancelledItem],
    });
    fixture.prisma.sourceImportTask.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(cancelled);
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      taskRecord({
        status: 'cancelling',
        stateRevision: 2,
        confirmedAt: NOW,
        cancelRequestedAt: NOW,
        items: [{ status: 'cancelled' }],
      }),
    );

    await expect(fixture.service.cancel(USER, '41')).resolves.toMatchObject({
      status: 'cancelled',
      summary: { cancelled: 1 },
    });
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenCalledWith({
      where: { taskId: 41n, status: { in: ['pending', 'retry_wait'] } },
      data: expect.objectContaining({ status: 'cancelled', lockedAt: null, lockedBy: null }),
    });
  });

  it('resets only selected manually retryable failures', async () => {
    const fixture = createFixture();
    const retryable = taskItem({ id: 51n, status: 'failed', errorCode: 'NETWORK' });
    const terminal = taskItem({ id: 52n, status: 'failed', errorCode: 'PARSE' });
    const failed = taskRecord({ status: 'partial', items: [retryable, terminal] });
    const queued = taskRecord({ status: 'queued', items: [taskItem({ id: 51n })] });
    fixture.prisma.sourceImportTask.findFirst
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(queued);

    await expect(fixture.service.retry(USER, '41', { itemIds: ['51'] })).resolves.toMatchObject({
      status: 'queued',
    });
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [51n] }, status: 'failed' },
        data: expect.objectContaining({ status: 'pending', attempts: 0, errorCode: null }),
      }),
    );
  });

  it('rejects non-retryable or unowned selected failures', async () => {
    const fixture = createFixture();
    fixture.prisma.sourceImportTask.findFirst.mockResolvedValue(
      taskRecord({
        status: 'failed',
        items: [taskItem({ id: 51n, status: 'failed', errorCode: 'PARSE' })],
      }),
    );

    await expect(fixture.service.retry(USER, '41', { itemIds: ['51'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('SourceImportService worker safety', () => {
  it('allows only one worker to claim the same candidate', async () => {
    const fixture = createFixture();
    const candidate = taskItem({ status: 'pending' });
    const claimed = executionRecord({ status: 'running', attempts: 1, lockedBy: 'worker-a' });
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue(candidate);
    fixture.prisma.sourceImportItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);

    await expect(fixture.service.claimNext('worker-a')).resolves.toMatchObject({
      id: 51n,
      lockedBy: 'worker-a',
    });
    await expect(fixture.service.claimNext('worker-b')).resolves.toBeNull();

    expect(fixture.prisma.sourceImportTask.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.sourceImportItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          task: expect.objectContaining({
            user: { entitlementAccessStatus: 'active' },
          }),
        }),
      }),
    );
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          task: expect.objectContaining({
            user: { entitlementAccessStatus: 'active' },
          }),
        }),
      }),
    );
  });

  it('does not claim or automatically recover work for a suspended user', async () => {
    const fixture = createFixture();
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue(null);

    await expect(fixture.service.claimNext('worker')).resolves.toBeNull();

    expect(fixture.prisma.sourceImportItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          task: { user: { entitlementAccessStatus: 'active' } },
        }),
      }),
    );
    expect(fixture.prisma.sourceImportItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          task: expect.objectContaining({
            user: { entitlementAccessStatus: 'active' },
          }),
        }),
      }),
    );
    expect(fixture.prisma.sourceImportTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user: { entitlementAccessStatus: 'active' },
        }),
      }),
    );
    expect(fixture.prisma.sourceImportItem.updateMany).not.toHaveBeenCalled();
  });

  it('preserves a running item when stale recovery races with task cancellation', async () => {
    const fixture = createFixture();
    fixture.prisma.sourceImportItem.findMany.mockResolvedValue([
      {
        ...taskItem({ status: 'running', attempts: 1, lockedAt: new Date(0), lockedBy: 'old' }),
        task: { cancelRequestedAt: null },
      },
    ]);
    fixture.prisma.sourceImportItem.updateMany.mockResolvedValue({ count: 0 });
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue(null);

    await expect(fixture.service.claimNext('worker')).resolves.toBeNull();
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          task: {
            status: { in: ['queued', 'running'] },
            cancelRequestedAt: null,
            user: { entitlementAccessStatus: 'active' },
          },
        }),
      }),
    );
  });

  it('does not call the remote adapter for an item whose task is already terminal', async () => {
    const fixture = createFixture();
    const claimed = executionRecord();
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(
      executionRecord({ task: { ...claimed.task, status: 'succeeded' } }),
    );

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('stale');
    expect(fixture.adapters.create).not.toHaveBeenCalled();
  });

  it('does not create an adapter after a claimed user is suspended', async () => {
    const fixture = createFixture();
    const claimed = executionRecord();
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue(null);

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('stale');

    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.rateLimiter.take).not.toHaveBeenCalled();
  });

  it('rechecks active ownership immediately before the remote fetch', async () => {
    const fixture = createFixture();
    const claimed = executionRecord();
    const fetchProduct = vi.fn();
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);
    fixture.prisma.sourceImportItem.findFirst
      .mockResolvedValueOnce({ id: claimed.id })
      .mockResolvedValueOnce(null);
    fixture.adapters.create.mockResolvedValue({ demo: true, adapter: { fetchProduct } });

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('stale');

    expect(fixture.adapters.create).toHaveBeenCalledOnce();
    expect(fixture.rateLimiter.take).toHaveBeenCalledOnce();
    expect(fetchProduct).not.toHaveBeenCalled();
  });

  it('retries a serializable global-cache conflict and atomically completes all records', async () => {
    vi.useFakeTimers();
    const fetchStartedAt = new Date('2026-08-04T12:01:00.000Z');
    vi.setSystemTime(fetchStartedAt);
    const fixture = createFixture();
    const claimed = executionRecord();
    prepareSuccessfulExecution(fixture, claimed);
    fixture.prisma.$transaction
      .mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), { code: 'P2034' }))
      .mockImplementation(async (operation: TransactionOperation) => operation(fixture.prisma));

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('processed');

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.sourceProduct.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId1688: claimed.offerId },
        create: expect.objectContaining({ syncedAt: fetchStartedAt }),
        update: expect.objectContaining({ syncedAt: fetchStartedAt }),
      }),
    );
    expect(fixture.prisma.userSourceProduct.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          uk_user_source_product: { userId: claimed.task.userId, sourceProductId: 91n },
        },
      }),
    );
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'succeeded' }) }),
    );
  });

  it('does not let a same-millisecond older product response win after a retry', async () => {
    vi.useFakeTimers();
    const oldFetchStartedAt = new Date('2026-08-04T12:01:00.000Z');
    const newerSyncedAt = new Date(oldFetchStartedAt);
    const oldFetchCompletedAt = new Date('2026-08-04T12:03:00.000Z');
    vi.setSystemTime(oldFetchStartedAt);
    const fixture = createFixture();
    const claimed = executionRecord();
    const fetchProduct = vi.fn().mockImplementation(async () => {
      vi.setSystemTime(oldFetchCompletedAt);
      return crawledProduct({
        title: '旧响应标题',
        price: 10,
        priceMin: 10,
        priceMax: 10,
        skuList: [{ skuId: 'sku-1', specName: '默认', price: 10, stock: 1 }],
      });
    });
    const latest = sourceProduct({
      title: '较新标题',
      price: 88,
      priceMin: 88,
      priceMax: 88,
      skuList: [{ skuId: 'sku-1', specName: '默认', price: 88, stock: 33 }],
      totalStock: 33,
      inventoryFingerprint: 'newer-fingerprint',
      inventoryVersion: 7,
      syncedAt: newerSyncedAt,
    });
    const prior = sourceProduct({
      title: '更早快照',
      totalStock: 5,
      inventoryFingerprint: 'prior-fingerprint',
      inventoryVersion: 6,
      syncedAt: new Date('2026-08-04T12:00:00.000Z'),
    });
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);
    fixture.adapters.create.mockResolvedValue({ demo: true, adapter: { fetchProduct } });
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue({ id: claimed.id });
    fixture.prisma.sourceProduct.findUnique
      .mockResolvedValueOnce(prior)
      .mockResolvedValueOnce(latest);
    fixture.prisma.sourceProduct.upsert.mockResolvedValue(
      sourceProduct({
        title: '旧响应标题',
        price: 10,
        skuList: [{ skuId: 'sku-1', specName: '默认', price: 10, stock: 1 }],
        totalStock: 1,
        inventoryVersion: 7,
        syncedAt: oldFetchStartedAt,
      }),
    );
    fixture.prisma.userSourceProduct.upsert.mockResolvedValue({ id: 81n });
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      refreshTaskRecord('running', [{ status: 'succeeded' }]),
    );
    let transactionAttempt = 0;
    fixture.prisma.$transaction.mockImplementation(async (operation: TransactionOperation) => {
      transactionAttempt++;
      const result = await operation(fixture.prisma);
      if (transactionAttempt === 1) {
        throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
      }
      return result;
    });

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('processed');

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
    // The first write belongs to the transaction that Prisma reports as aborted. The retry must
    // observe the newer committed snapshot and must not issue a second global write or queue.
    expect(fixture.prisma.sourceProduct.upsert).toHaveBeenCalledOnce();
    expect(fixture.prisma.sourceProduct.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ title: '旧响应标题', syncedAt: oldFetchStartedAt }),
      }),
    );
    expect(fixture.prisma.sourceProduct.update).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.userSourceProduct.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          uk_user_source_product: { userId: claimed.task.userId, sourceProductId: latest.id },
        },
      }),
    );
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'stale_response_ignored',
            title: '较新标题',
            price: 88,
            totalStock: 33,
            availability: 'available',
          }),
        }),
      }),
    );
    expect(latest).toMatchObject({
      title: '较新标题',
      price: 88,
      totalStock: 33,
      inventoryVersion: 7,
      syncedAt: newerSyncedAt,
    });
  });

  it('does not let a same-millisecond older not-found response offline a successful refresh', async () => {
    vi.useFakeTimers();
    const oldFetchStartedAt = new Date('2026-08-04T12:01:00.000Z');
    const newerSyncedAt = new Date(oldFetchStartedAt);
    vi.setSystemTime(oldFetchStartedAt);
    const fixture = createFixture();
    const claimed = executionRecord();
    const fetchProduct = vi.fn().mockImplementation(async () => {
      vi.setSystemTime('2026-08-04T12:03:00.000Z');
      return null;
    });
    const latest = sourceProduct({
      title: '较新在线商品',
      totalStock: 45,
      inventoryFingerprint: 'newer-fingerprint',
      inventoryVersion: 9,
      syncedAt: newerSyncedAt,
    });
    const prior = sourceProduct({
      title: '更早在线快照',
      totalStock: 5,
      inventoryFingerprint: 'prior-fingerprint',
      inventoryVersion: 8,
      syncedAt: new Date('2026-08-04T12:00:00.000Z'),
    });
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);
    fixture.adapters.create.mockResolvedValue({ demo: true, adapter: { fetchProduct } });
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue({ id: claimed.id });
    fixture.prisma.sourceProduct.findUnique
      .mockResolvedValueOnce(prior)
      .mockResolvedValueOnce(latest);
    fixture.prisma.sourceProduct.update.mockResolvedValue(
      sourceProduct({
        title: '更早在线快照',
        availability: 'offline',
        totalStock: 0,
        inventoryVersion: 9,
        syncedAt: oldFetchStartedAt,
      }),
    );
    fixture.prisma.userSourceProduct.upsert.mockResolvedValue({ id: 81n });
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      refreshTaskRecord('running', [{ status: 'succeeded' }]),
    );
    let transactionAttempt = 0;
    fixture.prisma.$transaction.mockImplementation(async (operation: TransactionOperation) => {
      transactionAttempt++;
      const result = await operation(fixture.prisma);
      if (transactionAttempt === 1) {
        throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
      }
      return result;
    });

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('processed');

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.sourceProduct.update).toHaveBeenCalledOnce();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.userSourceProduct.upsert).toHaveBeenCalled();
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'stale_response_ignored',
            title: '较新在线商品',
            totalStock: 45,
            availability: 'available',
          }),
        }),
      }),
    );
    expect(latest).toMatchObject({
      availability: 'available',
      totalStock: 45,
      inventoryVersion: 9,
      syncedAt: newerSyncedAt,
    });
  });

  it('does not downgrade a committed success when the transaction ACK is lost', async () => {
    const fixture = createFixture();
    const claimed = executionRecord();
    prepareSuccessfulExecution(fixture, claimed);
    let persistedStatus = 'running';
    fixture.prisma.sourceImportItem.updateMany.mockImplementation(
      async ({ where, data }: { where: { status?: string }; data: { status?: string } }) => {
        if (where.status && where.status !== persistedStatus) return { count: 0 };
        if (data.status) persistedStatus = data.status;
        return { count: 1 };
      },
    );
    const ackError = Object.assign(new Error('connection dropped after commit'), { code: 'P1001' });
    fixture.prisma.$transaction.mockImplementation(async (operation: TransactionOperation) => {
      await operation(fixture.prisma);
      throw ackError;
    });

    await expect(fixture.service.executeClaimed(claimed)).rejects.toBe(ackError);
    await expect(fixture.service.failClaimedItem(claimed, ackError)).resolves.toBe('stale');

    expect(persistedStatus).toBe('succeeded');
  });

  it('treats ownership loss as stale instead of overwriting the new owner', async () => {
    const fixture = createFixture();
    const claimed = executionRecord();
    prepareSuccessfulExecution(fixture, claimed);
    fixture.prisma.sourceImportItem.updateMany.mockResolvedValue({ count: 0 });

    let error: unknown;
    try {
      await fixture.service.executeClaimed(claimed);
    } catch (caught) {
      error = caught;
    }
    await expect(fixture.service.failClaimedItem(claimed, error)).resolves.toBe('stale');
    expect(fixture.prisma.sourceImportItem.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('skips a never-seen offer only on an explicit not-found response', async () => {
    const fixture = createFixture();
    const claimed = executionRecord();
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);
    fixture.adapters.create.mockResolvedValue({
      demo: true,
      adapter: { fetchProduct: vi.fn().mockResolvedValue(null) },
    });
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue({ id: claimed.id });
    fixture.prisma.sourceProduct.findUnique.mockResolvedValue(null);
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      refreshTaskRecord('running', [{ status: 'skipped' }]),
    );

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('processed');
    expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'skipped',
          errorCode: 'NOT_FOUND',
          result: { reason: 'not_found' },
        }),
      }),
    );
    expect(fixture.prisma.sourceProduct.update).not.toHaveBeenCalled();
    expect(fixture.prisma.userSourceProduct.upsert).not.toHaveBeenCalled();
  });

  it('marks an existing globally cached offer offline and queues inventory sync on not-found', async () => {
    vi.useFakeTimers();
    const fetchStartedAt = new Date('2026-08-04T12:05:00.000Z');
    vi.setSystemTime(fetchStartedAt);
    const fixture = createFixture();
    const claimed = executionRecord();
    fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);
    fixture.adapters.create.mockResolvedValue({
      demo: true,
      adapter: { fetchProduct: vi.fn().mockResolvedValue(null) },
    });
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue({ id: claimed.id });
    fixture.prisma.sourceProduct.findUnique.mockResolvedValue(sourceProduct());
    fixture.prisma.sourceProduct.update.mockResolvedValue(
      sourceProduct({ availability: 'offline', totalStock: 0, inventoryVersion: 5 }),
    );
    fixture.prisma.userSourceProduct.upsert.mockResolvedValue({ id: 81n });
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      refreshTaskRecord('running', [{ status: 'succeeded' }]),
    );

    await expect(fixture.service.executeClaimed(claimed)).resolves.toBe('processed');
    expect(fixture.prisma.sourceProduct.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 91n },
        data: expect.objectContaining({
          availability: 'offline',
          totalStock: 0,
          inventoryVersion: 5,
          syncedAt: fetchStartedAt,
        }),
      }),
    );
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ inventorySyncStatus: 'pending' }),
      }),
    );
  });

  it.each([
    ['auth', new CrawlerError('token secret', 'auth'), 'failed', 'AUTH'],
    ['rate limit', new CrawlerError('remote quota', 'rate_limited'), 'retry_wait', 'RATE_LIMITED'],
    ['parse', new CrawlerError('invalid payload', 'parse'), 'failed', 'PARSE'],
  ] as const)(
    'classifies %s failures without unsafe retries',
    async (_label, error, status, code) => {
      const fixture = createFixture();
      const claimed = executionRecord();
      fixture.prisma.sourceImportItem.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
        refreshTaskRecord('running', [{ status }]),
      );

      await expect(fixture.service.failClaimedItem(claimed, error)).resolves.toBe(status);
      expect(fixture.prisma.sourceImportItem.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status, errorCode: code }) }),
      );
    },
  );

  it.each([
    [Object.assign(new Error('postgres host and password'), { code: 'P1001' }), 'DATABASE_ERROR'],
    [new Error('upstream secret response'), 'PLATFORM_ERROR'],
  ] as const)('does not expose internal messages for unknown failures', async (error, code) => {
    const fixture = createFixture();
    const claimed = executionRecord({ attempts: 3 });
    fixture.prisma.sourceImportItem.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      refreshTaskRecord('running', [{ status: 'failed' }]),
    );

    await expect(fixture.service.failClaimedItem(claimed, error)).resolves.toBe('failed');
    const failureWrite = fixture.prisma.sourceImportItem.updateMany.mock.calls.at(-1)?.[0];
    expect(failureWrite.data.errorCode).toBe(code);
    expect(failureWrite.data.errorMessage).not.toContain('password');
    expect(failureWrite.data.errorMessage).not.toContain('secret');
  });

  it('does not churn task revisions when reconciliation has no state change', async () => {
    const fixture = createFixture();
    fixture.prisma.sourceImportTask.findMany.mockResolvedValue([{ id: 41n }]);
    fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
      refreshTaskRecord('queued', [{ status: 'pending' }]),
    );
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue(null);

    await expect(fixture.service.claimNext('worker')).resolves.toBeNull();
    expect(fixture.prisma.sourceImportTask.updateMany).not.toHaveBeenCalled();
  });

  it('throttles task reconciliation across a hot worker drain loop', async () => {
    const fixture = createFixture();
    fixture.prisma.sourceImportTask.findMany.mockResolvedValue([]);
    fixture.prisma.sourceImportItem.findFirst.mockResolvedValue(null);

    await expect(fixture.service.claimNext('worker')).resolves.toBeNull();
    await expect(fixture.service.claimNext('worker')).resolves.toBeNull();

    expect(fixture.prisma.sourceImportTask.findMany).toHaveBeenCalledOnce();
    expect(fixture.prisma.sourceImportTask.findMany).toHaveBeenCalledWith({
      where: {
        confirmedAt: { not: null },
        status: {
          in: ['queued', 'running', 'cancelling', 'cancelled', 'partial', 'succeeded', 'failed'],
        },
        user: { entitlementAccessStatus: 'active' },
      },
      take: 100,
      orderBy: { id: 'asc' },
      select: { id: true },
    });
  });
});

type TransactionOperation = (tx: ReturnType<typeof createPrismaMock>) => Promise<unknown>;

function createFixture() {
  const prisma = createPrismaMock();
  prisma.$transaction.mockImplementation(async (operation: TransactionOperation) =>
    operation(prisma),
  );
  const entitlement = { assertFeature: vi.fn() };
  const adapters = {
    resolveBuyerShop: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
  };
  const rateLimiter = { take: vi.fn().mockResolvedValue(undefined) };
  const values: Record<string, string> = {
    SOURCE_IMPORT_ENABLED: 'true',
    SOURCE_IMPORT_MAX_ATTEMPTS: '3',
  };
  const service = new SourceImportService(
    { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    entitlement as unknown as EntitlementService,
    adapters as unknown as SourceImportAdapterFactory,
    rateLimiter as unknown as SourceImportRateLimiter,
  );
  return { service, prisma, adapters, rateLimiter };
}

function createPrismaMock() {
  return {
    $transaction: vi.fn(),
    sourceImportTask: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sourceImportItem: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sourceProduct: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    userSourceProduct: {
      count: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    publishedProduct: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

function prepareSuccessfulExecution(
  fixture: ReturnType<typeof createFixture>,
  claimed: SourceImportExecutionRecord,
) {
  fixture.prisma.sourceImportItem.findUnique.mockResolvedValue(claimed);
  fixture.adapters.create.mockResolvedValue({
    demo: true,
    adapter: { fetchProduct: vi.fn().mockResolvedValue(crawledProduct()) },
  });
  fixture.prisma.sourceImportItem.findFirst.mockResolvedValue({ id: claimed.id });
  fixture.prisma.sourceProduct.findUnique.mockResolvedValue(null);
  fixture.prisma.sourceProduct.upsert.mockResolvedValue(sourceProduct());
  fixture.prisma.userSourceProduct.upsert.mockResolvedValue({ id: 81n });
  fixture.prisma.sourceImportTask.findUnique.mockResolvedValue(
    refreshTaskRecord('running', [{ status: 'succeeded' }]),
  );
}

function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 41n,
    userId: 1n,
    buyerShopId: null,
    clientRequestId: CLIENT_REQUEST_ID,
    requestFingerprint: fingerprint(['1001'], null),
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
    offerId: '1001',
    ordinal: 0,
    sourceProductId: null,
    userSourceProductId: null,
    status: 'pending',
    beforeSnapshot: { reference: '1001', existing: false, collected: false },
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
    sourceProduct: null,
    ...overrides,
  };
}

function executionRecord(overrides: Record<string, unknown> = {}): SourceImportExecutionRecord {
  return {
    ...taskItem({
      status: 'running',
      attempts: 1,
      lockedAt: NOW,
      lockedBy: 'worker-a',
      startedAt: NOW,
    }),
    task: {
      id: 41n,
      userId: 1n,
      buyerShopId: null,
      clientRequestId: CLIENT_REQUEST_ID,
      requestFingerprint: fingerprint(['1001'], null),
      status: 'running',
      stateRevision: 2,
      previewRevision: 1,
      cancelRequestedAt: null,
      confirmedAt: NOW,
      startedAt: NOW,
      finishedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  } as unknown as SourceImportExecutionRecord;
}

function refreshTaskRecord(status: string, items: Array<{ status: string }>) {
  return taskRecord({ status, confirmedAt: NOW, items });
}

function sourceProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 91n,
    productId1688: '1001',
    supplierId: 'supplier-1',
    title: '测试货源',
    price: 12.5,
    priceMin: 12.5,
    priceMax: 12.5,
    mainImage: 'https://img.example/main.jpg',
    detailImages: [],
    categoryPath: '家居',
    categoryL1: '家居',
    categoryL2: null,
    skuList: [{ skuId: 'sku-1', specName: '默认', price: 12.5, stock: 8 }],
    attributes: {},
    monthlySold: 2,
    isCrossBorder: false,
    isOnePieceDrop: true,
    availability: 'available',
    totalStock: 8,
    inventoryFingerprint: 'old-fingerprint',
    inventoryVersion: 4,
    availabilityChangedAt: NOW,
    syncedAt: NOW,
    ...overrides,
  };
}

function crawledProduct(overrides: Partial<CrawledProduct> = {}): CrawledProduct {
  return {
    productId1688: '1001',
    supplierId: 'supplier-1',
    title: '测试货源',
    price: 12.5,
    priceMin: 12.5,
    priceMax: 12.5,
    mainImage: 'https://img.example/main.jpg',
    detailImages: [],
    categoryPath: '家居',
    categoryL1: '家居',
    skuList: [{ skuId: 'sku-1', specName: '默认', price: 12.5, stock: 8 }],
    attributes: {},
    monthlySold: 2,
    isOnePieceDrop: true,
    ...overrides,
  };
}

function fingerprint(offerIds: string[], buyerShopId: bigint | null): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        buyerShopId: buyerShopId?.toString() ?? null,
        offerIds: [...offerIds].sort(),
      }),
    )
    .digest('hex');
}
