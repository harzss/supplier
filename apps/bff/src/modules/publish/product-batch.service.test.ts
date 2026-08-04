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
  it('exposes SKU price eligibility and range in the candidate list', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        task: {
          skuSnapshot: {
            douyin: {
              skus: [
                { sourceSkuId: 'sku-b', price: 39.9 },
                { sourceSkuId: 'sku-a', price: 29.9 },
              ],
            },
          },
        },
      }),
    ]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'online' }),
    ).resolves.toMatchObject({
      total: 1,
      items: [
        {
          publishedProductId: '11',
          priceEditable: true,
          priceEditReason: null,
          skuCount: 2,
          priceRange: [29.9, 39.9],
        },
      ],
    });
  });

  it('exposes source inventory totals and safe sync eligibility in the candidate list', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        task: {
          skuSnapshot: {
            douyin: {
              skus: [
                { sourceSkuId: 'sku-a', stock: 5, price: 29.9 },
                { sourceSkuId: 'sku-b', stock: 8, price: 39.9 },
              ],
            },
          },
        },
      }),
    ]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'online' }),
    ).resolves.toMatchObject({
      items: [
        {
          sourceTotalStock: 20,
          sourceSkuCount: 2,
          sourceInventoryVersion: 4,
          syncedInventoryVersion: 3,
          inventorySyncEligible: true,
          inventorySyncReason: null,
        },
      ],
    });
  });

  it('exposes title-edit eligibility only for published online or offline products', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(2);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({ status: 'online', task: { skuSnapshot: null } }),
      publishedProduct({ id: 12n, status: 'draft', task: { skuSnapshot: null } }),
    ]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50 }),
    ).resolves.toMatchObject({
      items: [
        { publishedProductId: '11', titleEditable: true, titleEditReason: null },
        {
          publishedProductId: '12',
          titleEditable: false,
          titleEditReason: '只有已发布的在线或下架商品可以改标题',
        },
      ],
    });
  });

  it('blocks title editing while an earlier platform write still needs verification', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({ task: { skuSnapshot: null } }),
    ]);
    fixture.prisma.productBatchItem.findMany.mockResolvedValue([
      { id: 51n, taskId: 41n, publishedProductId: 11n },
    ]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50 }),
    ).resolves.toMatchObject({
      items: [
        {
          titleEditable: false,
          titleEditReason: '存在结果待核验的标题更新，请先在原批量任务核验',
          titleVerificationTaskId: '41',
          titleVerificationItemId: '51',
        },
      ],
    });
  });

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

  it('replays an equivalent target-price request regardless of input order and formatting', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(
      taskRecord({
        action: 'edit_price',
        requestFingerprint: fingerprint('edit_price', ['11', '12'], {
          mode: 'targets',
          targets: [
            { publishedProductId: '11', targetStartPriceCents: 1990 },
            { publishedProductId: '12', targetStartPriceCents: 2900 },
          ],
        }),
        items: [],
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'edit_price',
        publishedProductIds: ['12', '11'],
        priceRule: {
          mode: 'targets',
          targets: [
            { publishedProductId: '12', targetStartPrice: '029.00' },
            { publishedProductId: '11', targetStartPrice: '19.9' },
          ],
        },
      }),
    ).resolves.toMatchObject({ taskId: '41', action: 'edit_price' });

    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
  });

  it('rejects reuse of a price-preview key after the adjustment rule changes', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(
      taskRecord({
        action: 'edit_price',
        requestFingerprint: fingerprint('edit_price', ['11'], {
          mode: 'percentage',
          direction: 'increase',
          basisPoints: 1000,
        }),
        items: [],
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'edit_price',
        publishedProductIds: ['11'],
        priceRule: { mode: 'percentage', direction: 'increase', basisPoints: 1100 },
      }),
    ).rejects.toThrow('该请求标识已用于不同的批量操作');
  });

  it('replays equivalent title targets after trimming and input reordering', async () => {
    const titleTargets = [
      {
        publishedProductId: '11',
        expectedMutationRevision: 1,
        targetTitle: '夏季轻薄纯棉短袖上衣',
      },
      {
        publishedProductId: '12',
        expectedMutationRevision: 1,
        targetTitle: '通勤宽松纯棉圆领短袖',
      },
    ];
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        requestFingerprint: fingerprint('edit_title', ['11', '12'], undefined, titleTargets),
        items: [],
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'edit_title',
        publishedProductIds: ['12', '11'],
        titleTargets: [
          {
            publishedProductId: '12',
            expectedMutationRevision: 1,
            targetTitle: '  通勤宽松纯棉圆领短袖 ',
          },
          {
            publishedProductId: '11',
            expectedMutationRevision: 1,
            targetTitle: '夏季轻薄纯棉短袖上衣',
          },
        ],
      }),
    ).resolves.toMatchObject({ action: 'edit_title' });

    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
  });

  it('rejects a price rule on an inventory-sync preview', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'sync_inventory',
        publishedProductIds: ['11'],
        priceRule: { mode: 'percentage', direction: 'increase', basisPoints: 1000 },
      }),
    ).rejects.toThrow('库存同步不能携带改价规则');

    expect(fixture.prisma.publishedProduct.findMany).not.toHaveBeenCalled();
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

  it('materializes a percentage price rule into absolute per-SKU prices', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        skuPriceSnapshot: priceSnapshot([
          ['sku-a', 2990],
          ['sku-b', 3990],
        ]),
        task: { skuSnapshot: null },
      }),
    ]);
    fixture.prisma.productBatchTask.create.mockImplementation(async ({ data }: any) =>
      taskRecord({
        action: 'edit_price',
        requestFingerprint: data.requestFingerprint,
        items: [],
      }),
    );

    await fixture.service.createPreview(USER, {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'edit_price',
      publishedProductIds: ['11'],
      priceRule: { mode: 'percentage', direction: 'increase', basisPoints: 1000 },
    });

    expect(fixture.prisma.productBatchTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'edit_price',
          items: {
            create: [
              expect.objectContaining({
                beforeSnapshot: expect.objectContaining({
                  salePrice: 29.9,
                  skuPrices: priceSnapshot([
                    ['sku-a', 2990],
                    ['sku-b', 3990],
                  ]),
                }),
                desiredSnapshot: expect.objectContaining({
                  salePrice: 32.89,
                  skuPrices: priceSnapshot([
                    ['sku-a', 3289],
                    ['sku-b', 4389],
                  ]),
                }),
              }),
            ],
          },
        }),
      }),
    );
  });

  it('materializes confirmed and current-source SKU inventory into the preview', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        task: {
          skuSnapshot: {
            douyin: {
              skus: [
                { sourceSkuId: 'sku-a', stock: 5 },
                { sourceSkuId: 'sku-b', stock: 8 },
              ],
            },
          },
        },
      }),
    ]);
    fixture.prisma.productBatchTask.create.mockImplementation(async ({ data }: any) =>
      taskRecord({
        action: 'sync_inventory',
        requestFingerprint: data.requestFingerprint,
        items: [],
      }),
    );

    await fixture.service.createPreview(USER, {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'sync_inventory',
      publishedProductIds: ['11'],
    });

    expect(fixture.prisma.productBatchTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'sync_inventory',
          items: {
            create: [
              expect.objectContaining({
                beforeSnapshot: expect.objectContaining({
                  inventoryFingerprint: 'a'.repeat(64),
                  inventoryVersion: 3,
                  skuInventory: inventorySnapshot([
                    ['sku-a', 5],
                    ['sku-b', 8],
                  ]),
                }),
                desiredSnapshot: expect.objectContaining({
                  inventoryFingerprint: 'b'.repeat(64),
                  inventoryVersion: 4,
                  skuInventory: inventorySnapshot([
                    ['sku-a', 7],
                    ['sku-b', 13],
                  ]),
                }),
              }),
            ],
          },
        }),
      }),
    );
  });

  it('materializes an absolute target title and skips platform-invalid short titles per item', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({ id: 11n, title: '夏季纯棉短袖上衣' }),
      publishedProduct({ id: 12n, title: '通勤纯棉圆领短袖' }),
    ]);
    fixture.prisma.productBatchTask.create.mockImplementation(async ({ data }: any) =>
      taskRecord({ action: 'edit_title', requestFingerprint: data.requestFingerprint, items: [] }),
    );

    await fixture.service.createPreview(USER, {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'edit_title',
      publishedProductIds: ['11', '12'],
      titleTargets: [
        {
          publishedProductId: '11',
          expectedMutationRevision: 1,
          targetTitle: '夏季轻薄纯棉短袖上衣',
        },
        { publishedProductId: '12', expectedMutationRevision: 1, targetTitle: '短袖' },
      ],
    });

    const created = fixture.prisma.productBatchTask.create.mock.calls[0]![0].data.items.create;
    expect(created[0]).toMatchObject({
      status: 'pending',
      beforeSnapshot: { title: '夏季纯棉短袖上衣' },
      desiredSnapshot: { title: '夏季轻薄纯棉短袖上衣' },
    });
    expect(created[1]).toMatchObject({
      status: 'skipped',
      errorCode: 'TITLE_COMPLIANCE_BLOCKED',
      desiredSnapshot: { title: '短袖' },
    });
  });

  it('rejects target prices that do not exactly cover the selected products', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'edit_price',
        publishedProductIds: ['11', '12'],
        priceRule: {
          mode: 'targets',
          targets: [{ publishedProductId: '11', targetStartPrice: '39.90' }],
        },
      }),
    ).rejects.toThrow('逐项目标价必须与所选商品完全一致');

    expect(fixture.prisma.publishedProduct.findMany).not.toHaveBeenCalled();
  });

  it('rejects title targets that do not exactly cover the selected products', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'edit_title',
        publishedProductIds: ['11', '12'],
        titleTargets: [
          {
            publishedProductId: '11',
            expectedMutationRevision: 1,
            targetTitle: '夏季轻薄纯棉短袖上衣',
          },
        ],
      }),
    ).rejects.toThrow('必须有效并与所选商品完全一致');

    expect(fixture.prisma.publishedProduct.findMany).not.toHaveBeenCalled();
  });

  it('rejects a title preview when the selected product revision is stale', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({ mutationRevision: 2 }),
    ]);

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'edit_title',
        publishedProductIds: ['11'],
        titleTargets: [
          {
            publishedProductId: '11',
            expectedMutationRevision: 1,
            targetTitle: '夏季轻薄纯棉短袖上衣',
          },
        ],
      }),
    ).rejects.toThrow('商品已在选择后发生变化');

    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
  });

  it('rejects a new title preview until an unknown earlier mutation is verified', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([publishedProduct()]);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue({ id: 51n });

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'edit_title',
        publishedProductIds: ['11'],
        titleTargets: [
          {
            publishedProductId: '11',
            expectedMutationRevision: 1,
            targetTitle: '夏季轻薄纯棉短袖上衣',
          },
        ],
      }),
    ).rejects.toThrow('存在结果待核验的标题更新');
  });

  it('returns immutable before, desired and platform-read title fields in task detail', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        items: [
          taskItem({
            status: 'succeeded',
            beforeSnapshot: { status: 'online', title: '夏季纯棉短袖上衣' },
            desiredSnapshot: { status: 'online', title: '夏季轻薄纯棉短袖上衣' },
            result: { actualTitle: '夏季轻薄纯棉短袖上衣' },
            publishedProduct: publishedProduct({ title: '夏季轻薄纯棉短袖上衣' }),
          }),
        ],
      }),
    );

    await expect(fixture.service.detail(USER, '41')).resolves.toMatchObject({
      items: [
        {
          beforeTitle: '夏季纯棉短袖上衣',
          desiredTitle: '夏季轻薄纯棉短袖上衣',
          actualTitle: '夏季轻薄纯棉短袖上衣',
        },
      ],
    });
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

  it('blocks manual replay when a title mutation result is still unknown', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        status: 'failed',
        confirmedAt: NOW,
        items: [taskItem({ status: 'failed', errorCode: 'TITLE_RESULT_UNKNOWN', finishedAt: NOW })],
      }),
    );

    await expect(fixture.service.retry(USER, '41', {})).rejects.toThrow(
      '请先在原批量任务核验平台实际标题',
    );
    expect(fixture.prisma.productBatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('verifies an unknown title result as succeeded when the platform shows the target', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date().toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.adapter.getProductTitle.mockResolvedValue(
      platformTitle('夏季轻薄纯棉短袖上衣', 'reviewing'),
    );
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'failed',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'succeeded' }],
    });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        status: 'succeeded',
        confirmedAt: NOW,
        finishedAt: NOW,
        items: [
          taskItem({
            status: 'succeeded',
            beforeSnapshot: item.beforeSnapshot,
            desiredSnapshot: item.desiredSnapshot,
            result: { actualTitle: '夏季轻薄纯棉短袖上衣' },
            publishedProduct: publishedProduct({ title: '夏季轻薄纯棉短袖上衣' }),
          }),
        ],
      }),
    );

    await expect(fixture.service.verifyTitleResult(USER, '41', '51')).resolves.toMatchObject({
      status: 'succeeded',
    });

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: '夏季轻薄纯棉短袖上衣', status: 'draft' }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'succeeded', errorCode: null }),
      }),
    );
  });

  it('keeps an unknown title result unresolved until the five-minute quiet window passes', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date().toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.adapter.getProductTitle.mockResolvedValue(platformTitle('夏季纯棉短袖上衣', 'online'));

    await expect(fixture.service.verifyTitleResult(USER, '41', '51')).rejects.toThrow(
      '5 分钟后再次核验',
    );

    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
  });

  it('keeps an original title unresolved while the platform still reports a reviewing state', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date(Date.now() - 10 * 60_000).toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.adapter.getProductTitle.mockResolvedValue(
      platformTitle('夏季纯棉短袖上衣', 'reviewing'),
    );

    await expect(fixture.service.verifyTitleResult(USER, '41', '51')).rejects.toThrow(
      '平台仍在处理标题更新',
    );
    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
  });

  it('immediately closes an unknown result when the platform shows a third-party title', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date().toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.adapter.getProductTitle.mockResolvedValue(
      platformTitle('人工修改后的第三个标题', 'online'),
    );
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'failed',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'failed' }],
    });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        status: 'failed',
        confirmedAt: NOW,
        finishedAt: NOW,
        items: [taskItem({ status: 'failed', errorCode: 'PLATFORM_TITLE_CHANGED' })],
      }),
    );

    await expect(fixture.service.verifyTitleResult(USER, '41', '51')).resolves.toMatchObject({
      items: [expect.objectContaining({ errorCode: 'PLATFORM_TITLE_CHANGED' })],
    });
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: '人工修改后的第三个标题' }),
      }),
    );
  });

  it('prioritizes a rejected platform state during unknown-result verification', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date().toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.adapter.getProductTitle.mockResolvedValue({
      title: '夏季纯棉短袖上衣',
      state: 'rejected',
      status: 1,
      checkStatus: 4,
    });
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'failed',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'failed' }],
    });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        status: 'failed',
        confirmedAt: NOW,
        finishedAt: NOW,
        items: [taskItem({ status: 'failed', errorCode: 'TITLE_RESULT_REJECTED' })],
      }),
    );

    await expect(fixture.service.verifyTitleResult(USER, '41', '51')).resolves.toMatchObject({
      items: [expect.objectContaining({ errorCode: 'TITLE_RESULT_REJECTED' })],
    });
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'rejected' }),
      }),
    );
  });

  it('closes an unknown platform state instead of leaving the title fence stuck', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date().toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.adapter.getProductTitle.mockResolvedValue({
      title: '夏季纯棉短袖上衣',
      state: 'unknown',
      status: null,
      checkStatus: null,
    });
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'failed',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'failed' }],
    });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        status: 'failed',
        confirmedAt: NOW,
        finishedAt: NOW,
        items: [taskItem({ status: 'failed', errorCode: 'TITLE_RESULT_STATE_INVALID' })],
      }),
    );

    await expect(fixture.service.verifyTitleResult(USER, '41', '51')).resolves.toMatchObject({
      items: [expect.objectContaining({ errorCode: 'TITLE_RESULT_STATE_INVALID' })],
    });
  });

  it('closes an unknown result without retry when the quiet-window readback still shows the original title', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.adapter.getProductTitle.mockResolvedValue(platformTitle('夏季纯棉短袖上衣', 'online'));
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'failed',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'failed' }],
    });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'edit_title',
        status: 'failed',
        confirmedAt: NOW,
        finishedAt: NOW,
        items: [
          taskItem({
            status: 'failed',
            errorCode: 'TITLE_NOT_APPLIED_VERIFIED',
            errorMessage: '本次写入未确认生效',
            beforeSnapshot: item.beforeSnapshot,
            desiredSnapshot: item.desiredSnapshot,
          }),
        ],
      }),
    );

    await expect(fixture.service.verifyTitleResult(USER, '41', '51')).resolves.toMatchObject({
      items: [
        expect.objectContaining({ errorCode: 'TITLE_NOT_APPLIED_VERIFIED', retryable: false }),
      ],
    });
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

  it('turns a stale title write into a non-retryable unknown result even after cancellation', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchItem.findMany.mockResolvedValue([
      {
        id: 51n,
        taskId: 41n,
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        lockedBy: 'dead-worker',
        errorCode: 'TITLE_WRITE_STARTED',
        task: { action: 'edit_title', cancelRequestedAt: NOW },
      },
    ]);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(null);
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'cancelling',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: NOW,
      items: [{ status: 'failed' }],
    });

    await expect(fixture.service.claimNext('worker-2')).resolves.toBeNull();

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'TITLE_RESULT_UNKNOWN',
        }),
      }),
    );
  });

  it('settles a cancelled running item instead of leaving it in an unreachable retry wait', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    fixture.prisma.productBatchItem.updateMany.mockImplementation(async ({ where }: any) => ({
      count: where?.task?.cancelRequestedAt ? 1 : 0,
    }));
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'cancelling',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: NOW,
      items: [{ status: 'cancelled' }],
    });

    await expect(fixture.service.failClaimedItem(item, new Error('read failed'))).resolves.toBe(
      'cancelled',
    );
  });

  it('preserves an explicit unknown title result when cancellation arrives concurrently', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle.mockResolvedValue(platformTitle('夏季纯棉短袖上衣', 'online'));
    const unknown = new Error('Douyin product title update request failed');
    unknown.name = 'PlatformMutationResultUnknownError';
    fixture.adapter.updateProductTitle.mockRejectedValueOnce(unknown);

    let error: unknown;
    try {
      await fixture.service.executeClaimed(item);
    } catch (caught) {
      error = caught;
    }
    (item.task as { cancelRequestedAt: Date | null }).cancelRequestedAt = NOW;
    fixture.prisma.productBatchItem.updateMany.mockClear();
    fixture.prisma.productBatchItem.updateMany.mockImplementation(async ({ where }: any) => ({
      count: where?.errorCode ? 1 : 0,
    }));
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'cancelling',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: NOW,
      items: [{ status: 'failed' }],
    });

    await expect(fixture.service.failClaimedItem(item, error)).resolves.toBe('failed');
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'TITLE_RESULT_UNKNOWN',
        }),
      }),
    );
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

  it('updates only the title and atomically commits the confirmed draft readback', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle
      .mockResolvedValueOnce(platformTitle('夏季纯棉短袖上衣', 'online'))
      .mockResolvedValueOnce(platformTitle('夏季轻薄纯棉短袖上衣', 'reviewing'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.updateProductTitle).toHaveBeenCalledWith('shop-token', {
      platformProductId: '998877',
      title: '夏季轻薄纯棉短袖上衣',
    });
    expect(fixture.adapter.updateProductPrice).not.toHaveBeenCalled();
    expect(fixture.adapter.syncInventory).not.toHaveBeenCalled();
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1 }),
        data: expect.objectContaining({
          title: '夏季轻薄纯棉短袖上衣',
          status: 'draft',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'title_confirmed',
            actualTitle: '夏季轻薄纯棉短袖上衣',
          }),
        }),
      }),
    );
  });

  it('recovers a timed-out title mutation from the draft-aware platform readback', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle
      .mockResolvedValueOnce(platformTitle('夏季纯棉短袖上衣', 'online'))
      .mockResolvedValueOnce(platformTitle('夏季轻薄纯棉短袖上衣', 'reviewing'));
    const unknown = new Error('Douyin product title update request failed');
    unknown.name = 'PlatformMutationResultUnknownError';
    fixture.adapter.updateProductTitle.mockRejectedValueOnce(unknown);

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            reason: 'platform_title_recovered',
            recovered: true,
          }),
        }),
      }),
    );
  });

  it('preserves result-unknown semantics when the product lock is lost after title submission', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle.mockResolvedValueOnce(
      platformTitle('夏季纯棉短袖上衣', 'online'),
    );
    fixture.productLocks.renew
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('product lock lost'));
    let writeStarted = false;
    fixture.prisma.productBatchItem.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (data?.errorCode === 'TITLE_WRITE_STARTED') {
        writeStarted = true;
        return { count: 1 };
      }
      if (where?.errorCode) return { count: writeStarted ? 1 : 0 };
      if (where?.task?.cancelRequestedAt) return { count: 0 };
      return { count: 1 };
    });

    let thrown: unknown;
    try {
      await fixture.service.executeClaimed(item);
    } catch (error) {
      thrown = error;
    }
    await expect(fixture.service.failClaimedItem(item, thrown)).resolves.toBe('failed');
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'TITLE_RESULT_UNKNOWN', status: 'failed' }),
      }),
    );
  });

  it('does not submit a title when the product lock expires after persisting the write marker', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle.mockResolvedValueOnce(
      platformTitle('夏季纯棉短袖上衣', 'online'),
    );
    fixture.productLocks.renew
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('product lock lost'));
    let writeStarted = false;
    fixture.prisma.productBatchItem.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (data?.errorCode === 'TITLE_WRITE_STARTED') {
        writeStarted = true;
        return { count: 1 };
      }
      if (where?.task?.cancelRequestedAt) return { count: 0 };
      return { count: 1 };
    });

    let thrown: unknown;
    try {
      await fixture.service.executeClaimed(item);
    } catch (error) {
      thrown = error;
    }

    expect(writeStarted).toBe(true);
    expect(fixture.adapter.updateProductTitle).not.toHaveBeenCalled();
    await expect(fixture.service.failClaimedItem(item, thrown)).resolves.toBe('retry_wait');
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'retry_wait',
          errorCode: 'TITLE_WRITE_GUARD_LOST',
        }),
      }),
    );
  });

  it('does not repeat a title mutation when the platform already has the desired title', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord({ attempts: 2 });
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle.mockResolvedValueOnce(
      platformTitle('夏季轻薄纯棉短袖上衣', 'reviewing'),
    );

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.updateProductTitle).not.toHaveBeenCalled();
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({ recovered: true }),
        }),
      }),
    );
  });

  it('blocks a second title task when another write needs verification after taking the product lock', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord({ id: 52n, taskId: 42n });
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue({ id: 51n });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '同一商品存在结果待核验的标题更新',
    );

    expect(fixture.productLocks.acquire).toHaveBeenCalledWith(item.publishedProductId);
    expect(fixture.adapter.getProductTitle).not.toHaveBeenCalled();
    expect(fixture.adapter.updateProductTitle).not.toHaveBeenCalled();
    expect(fixture.productLocks.release).toHaveBeenCalledWith(
      item.publishedProductId,
      'product-lock',
    );
  });

  it('atomically records a confirmed title that leaves the platform product rejected', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle
      .mockResolvedValueOnce(platformTitle('夏季纯棉短袖上衣', 'online'))
      .mockResolvedValueOnce({
        title: '夏季轻薄纯棉短袖上衣',
        state: 'rejected',
        status: 1,
        checkStatus: 4,
      });

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: '夏季轻薄纯棉短袖上衣',
          status: 'rejected',
          lastEditError: '平台商品状态为 rejected，已同步实际标题，请按平台提示修正',
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', errorCode: 'TITLE_RESULT_REJECTED' }),
      }),
    );
  });

  it('fails closed and synchronizes a third-party platform title drift', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle.mockResolvedValueOnce(
      platformTitle('人工修改后的第三个标题', 'online'),
    );

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.updateProductTitle).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: '人工修改后的第三个标题',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'PLATFORM_TITLE_CHANGED',
          result: expect.objectContaining({ actualTitle: '人工修改后的第三个标题' }),
        }),
      }),
    );
  });

  it('marks an unconfirmed ambiguous title mutation non-retryable', async () => {
    const fixture = createFixture();
    const item = titleExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductTitle.mockResolvedValue(platformTitle('夏季纯棉短袖上衣', 'online'));
    const unknown = new Error('Douyin product title update request failed');
    unknown.name = 'PlatformMutationResultUnknownError';
    fixture.adapter.updateProductTitle.mockRejectedValueOnce(unknown);

    let thrown: unknown;
    try {
      await fixture.service.executeClaimed(item);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    await expect(fixture.service.failClaimedItem(item, thrown)).resolves.toBe('failed');
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'TITLE_RESULT_UNKNOWN',
        }),
      }),
    );
  });

  it('updates every changed SKU and commits only after price readback matches', async () => {
    const fixture = createFixture();
    const item = priceExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductPrices
      .mockResolvedValueOnce(
        platformPrices([
          ['sku-a', 2990],
          ['sku-b', 3990],
        ]),
      )
      .mockResolvedValueOnce(
        platformPrices([
          ['sku-a', 3289],
          ['sku-b', 4389],
        ]),
      );

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.updateProductPrice).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.updateProductPrice).toHaveBeenNthCalledWith(1, 'shop-token', {
      platformProductId: '998877',
      sourceSkuId: 'sku-a',
      priceCents: 3289,
    });
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1, status: 'online' }),
        data: expect.objectContaining({
          salePrice: 32.89,
          skuPriceSnapshot: priceSnapshot([
            ['sku-a', 3289],
            ['sku-b', 4389],
          ]),
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.productLocks.release.mock.invocationCallOrder[0]).toBeGreaterThan(
      fixture.prisma.publishedProduct.updateMany.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('continues a partially applied multi-SKU price change without repeating completed SKUs', async () => {
    const fixture = createFixture();
    const item = priceExecutionRecord({ attempts: 2 });
    fixture.prepareExecution(item);
    fixture.adapter.getProductPrices
      .mockResolvedValueOnce(
        platformPrices([
          ['sku-a', 3289],
          ['sku-b', 3990],
        ]),
      )
      .mockResolvedValueOnce(
        platformPrices([
          ['sku-a', 3289],
          ['sku-b', 4389],
        ]),
      );

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.updateProductPrice).toHaveBeenCalledOnce();
    expect(fixture.adapter.updateProductPrice).toHaveBeenCalledWith('shop-token', {
      platformProductId: '998877',
      sourceSkuId: 'sku-b',
      priceCents: 4389,
    });
  });

  it('recovers a timed-out price request when platform readback already matches', async () => {
    const fixture = createFixture();
    const item = priceExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductPrices
      .mockResolvedValueOnce(
        platformPrices([
          ['sku-a', 2990],
          ['sku-b', 3990],
        ]),
      )
      .mockResolvedValueOnce(
        platformPrices([
          ['sku-a', 3289],
          ['sku-b', 4389],
        ]),
      );
    fixture.adapter.updateProductPrice.mockRejectedValueOnce(new Error('request timed out'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'platform_price_recovered',
            recovered: true,
          }),
        }),
      }),
    );
  });

  it('fails closed and synchronizes an unexpected platform price drift', async () => {
    const fixture = createFixture();
    const item = priceExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductPrices.mockResolvedValueOnce(
      platformPrices([
        ['sku-a', 3190],
        ['sku-b', 3990],
      ]),
    );

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '平台 SKU 价格已在预览后变化',
    );

    expect(fixture.adapter.updateProductPrice).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          salePrice: 31.9,
          skuPriceSnapshot: priceSnapshot([
            ['sku-a', 3190],
            ['sku-b', 3990],
          ]),
          lastEditError: '平台 SKU 价格已在批量预览后变化',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
  });

  it('does not call a real price mutation when the adapter cannot read prices back', async () => {
    const fixture = createFixture();
    const item = priceExecutionRecord();
    const updateProductPrice = vi.fn();
    fixture.prepareExecution(item);
    fixture.adapters.create.mockReturnValue({ updateProductPrice });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '当前平台无法回读 SKU 价格，拒绝执行改价',
    );

    expect(updateProductPrice).not.toHaveBeenCalled();
  });

  it('syncs absolute SKU inventory and commits only after platform readback matches', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 5],
          ['sku-b', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 13],
        ]),
      );

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.syncInventory).toHaveBeenCalledWith('shop-token', {
      platformProductId: '998877',
      idempotencyKey: expect.stringMatching(
        new RegExp(`^batch-inventory-51-v4-${'b'.repeat(24)}-[a-f0-9]{16}$`),
      ),
      items: [
        { sourceSkuId: 'sku-a', stock: 7 },
        { sourceSkuId: 'sku-b', stock: 13 },
      ],
    });
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1, status: 'online' }),
        data: expect.objectContaining({
          skuInventorySnapshot: inventorySnapshot([
            ['sku-a', 7],
            ['sku-b', 13],
          ]),
          inventorySyncStatus: 'synced',
          inventoryVersion: 4,
          inventorySyncReason: 'manual_batch_sync',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.productLocks.release.mock.invocationCallOrder[0]).toBeGreaterThan(
      fixture.prisma.publishedProduct.updateMany.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('uses a new token for only the remaining SKUs after an explicit partial failure', async () => {
    const fixture = createFixture();
    const firstAttempt = inventoryExecutionRecord();
    const retryAttempt = inventoryExecutionRecord({ attempts: 2 });
    fixture.prepareExecution(firstAttempt);
    fixture.adapter.getProductInventory
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 5],
          ['sku-b', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 13],
        ]),
      );
    fixture.adapter.syncInventory
      .mockRejectedValueOnce(new Error('Douyin inventory sync failed for item 2'))
      .mockResolvedValueOnce(undefined);

    await expect(fixture.service.executeClaimed(firstAttempt)).rejects.toThrow(
      'Douyin inventory sync failed for item 2',
    );
    fixture.prepareExecution(retryAttempt);
    await expect(fixture.service.executeClaimed(retryAttempt)).resolves.toBe('processed');

    expect(fixture.adapter.syncInventory).toHaveBeenCalledTimes(2);
    const firstRequest = fixture.adapter.syncInventory.mock.calls[0]![1];
    const retryRequest = fixture.adapter.syncInventory.mock.calls[1]![1];
    expect(firstRequest.items).toEqual([
      { sourceSkuId: 'sku-a', stock: 7 },
      { sourceSkuId: 'sku-b', stock: 13 },
    ]);
    expect(retryRequest.items).toEqual([{ sourceSkuId: 'sku-b', stock: 13 }]);
    expect(retryRequest.idempotencyKey).not.toBe(firstRequest.idempotencyKey);
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
  });

  it('keeps a product offline when an unknown v4 write lands after a confirmed v5 write', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    let platformState = 'online' as 'online' | 'offline';
    let platformStocks = [
      ['sku-a', 5],
      ['sku-b', 8],
    ] as Array<[string, number]>;
    let applyLateV4 = () => undefined;
    fixture.adapter.getProductInventory.mockImplementation(async () =>
      platformInventory(platformStocks),
    );
    fixture.adapter.syncInventory.mockImplementationOnce(async (_token, request) => {
      applyLateV4 = () => {
        platformStocks = request.items.map((entry) => [entry.sourceSkuId, entry.stock]);
      };
      const error = new Error('Douyin inventory sync request failed');
      error.name = 'PlatformMutationResultUnknownError';
      throw error;
    });
    fixture.adapter.offlineProduct.mockImplementation(async () => {
      platformState = 'offline';
    });
    fixture.adapter.getProductState.mockImplementation(async () => ({
      state: platformState,
      status: platformState === 'offline' ? 1 : 0,
      checkStatus: 3,
    }));

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow('商品已安全下架');

    platformStocks = [
      ['sku-a', 2],
      ['sku-b', 3],
    ];
    applyLateV4();
    expect(platformStocks).toEqual([
      ['sku-a', 7],
      ['sku-b', 13],
    ]);
    expect(platformState).toBe('offline');
    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'offline',
          inventorySyncStatus: 'pending',
          inventorySyncReason: 'manual_batch_quarantine',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    const quarantineData = fixture.prisma.publishedProduct.updateMany.mock.calls[0]![0].data;
    expect(quarantineData).not.toHaveProperty('inventoryTargetFingerprint');
    expect(quarantineData).not.toHaveProperty('inventoryTargetVersion');
  });

  it('reconciles local offline state after quarantine when the expected revision changed', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 5],
        ['sku-b', 8],
      ]),
    );
    const unknownResult = new Error('Douyin inventory sync request failed');
    unknownResult.name = 'PlatformMutationResultUnknownError';
    fixture.adapter.syncInventory.mockRejectedValueOnce(unknownResult);
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });
    fixture.prisma.publishedProduct.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow('商品已安全下架');

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: 11n,
          platformProductId: '998877',
          status: 'online',
        },
        data: expect.objectContaining({
          status: 'offline',
          inventorySyncStatus: 'pending',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
  });

  it('persists a confirmed offline quarantine with the expected revision after the lock is lost', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 5],
        ['sku-b', 8],
      ]),
    );
    const unknownResult = new Error('Douyin inventory sync request failed');
    unknownResult.name = 'PlatformMutationResultUnknownError';
    fixture.adapter.syncInventory.mockRejectedValueOnce(unknownResult);
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });
    fixture.productLocks.renew
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('product lock lease lost'));

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow('商品已安全下架');

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.adapter.getProductState).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledOnce();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1, status: 'online' }),
        data: expect.objectContaining({ status: 'offline', inventorySyncStatus: 'pending' }),
      }),
    );
  });

  it('still quarantines the platform but does not overwrite a newer local revision after the lock is lost', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 5],
        ['sku-b', 8],
      ]),
    );
    const unknownResult = new Error('Douyin inventory sync request failed');
    unknownResult.name = 'PlatformMutationResultUnknownError';
    fixture.adapter.syncInventory.mockRejectedValueOnce(unknownResult);
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });
    fixture.productLocks.renew
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('product lock lease lost'));
    fixture.prisma.publishedProduct.updateMany.mockResolvedValueOnce({ count: 0 });
    fixture.prisma.publishedProduct.findUnique.mockResolvedValueOnce({
      platformProductId: '998877',
      status: 'online',
    });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '商品状态已并发变化，请立即人工核验',
    );

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.adapter.getProductState).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledOnce();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1, status: 'online' }),
      }),
    );
  });

  it('fails closed before writing when platform inventory drifted after preview', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 6],
        ['sku-b', 8],
      ]),
    );

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '平台 SKU 库存已在预览后变化',
    );

    expect(fixture.adapter.syncInventory).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          skuInventorySnapshot: inventorySnapshot([
            ['sku-a', 6],
            ['sku-b', 8],
          ]),
          inventorySyncStatus: 'dead',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
  });

  it('stops before platform inventory access when the source version changed after preview', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord({
      publishedProduct: publishedProduct({
        task: { userId: 1n, skuSnapshot: null },
        sourceProduct: {
          productId1688: '16880001',
          availability: 'available',
          mainImage: null,
          totalStock: 21,
          inventoryFingerprint: 'c'.repeat(64),
          inventoryVersion: 5,
          skuList: [
            { skuId: 'sku-a', stock: 8 },
            { skuId: 'sku-b', stock: 13 },
          ],
        },
      }),
    });
    fixture.prepareExecution(item);

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '1688 货源库存已在预览后变化',
    );

    expect(fixture.adapter.getProductInventory).not.toHaveBeenCalled();
    expect(fixture.adapter.syncInventory).not.toHaveBeenCalled();
  });

  it('does not call the platform when the source changes after the initial platform read', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 5],
        ['sku-b', 8],
      ]),
    );
    fixture.prisma.sourceProduct.findUnique.mockResolvedValueOnce({
      inventoryFingerprint: 'c'.repeat(64),
      inventoryVersion: 5,
    });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '1688 货源库存已在执行期间变化',
    );

    expect(fixture.adapter.syncInventory).not.toHaveBeenCalled();
  });

  it('rechecks the source after the platform write and confirms a safety offline on drift', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 5],
        ['sku-b', 8],
      ]),
    );
    fixture.prisma.sourceProduct.findUnique
      .mockResolvedValueOnce({
        inventoryFingerprint: 'b'.repeat(64),
        inventoryVersion: 4,
      })
      .mockResolvedValueOnce({
        inventoryFingerprint: 'c'.repeat(64),
        inventoryVersion: 5,
      });
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '1688 货源库存已在执行期间变化',
    );

    expect(fixture.adapter.syncInventory).toHaveBeenCalledOnce();
    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.adapter.getProductState).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'offline',
          inventorySyncStatus: 'pending',
        }),
      }),
    );
  });

  it('does not clear a newer inventory target when the source changes during platform I/O', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductInventory
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 5],
          ['sku-b', 8],
        ]),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 13],
        ]),
      );
    fixture.prisma.publishedProduct.updateMany.mockResolvedValueOnce({ count: 0 });
    fixture.prisma.publishedProduct.updateMany.mockResolvedValueOnce({ count: 1 });
    fixture.prisma.publishedProduct.findUnique.mockResolvedValueOnce({
      skuInventorySnapshot: inventorySnapshot([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
      inventoryFingerprint: 'b'.repeat(64),
      inventoryVersion: 4,
      sourceProduct: {
        inventoryFingerprint: 'c'.repeat(64),
        inventoryVersion: 5,
      },
    });
    fixture.adapter.getProductState.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '1688 货源库存已在同步期间变化',
    );

    expect(fixture.prisma.productBatchItem.updateMany).not.toHaveBeenCalled();
    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    const quarantineData = fixture.prisma.publishedProduct.updateMany.mock.calls[1]![0].data;
    expect(quarantineData).toMatchObject({ status: 'offline', inventorySyncStatus: 'pending' });
    expect(quarantineData).not.toHaveProperty('inventoryTargetFingerprint');
    expect(quarantineData).not.toHaveProperty('inventoryTargetVersion');
  });

  it('does not mutate inventory when the real adapter cannot read it back', async () => {
    const fixture = createFixture();
    const item = inventoryExecutionRecord();
    const syncInventory = vi.fn();
    fixture.prepareExecution(item);
    fixture.adapters.create.mockReturnValue({ syncInventory });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '当前平台无法回读 SKU 库存，拒绝执行库存同步',
    );

    expect(syncInventory).not.toHaveBeenCalled();
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
    updateProductTitle: vi.fn(),
    getProductTitle: vi.fn(),
    updateProductPrice: vi.fn(),
    getProductPrices: vi.fn(),
    syncInventory: vi.fn(),
    getProductInventory: vi.fn(),
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
      updateMany: vi.fn().mockImplementation(async ({ where }: any) => ({
        count: where?.errorCode || where?.task?.cancelRequestedAt ? 0 : 1,
      })),
    },
    publishedProduct: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sourceProduct: {
      findUnique: vi.fn().mockResolvedValue({
        inventoryFingerprint: 'b'.repeat(64),
        inventoryVersion: 4,
      }),
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
      prisma.publishedProduct.findUnique.mockResolvedValue({
        platformProductId: item.publishedProduct.platformProductId,
        mutationRevision: item.expectedMutationRevision,
      });
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

function priceExecutionRecord(overrides: Record<string, unknown> = {}) {
  const record = executionRecord();
  return {
    ...record,
    beforeSnapshot: {
      status: 'online',
      platformProductId: '998877',
      shopId: '21',
      skuPrices: priceSnapshot([
        ['sku-a', 2990],
        ['sku-b', 3990],
      ]),
    },
    desiredSnapshot: {
      status: 'online',
      skuPrices: priceSnapshot([
        ['sku-a', 3289],
        ['sku-b', 4389],
      ]),
    },
    task: { ...record.task, action: 'edit_price' },
    publishedProduct: publishedProduct({
      task: { userId: 1n, skuSnapshot: null },
      skuPriceSnapshot: priceSnapshot([
        ['sku-a', 2990],
        ['sku-b', 3990],
      ]),
    }),
    ...overrides,
  } as unknown as ProductBatchExecutionRecord;
}

function titleExecutionRecord(overrides: Record<string, unknown> = {}) {
  const record = executionRecord();
  return {
    ...record,
    beforeSnapshot: {
      status: 'online',
      title: '夏季纯棉短袖上衣',
      platformProductId: '998877',
      shopId: '21',
      mutationRevision: 1,
    },
    desiredSnapshot: {
      status: 'online',
      title: '夏季轻薄纯棉短袖上衣',
    },
    task: { ...record.task, action: 'edit_title' },
    publishedProduct: publishedProduct({
      title: '夏季纯棉短袖上衣',
      task: { userId: 1n, skuSnapshot: null },
    }),
    ...overrides,
  } as unknown as ProductBatchExecutionRecord;
}

function unknownTitleExecutionRecord(titleWriteStartedAt: string) {
  const record = titleExecutionRecord();
  return {
    ...record,
    status: 'failed',
    errorCode: 'TITLE_RESULT_UNKNOWN',
    errorMessage: '标题写入结果未知',
    result: { phase: 'platform_write_started', titleWriteStartedAt },
    lockedAt: null,
    lockedBy: null,
    finishedAt: NOW,
    task: { ...record.task, status: 'failed' },
  } as unknown as ProductBatchExecutionRecord;
}

function inventoryExecutionRecord(overrides: Record<string, unknown> = {}) {
  const record = executionRecord();
  return {
    ...record,
    beforeSnapshot: {
      status: 'online',
      platformProductId: '998877',
      shopId: '21',
      inventoryFingerprint: 'a'.repeat(64),
      inventoryVersion: 3,
      skuInventory: inventorySnapshot([
        ['sku-a', 5],
        ['sku-b', 8],
      ]),
    },
    desiredSnapshot: {
      status: 'online',
      inventoryFingerprint: 'b'.repeat(64),
      inventoryVersion: 4,
      skuInventory: inventorySnapshot([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    },
    task: { ...record.task, action: 'sync_inventory' },
    publishedProduct: publishedProduct({
      task: {
        userId: 1n,
        skuSnapshot: {
          douyin: {
            skus: [
              { sourceSkuId: 'sku-a', stock: 5 },
              { sourceSkuId: 'sku-b', stock: 8 },
            ],
          },
        },
      },
    }),
    ...overrides,
  } as unknown as ProductBatchExecutionRecord;
}

function priceSnapshot(items: Array<[string, number]>) {
  return {
    version: 1,
    items: items.map(([sourceSkuId, priceCents]) => ({ sourceSkuId, priceCents })),
  };
}

function inventorySnapshot(items: Array<[string, number]>) {
  return {
    version: 1,
    items: items.map(([sourceSkuId, stock]) => ({ sourceSkuId, stock })),
  };
}

function platformPrices(items: Array<[string, number]>) {
  return {
    state: 'online' as const,
    status: 0,
    checkStatus: 3,
    items: priceSnapshot(items).items,
  };
}

function platformInventory(items: Array<[string, number]>) {
  return {
    state: 'online' as const,
    status: 0,
    checkStatus: 3,
    items: inventorySnapshot(items).items,
  };
}

function platformTitle(
  title: string,
  state: 'online' | 'offline' | 'reviewing' | 'draft' = 'online',
) {
  return {
    title,
    state,
    status: state === 'online' ? 0 : 1,
    checkStatus: state === 'reviewing' ? 2 : state === 'draft' ? 1 : 3,
  };
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
    skuInventorySnapshot: inventorySnapshot([
      ['sku-a', 5],
      ['sku-b', 8],
    ]),
    inventoryFingerprint: 'a'.repeat(64),
    inventoryTargetFingerprint: 'a'.repeat(64),
    inventoryVersion: 3,
    inventoryTargetVersion: 3,
    inventoryLastSyncedAt: NOW,
    inventorySyncError: null,
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
      id: 31n,
      productId1688: '16880001',
      availability: 'available',
      mainImage: null,
      totalStock: 20,
      inventoryFingerprint: 'b'.repeat(64),
      inventoryVersion: 4,
      skuList: [
        { skuId: 'sku-a', stock: 7 },
        { skuId: 'sku-b', stock: 13 },
      ],
    },
    ...overrides,
  };
}

function fingerprint(
  action: string,
  ids: string[],
  priceRule?: Record<string, unknown>,
  titleTargets?: Array<{
    publishedProductId: string;
    expectedMutationRevision: number;
    targetTitle: string;
  }>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action,
        publishedProductIds: [...ids].sort(),
        ...(titleTargets
          ? {
              titleTargets: [...titleTargets].sort((left, right) =>
                left.publishedProductId.localeCompare(right.publishedProductId),
              ),
            }
          : {}),
        ...(priceRule ? { priceRule } : {}),
      }),
    )
    .digest('hex');
}
