import type { ConfigService } from '@nestjs/config';
import { Prisma } from '@supplier/db';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import { buildSkuSuggestion } from '../sku/sku-normalizer';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import type { PlatformProductLockService } from './platform-product-lock.service';
import { ProductBatchService, type ProductBatchExecutionRecord } from './product-batch.service';
import { sourceBindingFingerprint, sourceBindingRoutesFingerprint } from './source-binding';

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

  it('exposes source-change eligibility only for a safely offline product with one current binding', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(2);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({ status: 'offline', shop: cleanupShop(), task: { skuSnapshot: null } }),
      publishedProduct({
        id: 12n,
        status: 'offline',
        shop: cleanupShop(),
        task: { skuSnapshot: null },
        sourceBindings: [],
      }),
    ]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'offline' }),
    ).resolves.toMatchObject({
      items: [
        {
          publishedProductId: '11',
          sourceChangeEligible: true,
          sourceChangeReason: null,
          currentSourceRouteCount: 2,
        },
        {
          publishedProductId: '12',
          sourceChangeEligible: false,
          sourceChangeReason: '商品当前货源绑定缺失或重复，不能安全换源',
          currentSourceRouteCount: 0,
        },
      ],
    });
  });

  it('builds an offline source-change preview with stable platform SKU routes', async () => {
    const fixture = createFixture();
    const product = publishedProduct({ status: 'offline', shop: cleanupShop() });
    const target = targetSourceProduct();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([product]);
    fixture.prisma.sourceProduct.findMany.mockResolvedValue([target]);
    fixture.prisma.productBatchTask.create.mockImplementation(async ({ data }: any) =>
      taskRecord({
        action: 'change_source',
        requestFingerprint: data.requestFingerprint,
        items: data.items.create.map((item: any) =>
          taskItem({ ...item, publishedProduct: product }),
        ),
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'change_source',
        publishedProductIds: ['11'],
        sourceTargets: [
          {
            publishedProductId: '11',
            expectedMutationRevision: 1,
            targetSourceProductId: '16880002',
          },
        ],
      }),
    ).resolves.toMatchObject({
      action: 'change_source',
      items: [
        {
          status: 'pending',
          beforeStatus: 'offline',
          desiredStatus: 'offline',
          beforeSourceProductId: '16880001',
          desiredSourceProductId: '16880002',
          beforeSourceTitle: '旧 1688 货源',
          desiredSourceTitle: '新 1688 货源',
          sourceRouteCount: 2,
          sourceCostRange: [11, 13],
        },
      ],
    });

    const desired =
      fixture.prisma.productBatchTask.create.mock.calls[0]![0].data.items.create[0].desiredSnapshot;
    expect(desired.sourceRoutes).toEqual([
      expect.objectContaining({ platformSkuKey: 'sku-a', sourceSpecId: 'new-white' }),
      expect.objectContaining({ platformSkuKey: 'sku-b', sourceSpecId: 'new-black' }),
    ]);
  });

  it('rejects source change when target SKU values cannot map one-to-one', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({ status: 'offline', shop: cleanupShop() }),
    ]);
    fixture.prisma.sourceProduct.findMany.mockResolvedValue([
      targetSourceProduct({
        skuList: [
          {
            skuId: 'new-red',
            specName: '颜色：红色',
            price: 11,
            stock: 8,
            attributes: { 颜色: '红色' },
          },
          {
            skuId: 'new-black',
            specName: '颜色：黑色',
            price: 13,
            stock: 12,
            attributes: { 颜色: '黑色' },
          },
        ],
      }),
    ]);

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'change_source',
        publishedProductIds: ['11'],
        sourceTargets: [
          {
            publishedProductId: '11',
            expectedMutationRevision: 1,
            targetSourceProductId: '16880002',
          },
        ],
      }),
    ).rejects.toThrow('目标货源 SKU 规格与平台商品不能一一对应');

    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
  });

  it('rejects a source-change preview when the target has no supplier identifier', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({ status: 'offline', shop: cleanupShop() }),
    ]);
    fixture.prisma.sourceProduct.findMany.mockResolvedValue([
      targetSourceProduct({ supplierId: null }),
    ]);

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'change_source',
        publishedProductIds: ['11'],
        sourceTargets: [
          {
            publishedProductId: '11',
            expectedMutationRevision: 1,
            targetSourceProductId: '16880002',
          },
        ],
      }),
    ).rejects.toThrow('目标 1688 货源缺少供应商标识，不能安全采购');

    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
  });

  it('fails closed every candidate action when the raw platform status says deleted', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'offline',
        platformStatusRaw: 2,
        platformCheckStatusRaw: null,
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
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50 }),
    ).resolves.toMatchObject({
      items: [
        {
          status: 'rejected',
          priceEditable: false,
          priceEditReason: '平台商品已删除，不能继续操作，请重新铺货',
          titleEditable: false,
          titleEditReason: '平台商品已删除，不能改标题，请重新铺货',
          inventorySyncEligible: false,
          inventorySyncReason: '平台商品已删除，不能同步库存，请重新铺货',
          onlineEligible: false,
          onlineReason: '平台商品已删除，不能重新上架，请重新铺货',
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

  it('exposes safe online eligibility and the original verification fence', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(2);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'offline',
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
      publishedProduct({
        id: 12n,
        status: 'offline',
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
    fixture.prisma.productBatchItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 52n, taskId: 42n, publishedProductId: 12n }]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'offline' }),
    ).resolves.toMatchObject({
      items: [
        { publishedProductId: '11', onlineEligible: true, onlineReason: null },
        {
          publishedProductId: '12',
          onlineEligible: false,
          onlineReason: '存在结果待核验的上架操作，请先在原批量任务核验',
          onlineVerificationTaskId: '42',
          onlineVerificationItemId: '52',
        },
      ],
    });
  });

  it('keeps stable platform SKU keys when preparing inventory after a source change', async () => {
    const fixture = createFixture();
    const target = targetSourceProduct();
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'offline',
        sourceProductId: 32n,
        sourceProduct: target,
        sourceBindings: [
          currentSourceBinding({
            id: 72n,
            sourceProductId: 32n,
            revision: 2,
            sourceOfferId: '16880002',
            skuRoutes: [
              {
                platformSkuKey: 'sku-a',
                sourceSpecId: 'new-white',
                sourceSpecRequired: true,
                sourceUnitCost: 11,
                values: ['白色'],
              },
              {
                platformSkuKey: 'sku-b',
                sourceSpecId: 'new-black',
                sourceSpecRequired: true,
                sourceUnitCost: 13,
                values: ['黑色'],
              },
            ],
            bindingFingerprint: 'd'.repeat(64),
          }),
        ],
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

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'offline' }),
    ).resolves.toMatchObject({
      items: [
        {
          onlineEligible: true,
          onlineReason: null,
          sourceTotalStock: 20,
          sourceSkuCount: 2,
          sourceInventoryVersion: 8,
        },
      ],
    });
  });

  it('exposes cleanup eligibility from one bounded OrderItem aggregate', async () => {
    const fixture = createFixture();
    const record = cleanupReadyProduct();
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([record]);
    fixture.prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'online' }),
    ).resolves.toMatchObject({
      items: [
        {
          cleanupEligible: true,
          cleanupReason: null,
          cleanupEvidence: {
            policyVersion: 1,
            windowDays: 30,
            graceDays: 7,
            daysOnline: 8,
            validOrderCount: 0,
            lastPaidAt: null,
            orderSyncAt: expect.any(String),
          },
        },
      ],
    });

    expect(fixture.prisma.$queryRaw).toHaveBeenCalledOnce();
    const query = fixture.prisma.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    expect(query.strings?.join(' ')).toContain('order_items');
  });

  it('treats a valid sale on a secondary OrderItem as cleanup activity', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([cleanupReadyProduct()]);
    fixture.prisma.$queryRaw.mockResolvedValue([
      { publishedProductId: 11n, validOrderCount: 1n, lastPaidAt: null },
    ]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'online' }),
    ).resolves.toMatchObject({
      items: [
        {
          cleanupEligible: false,
          cleanupReason: '最近 30 天已有有效订单，不能作为滞销商品清理',
          cleanupEvidence: { validOrderCount: 1, lastPaidAt: null },
        },
      ],
    });
    const query = fixture.prisma.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    expect(query.strings?.join(' ')).toContain('paid_at" IS NULL');
  });

  it.each([
    ['background sync disabled', { DOUYIN_ORDER_SYNC_ENABLED: 'false' }, {}, '订单同步未启用'],
    ['lookback too short', { DOUYIN_ORDER_SYNC_LOOKBACK_DAYS: '29' }, {}, '订单同步回溯不足 30 天'],
    [
      'history backfill is unverified',
      { DOUYIN_ORDER_SYNC_HISTORY_VERIFIED_AT: '' },
      {},
      '历史订单回补尚未确认',
    ],
    ['sync failed', {}, { orderSyncError: 'platform unavailable' }, '店铺订单同步存在错误'],
    [
      'sync is running',
      {},
      { orderSyncAttemptAt: new Date(Date.now() + 1_000) },
      '店铺订单正在同步',
    ],
    [
      'watermark is stale',
      {},
      {
        lastOrderSyncAt: new Date(Date.now() - 6 * 60_000),
        orderSyncAttemptAt: new Date(Date.now() - 6 * 60_000),
      },
      '店铺订单同步水位已过期',
    ],
  ])('fails cleanup eligibility closed when %s', async (_label, config, shop, reason) => {
    const fixture = createFixture(config);
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      cleanupReadyProduct({ shop: cleanupShop(shop) }),
    ]);
    fixture.prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'online' }),
    ).resolves.toMatchObject({
      items: [{ cleanupEligible: false, cleanupReason: expect.stringContaining(reason) }],
    });
  });

  it('skips an online preview when a stale local offline row has a deleted raw status', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'offline',
        platformStatusRaw: 2,
        platformCheckStatusRaw: 3,
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
        action: 'online',
        requestFingerprint: data.requestFingerprint,
        items: data.items.create.map((item: any) => taskItem(item)),
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'online',
        publishedProductIds: ['11'],
      }),
    ).resolves.toMatchObject({
      items: [
        {
          status: 'skipped',
          errorCode: 'ONLINE_UNAVAILABLE',
          errorMessage: '平台商品已删除，不能重新上架，请重新铺货',
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

  it('binds source-change replay identity to the exact target offer and product revision', async () => {
    const fixture = createFixture();
    const sourceTargets = [
      {
        publishedProductId: '11',
        expectedMutationRevision: 3,
        targetSourceProductId: '16880002',
      },
    ];
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(
      taskRecord({
        action: 'change_source',
        requestFingerprint: fingerprint(
          'change_source',
          ['11'],
          undefined,
          undefined,
          sourceTargets,
        ),
        items: [],
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'change_source',
        publishedProductIds: ['11'],
        sourceTargets,
      }),
    ).resolves.toMatchObject({ action: 'change_source' });
    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'change_source',
        publishedProductIds: ['11'],
        sourceTargets: [{ ...sourceTargets[0]!, targetSourceProductId: '16880003' }],
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

  it('freezes source inventory and the local offline baseline into an online preview', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'offline',
        inventorySyncStatus: 'pending',
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
      taskRecord({ action: 'online', requestFingerprint: data.requestFingerprint, items: [] }),
    );

    await fixture.service.createPreview(USER, {
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'online',
      publishedProductIds: ['11'],
    });

    expect(fixture.prisma.productBatchTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'online',
          items: {
            create: [
              expect.objectContaining({
                status: 'pending',
                expectedMutationRevision: 1,
                beforeSnapshot: expect.objectContaining({
                  status: 'offline',
                  inventoryFingerprint: 'a'.repeat(64),
                  inventoryVersion: 3,
                  skuInventory: inventorySnapshot([
                    ['sku-a', 5],
                    ['sku-b', 8],
                  ]),
                }),
                desiredSnapshot: {
                  status: 'online',
                  inventoryFingerprint: 'b'.repeat(64),
                  inventoryVersion: 4,
                  skuInventory: inventorySnapshot([
                    ['sku-a', 7],
                    ['sku-b', 13],
                  ]),
                },
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

  it('materializes cleanup evidence without calling the platform', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([cleanupReadyProduct()]);
    fixture.prisma.$queryRaw.mockResolvedValue([]);
    fixture.prisma.productBatchTask.create.mockImplementation(async ({ data }: any) =>
      taskRecord({
        action: 'cleanup',
        requestFingerprint: data.requestFingerprint,
        items: data.items.create.map((item: any) => taskItem(item)),
      }),
    );

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'cleanup',
        publishedProductIds: ['11'],
      }),
    ).resolves.toMatchObject({
      action: 'cleanup',
      items: [
        {
          status: 'pending',
          desiredStatus: 'offline',
          cleanupEvidence: {
            policyVersion: 1,
            windowDays: 30,
            graceDays: 7,
            validOrderCount: 0,
          },
        },
      ],
    });

    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
  });

  it('does not let a cleanup preview bypass an unresolved title or online write', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([cleanupReadyProduct()]);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue({ id: 99n });

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'cleanup',
        publishedProductIds: ['11'],
      }),
    ).rejects.toThrow('存在结果待核验的平台写入');

    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
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

  it('rejects a new online preview until every earlier platform mutation is verified', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue(null);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'offline',
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
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue({ id: 51n });

    await expect(
      fixture.service.createPreview(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        action: 'online',
        publishedProductIds: ['11'],
      }),
    ).rejects.toThrow('存在结果待核验的平台写入');

    expect(fixture.prisma.productBatchTask.create).not.toHaveBeenCalled();
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

  it('blocks manual replay when an online mutation result is still unknown', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'online',
        status: 'failed',
        confirmedAt: NOW,
        items: [
          taskItem({ status: 'failed', errorCode: 'ONLINE_RESULT_UNKNOWN', finishedAt: NOW }),
        ],
      }),
    );

    await expect(fixture.service.retry(USER, '41', {})).rejects.toThrow(
      '请先在原批量任务核验平台状态与库存',
    );
    expect(fixture.prisma.productBatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('advances the online retry baseline after a verified not-applied quarantine', async () => {
    const fixture = createFixture();
    const failed = taskItem({
      status: 'failed',
      expectedMutationRevision: 1,
      errorCode: 'ONLINE_RESULT_NOT_APPLIED',
      result: {
        onlineWriteStartedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        quarantineRevision: 2,
      },
      finishedAt: NOW,
      publishedProduct: publishedProduct({ status: 'offline', mutationRevision: 2 }),
    });
    const initial = taskRecord({
      action: 'online',
      status: 'failed',
      confirmedAt: NOW,
      items: [failed],
    });
    const queued = taskRecord({
      action: 'online',
      status: 'queued',
      confirmedAt: NOW,
      items: [taskItem({ status: 'pending', expectedMutationRevision: 2 })],
    });
    fixture.prisma.productBatchTask.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(queued);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });

    await expect(fixture.service.retry(USER, '41', {})).resolves.toMatchObject({
      status: 'queued',
    });

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 51n,
        status: 'failed',
        errorCode: 'ONLINE_RESULT_NOT_APPLIED',
        expectedMutationRevision: 1,
        publishedProduct: { mutationRevision: 2 },
      },
      data: expect.objectContaining({
        status: 'pending',
        expectedMutationRevision: 2,
        result: Prisma.JsonNull,
      }),
    });
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

  it('persists a deleted title-verification state as rejected instead of offline', async () => {
    const fixture = createFixture();
    const item = unknownTitleExecutionRecord(new Date().toISOString());
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.adapter.getProductTitle.mockResolvedValue({
      title: '夏季纯棉短袖上衣',
      state: 'deleted',
      status: 2,
      checkStatus: 3,
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

    await fixture.service.verifyTitleResult(USER, '41', '51');

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'rejected',
          platformStatusRaw: 2,
          platformCheckStatusRaw: 3,
        }),
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

  it('verifies online only after two state reads and exact SKU inventory agree', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'succeeded', items: [] }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );

    await expect(fixture.service.verifyOnlineResult(USER, '41', '51')).resolves.toMatchObject({
      action: 'online',
      status: 'succeeded',
    });

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1 }),
        data: expect.objectContaining({
          status: 'online',
          inventoryFingerprint: 'b'.repeat(64),
          inventoryVersion: 4,
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          errorCode: null,
          result: expect.objectContaining({ reason: 'platform_online_verified' }),
        }),
      }),
    );
  });

  it('keeps a verified product online when the verification transaction ACK is lost', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    const desiredInventory = inventorySnapshot([
      ['sku-a', 7],
      ['sku-b', 13],
    ]);
    const committedProduct = publishedProduct({
      status: 'online',
      mutationRevision: 2,
      skuInventorySnapshot: desiredInventory,
      inventoryFingerprint: 'b'.repeat(64),
      inventoryTargetFingerprint: 'b'.repeat(64),
      inventoryVersion: 4,
      inventoryTargetVersion: 4,
      inventorySyncStatus: 'synced',
    });
    const committedItem = {
      ...item,
      status: 'succeeded',
      errorCode: null,
      result: {
        ...item.result,
        actualStatus: 'online',
        actualInventory: desiredInventory,
      },
    };
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.findUnique.mockResolvedValue(committedItem);
    fixture.prisma.publishedProduct.findUnique
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(committedProduct);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'succeeded', items: [] }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );
    fixture.prisma.$transaction.mockImplementation(async (callback: any) => {
      await callback(fixture.prisma);
      throw new Error('transaction commit acknowledgement lost');
    });

    await expect(fixture.service.verifyOnlineResult(USER, '41', '51')).resolves.toMatchObject({
      status: 'succeeded',
    });

    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
  });

  it('reconciles a terminal task after verified-online refresh temporarily fails', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce(item)
      .mockResolvedValue(null);
    fixture.prisma.productBatchItem.findMany.mockResolvedValue([]);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'failed', confirmedAt: NOW, items: [] }),
    );
    fixture.prisma.productBatchTask.findUnique
      .mockRejectedValueOnce(new Error('task refresh temporarily unavailable'))
      .mockResolvedValueOnce({
        id: 41n,
        status: 'failed',
        stateRevision: 3,
        confirmedAt: NOW,
        cancelRequestedAt: null,
        finishedAt: NOW,
        items: [{ status: 'succeeded' }],
      });
    fixture.prisma.productBatchTask.findMany.mockResolvedValue([{ id: 41n }]);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );

    await fixture.service.verifyOnlineResult(USER, '41', '51');
    await expect(fixture.service.claimNext('worker-reconcile')).resolves.toBeNull();

    expect(fixture.prisma.productBatchTask.updateMany).toHaveBeenCalledWith({
      where: { id: 41n, stateRevision: 3 },
      data: {
        status: 'succeeded',
        stateRevision: { increment: 1 },
        finishedAt: expect.any(Date),
      },
    });
  });

  it('closes a quiet-window online fence only after state and inventory both remain offline', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'failed', items: [] }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    );

    await fixture.service.verifyOnlineResult(USER, '41', '51');

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'ONLINE_RESULT_NOT_APPLIED' }),
      }),
    );
  });

  it('keeps the online fence when the platform is still reviewing', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.adapter.getProductState.mockResolvedValueOnce(platformState('reviewing'));

    await expect(fixture.service.verifyOnlineResult(USER, '41', '51')).rejects.toThrow(
      '平台仍在处理或无法确认上架结果',
    );

    expect(fixture.prisma.productBatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the rejected-result fence when the product CAS loses', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('rejected'))
      .mockResolvedValueOnce(platformState('rejected'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce({
      ...platformState('rejected'),
      items: inventorySnapshot([
        ['sku-a', 7],
        ['sku-b', 13],
      ]).items,
    });
    fixture.prisma.publishedProduct.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(fixture.service.verifyOnlineResult(USER, '41', '51')).rejects.toThrow(
      '核验栅栏保持不变',
    );

    expect(fixture.prisma.productBatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('records a stable rejected online result for manual correction', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'failed', items: [] }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('rejected'))
      .mockResolvedValueOnce(platformState('rejected'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce({
      ...platformState('rejected'),
      items: inventorySnapshot([
        ['sku-a', 7],
        ['sku-b', 13],
      ]).items,
    });

    await fixture.service.verifyOnlineResult(USER, '41', '51');

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'rejected' }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'ONLINE_RESULT_REJECTED' }),
      }),
    );
  });

  it('records a stable deleted platform product as a non-retryable terminal state', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'failed', items: [] }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('deleted'))
      .mockResolvedValueOnce(platformState('deleted'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce({
      ...platformState('deleted'),
      items: inventorySnapshot([
        ['sku-a', 7],
        ['sku-b', 13],
      ]).items,
    });

    await fixture.service.verifyOnlineResult(USER, '41', '51');

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'rejected',
          platformStatusRaw: 2,
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          errorCode: { in: ['ONLINE_WRITE_STARTED', 'ONLINE_RESULT_UNKNOWN'] },
        }),
        data: expect.objectContaining({
          errorCode: 'ONLINE_RESULT_REJECTED',
          errorMessage: '平台商品已删除，无法重新上架，请重新铺货',
          result: expect.objectContaining({ actualStatus: 'deleted' }),
        }),
      }),
    );

    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({
        action: 'online',
        status: 'failed',
        confirmedAt: NOW,
        items: [
          taskItem({
            status: 'failed',
            errorCode: 'ONLINE_RESULT_REJECTED',
            publishedProduct: publishedProduct({ status: 'rejected', mutationRevision: 2 }),
          }),
        ],
      }),
    );
    await expect(fixture.service.retry(USER, '41', {})).rejects.toThrow('需要重新预览或人工处理');

    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'rejected',
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
    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50 }),
    ).resolves.toMatchObject({
      items: [
        {
          onlineEligible: false,
          onlineReason: '只有已下架商品可以重新上架',
        },
      ],
    });
  });

  it.each(['inventory timeout', 'malformed inventory'])(
    'quarantines a known-online verification after %s and preserves its fence',
    async (failure) => {
      const fixture = createFixture();
      const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
      fixture.prepareExecution(item);
      fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
      fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
      if (failure === 'inventory timeout') {
        fixture.adapter.getProductState
          .mockResolvedValueOnce(platformState('online'))
          .mockResolvedValueOnce(platformState('offline'));
        fixture.adapter.getProductInventory.mockRejectedValueOnce(new Error('inventory timeout'));
      } else {
        fixture.adapter.getProductState
          .mockResolvedValueOnce(platformState('online'))
          .mockResolvedValueOnce(platformState('online'))
          .mockResolvedValueOnce(platformState('offline'));
        fixture.adapter.getProductInventory.mockResolvedValueOnce({
          ...platformState('online'),
          items: [],
        });
      }

      await expect(fixture.service.verifyOnlineResult(USER, '41', '51')).rejects.toThrow(
        '核验栅栏保持不变',
      );

      expect(fixture.adapter.offlineProduct).toHaveBeenCalledOnce();
      expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'offline' }),
        }),
      );
      expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            result: expect.objectContaining({ quarantineRevision: 2 }),
          },
        }),
      );
      expect(
        fixture.prisma.productBatchItem.updateMany.mock.calls.every(
          ([input]: any[]) => input.data.errorCode === undefined,
        ),
      ).toBe(true);
    },
  );

  it('fails closed when online verification cannot read both state and inventory', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date(Date.now() - 6 * 60_000).toISOString());
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.adapters.create.mockReturnValue({
      getProductState: vi.fn(),
      offlineProduct: vi.fn(),
    });

    await expect(fixture.service.verifyOnlineResult(USER, '41', '51')).rejects.toThrow(
      '当前平台无法回读商品状态与库存',
    );
  });

  it('re-quarantines a delayed online result using the recorded quarantine revision', async () => {
    const fixture = createFixture();
    const startedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const base = unknownOnlineExecutionRecord(startedAt);
    const item = unknownOnlineExecutionRecord(startedAt, {
      result: {
        ...base.result,
        quarantineRevision: 2,
        quarantinedAt: '2026-08-04T07:51:00.000Z',
      },
      publishedProduct: publishedProduct({
        status: 'offline',
        mutationRevision: 2,
        inventorySyncStatus: 'pending',
      }),
    });
    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'failed', items: [] }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );

    await fixture.service.verifyOnlineResult(USER, '41', '51');

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 2 }),
        data: expect.objectContaining({ status: 'offline', mutationRevision: { increment: 1 } }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({ quarantineRevision: 3 }),
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'ONLINE_LATE_APPLY_QUARANTINED' }),
      }),
    );
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

  it('turns a stale online write into a verification fence even after cancellation', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchItem.findMany.mockResolvedValue([
      {
        id: 51n,
        taskId: 41n,
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        lockedBy: 'dead-worker',
        errorCode: 'ONLINE_WRITE_STARTED',
        task: { action: 'online', cancelRequestedAt: NOW },
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
          errorCode: 'ONLINE_RESULT_UNKNOWN',
        }),
      }),
    );
  });

  it('turns a stale cleanup write into an offline verification fence even after cancellation', async () => {
    const fixture = createFixture();
    fixture.prisma.productBatchItem.findMany.mockResolvedValue([
      {
        id: 51n,
        taskId: 41n,
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        lockedBy: 'dead-worker',
        errorCode: 'OFFLINE_WRITE_STARTED',
        task: { action: 'cleanup', cancelRequestedAt: NOW },
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
          errorCode: 'OFFLINE_RESULT_UNKNOWN',
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
        items: [{ status: 'failed' }],
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
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(3);
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

  it('persists a platform-deleted result from batch offline as rejected instead of offline', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.offlineProduct.mockResolvedValue(undefined);
    fixture.adapter.getProductState.mockResolvedValue(platformState('deleted'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'rejected',
          inventorySyncReason: 'platform_product_deleted',
          platformStatusRaw: 2,
          platformCheckStatusRaw: 3,
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'platform_product_deleted',
            platformState: expect.objectContaining({ state: 'deleted' }),
          }),
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

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(2);
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
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(3);
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

  it('keeps a definite adapter rejection out of the offline unknown-result fence', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.offlineProduct.mockRejectedValue(new Error('HTTP 400 invalid product state'));
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));

    let failure: unknown;
    try {
      await fixture.service.executeClaimed(item);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'OFFLINE_UPDATE_FAILED', retryable: true });
    await expect(fixture.service.failClaimedItem(item, failure)).resolves.toBe('retry_wait');

    const failureWrites = fixture.prisma.productBatchItem.updateMany.mock.calls.filter(
      ([args]: any[]) => args.data?.status === 'retry_wait' || args.data?.status === 'failed',
    );
    expect(failureWrites.at(-1)?.[0]).toMatchObject({
      data: expect.objectContaining({ errorCode: 'OFFLINE_UPDATE_FAILED' }),
    });
    expect(
      fixture.prisma.productBatchItem.updateMany.mock.calls.some(
        ([args]: any[]) => args.data?.errorCode === 'OFFLINE_RESULT_UNKNOWN',
      ),
    ).toBe(false);
  });

  it('does not call the platform when a cleanup preview has gained a valid order', async () => {
    const fixture = createFixture();
    const item = cleanupExecutionRecord();
    fixture.prepareExecution(item);
    fixture.prisma.$queryRaw.mockResolvedValue([
      { publishedProductId: 11n, validOrderCount: 1n, lastPaidAt: new Date() },
    ]);

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '商品在清理预览后出现有效订单',
    );

    expect(fixture.adapter.getProductState).not.toHaveBeenCalled();
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
  });

  it('persists the real offline state and a manual-review failure when a sale arrives during cleanup', async () => {
    const fixture = createFixture();
    const item = cleanupExecutionRecord();
    fixture.prepareExecution(item);
    fixture.prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { publishedProductId: 11n, validOrderCount: 1n, lastPaidAt: new Date() },
      ]);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'offline' }) }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'CLEANUP_SALE_DETECTED_AFTER_OFFLINE',
          errorMessage: expect.stringContaining('人工复核'),
        }),
      }),
    );
  });

  it('writes an offline fence before the platform mutation and renews both ownership guards', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));

    await fixture.service.executeClaimed(item);

    const markerCall = fixture.prisma.productBatchItem.updateMany.mock.calls.find(
      ([args]: any[]) => args.data?.errorCode === 'OFFLINE_WRITE_STARTED',
    );
    expect(markerCall).toBeDefined();
    expect(markerCall?.[0]).toMatchObject({
      where: { id: 51n, status: 'running', attempts: 1, lockedBy: 'worker-1' },
      data: {
        errorCode: 'OFFLINE_WRITE_STARTED',
        result: expect.objectContaining({ offlineWriteStartedAt: expect.any(String) }),
      },
    });
    expect(fixture.productLocks.renew).toHaveBeenCalled();
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lockedAt: expect.any(Date) } }),
    );
    expect(
      fixture.prisma.productBatchItem.updateMany.mock.invocationCallOrder.find(
        (_order: number, index: number) =>
          (fixture.prisma.productBatchItem.updateMany.mock.calls[index]?.[0] as any)?.data
            ?.errorCode === 'OFFLINE_WRITE_STARTED',
      ),
    ).toBeLessThan(fixture.adapter.offlineProduct.mock.invocationCallOrder[0]!);
  });

  it('recovers an offline commit whose transaction acknowledgement was lost', async () => {
    const fixture = createFixture();
    const item = executionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.prisma.productBatchItem.findUnique
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce({ ...item, status: 'succeeded', errorCode: null });
    fixture.prisma.publishedProduct.findUnique
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce({ ...item.publishedProduct, status: 'offline', mutationRevision: 2 });
    fixture.prisma.$transaction.mockImplementationOnce(async (callback: any) => {
      await callback(fixture.prisma);
      throw new Error('transaction commit acknowledgement lost');
    });

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledOnce();
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'succeeded' }) }),
    );
  });

  it('keeps a started offline write as unknown when cancellation races with readback failure', async () => {
    const fixture = createFixture();
    const item = executionRecord({
      errorCode: 'OFFLINE_WRITE_STARTED',
      result: { phase: 'platform_write_started', offlineWriteStartedAt: new Date().toISOString() },
      task: { ...executionRecord().task, cancelRequestedAt: new Date() },
    });
    fixture.prisma.productBatchItem.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      fixture.service.failClaimedItem(item, new Error('readback unavailable')),
    ).resolves.toBe('failed');

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'OFFLINE_RESULT_UNKNOWN',
        }),
      }),
    );
  });

  it('verifies an unknown cleanup result only after two offline reads agree', async () => {
    const fixture = createFixture();
    const item = unknownOfflineExecutionRecord(
      new Date(Date.now() - 6 * 60_000).toISOString(),
      'cleanup',
    );
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.findUnique.mockResolvedValue(item);
    fixture.prisma.publishedProduct.findUnique.mockResolvedValue(item.publishedProduct);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'failed',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'succeeded' }],
    });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'cleanup', status: 'succeeded', items: [] }),
    );
    fixture.prisma.$queryRaw.mockResolvedValue([]);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));

    await expect(fixture.service.verifyOfflineResult(USER, '41', '51')).resolves.toMatchObject({
      action: 'cleanup',
      status: 'succeeded',
    });

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'succeeded', errorCode: null }),
      }),
    );
  });

  it('turns a stable online cleanup result into a retryable not-applied failure after five minutes', async () => {
    const fixture = createFixture();
    const item = unknownOfflineExecutionRecord(
      new Date(Date.now() - 6 * 60_000).toISOString(),
      'cleanup',
    );
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.findUnique.mockResolvedValue(item);
    fixture.prisma.publishedProduct.findUnique.mockResolvedValue(item.publishedProduct);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findUnique.mockResolvedValue({
      id: 41n,
      status: 'failed',
      stateRevision: 1,
      confirmedAt: NOW,
      cancelRequestedAt: null,
      items: [{ status: 'failed' }],
    });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'cleanup', status: 'failed', items: [] }),
    );
    fixture.prisma.$queryRaw.mockResolvedValue([]);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));

    await fixture.service.verifyOfflineResult(USER, '41', '51');

    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'OFFLINE_RESULT_NOT_APPLIED',
        }),
      }),
    );
  });

  it('fills inventory while offline and onlines only after state and inventory readback agree', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));
    fixture.adapter.getProductInventory
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 5],
            ['sku-b', 8],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 7],
            ['sku-b', 13],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 7],
            ['sku-b', 13],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 13],
        ]),
      );

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.syncInventory).toHaveBeenCalledWith(
      'shop-token',
      expect.objectContaining({
        platformProductId: '998877',
        items: [
          { sourceSkuId: 'sku-a', stock: 7 },
          { sourceSkuId: 'sku-b', stock: 13 },
        ],
      }),
    );
    expect(fixture.adapter.onlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(4);
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1 }),
        data: expect.objectContaining({
          status: 'online',
          skuInventorySnapshot: inventorySnapshot([
            ['sku-a', 7],
            ['sku-b', 13],
          ]),
          inventoryFingerprint: 'b'.repeat(64),
          inventoryVersion: 4,
          inventorySyncStatus: 'synced',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({ reason: 'online_confirmed', actualStatus: 'online' }),
        }),
      }),
    );
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
  });

  it('recovers an already-online platform product only when its full inventory matches', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord({ attempts: 2 });
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.syncInventory).not.toHaveBeenCalled();
    expect(fixture.adapter.onlineProduct).not.toHaveBeenCalled();
    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          result: expect.objectContaining({
            reason: 'platform_online_recovered',
            recovered: true,
          }),
        }),
      }),
    );
  });

  it('quarantines an already-online recovery when the second state read is no longer online', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord({ attempts: 2 });
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '平台状态与库存回读的售卖状态不一致',
    );

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledOnce();
    expect(fixture.prisma.productBatchItem.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'succeeded' }),
      }),
    );
  });

  it('persists a pre-write deleted drift as a terminal product without platform mutation', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState.mockResolvedValueOnce(platformState('deleted'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.getProductInventory).not.toHaveBeenCalled();
    expect(fixture.adapter.onlineProduct).not.toHaveBeenCalled();
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'rejected',
          platformStatusRaw: 2,
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'ONLINE_RESULT_REJECTED',
          result: expect.objectContaining({ actualStatus: 'deleted' }),
        }),
      }),
    );
  });

  it.each(['inventory timeout', 'malformed inventory'])(
    'quarantines a known-online execution after %s without ordinary retry',
    async (failure) => {
      const fixture = createFixture();
      const item = onlineExecutionRecord({ attempts: 2 });
      fixture.prepareExecution(item);
      let fenceMarked = false;
      fixture.prisma.productBatchItem.updateMany.mockImplementation(
        async ({ where, data }: any) => {
          if (data?.errorCode === 'ONLINE_RESULT_UNKNOWN') {
            fenceMarked = true;
            return { count: 1 };
          }
          if (where?.errorCode) return { count: fenceMarked ? 1 : 0 };
          if (where?.task?.cancelRequestedAt) return { count: 0 };
          return { count: 1 };
        },
      );
      if (failure === 'inventory timeout') {
        fixture.adapter.getProductState
          .mockResolvedValueOnce(platformState('online'))
          .mockResolvedValueOnce(platformState('offline'));
        fixture.adapter.getProductInventory.mockRejectedValueOnce(new Error('inventory timeout'));
      } else {
        fixture.adapter.getProductState
          .mockResolvedValueOnce(platformState('online'))
          .mockResolvedValueOnce(platformState('online'))
          .mockResolvedValueOnce(platformState('offline'));
        fixture.adapter.getProductInventory.mockResolvedValueOnce({
          ...platformState('online'),
          items: [],
        });
      }

      let thrown: unknown;
      try {
        await fixture.service.executeClaimed(item);
      } catch (error) {
        thrown = error;
      }

      expect(fixture.adapter.offlineProduct).toHaveBeenCalledOnce();
      expect(fixture.adapter.onlineProduct).not.toHaveBeenCalled();
      await expect(fixture.service.failClaimedItem(item, thrown)).resolves.toBe('failed');
      expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            errorCode: 'ONLINE_RESULT_UNKNOWN',
          }),
        }),
      );
    },
  );

  it.each(['offline not confirmed', 'quarantine readback failed', 'quarantine lock lost'])(
    'keeps an online verification fence when %s',
    async (failure) => {
      const fixture = createFixture();
      const item = onlineExecutionRecord({ attempts: 2 });
      fixture.prepareExecution(item);
      let fenceMarked = false;
      fixture.prisma.productBatchItem.updateMany.mockImplementation(
        async ({ where, data }: any) => {
          if (data?.errorCode === 'ONLINE_RESULT_UNKNOWN') {
            fenceMarked = true;
            return { count: 1 };
          }
          if (where?.errorCode) return { count: fenceMarked ? 1 : 0 };
          if (where?.task?.cancelRequestedAt) return { count: 0 };
          return { count: 1 };
        },
      );
      fixture.adapter.getProductState.mockResolvedValueOnce(platformState('online'));
      fixture.adapter.getProductInventory.mockRejectedValueOnce(new Error('inventory timeout'));
      if (failure === 'offline not confirmed') {
        fixture.adapter.offlineProduct.mockRejectedValueOnce(new Error('offline request failed'));
        fixture.adapter.getProductState.mockResolvedValueOnce(platformState('online'));
      } else if (failure === 'quarantine readback failed') {
        fixture.adapter.getProductState.mockRejectedValueOnce(
          new Error('quarantine readback failed'),
        );
      } else {
        fixture.productLocks.renew
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('quarantine lock lost'));
      }

      let thrown: unknown;
      try {
        await fixture.service.executeClaimed(item);
      } catch (error) {
        thrown = error;
      }
      await expect(fixture.service.failClaimedItem(item, thrown)).resolves.toBe('failed');

      expect(fenceMarked).toBe(true);
      expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            errorCode: 'ONLINE_RESULT_UNKNOWN',
          }),
        }),
      );
      expect(fixture.adapter.offlineProduct).toHaveBeenCalledTimes(
        failure === 'quarantine lock lost' ? 0 : 1,
      );
    },
  );

  it('blocks candidates after failed online quarantine and allows only verify recovery', async () => {
    const fixture = createFixture();
    const item = unknownOnlineExecutionRecord(new Date().toISOString());
    fixture.prisma.publishedProduct.count.mockResolvedValue(1);
    fixture.prisma.publishedProduct.findMany.mockResolvedValue([
      publishedProduct({
        status: 'offline',
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
    fixture.prisma.productBatchItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 51n, taskId: 41n, publishedProductId: 11n }]);

    await expect(
      fixture.service.listCandidates(USER, { page: 1, pageSize: 50, status: 'offline' }),
    ).resolves.toMatchObject({
      items: [
        {
          onlineEligible: false,
          onlineVerificationTaskId: '41',
          onlineVerificationItemId: '51',
        },
      ],
    });

    fixture.prepareExecution(item);
    fixture.prisma.productBatchItem.findFirst.mockResolvedValue(item);
    fixture.prisma.productBatchItem.updateMany.mockResolvedValue({ count: 1 });
    fixture.prisma.productBatchTask.findFirst.mockResolvedValue(
      taskRecord({ action: 'online', status: 'succeeded', items: [] }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('online'))
      .mockResolvedValueOnce(platformState('online'));
    fixture.adapter.getProductInventory.mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );

    await expect(fixture.service.verifyOnlineResult(USER, '41', '51')).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  it('fails closed before platform access when safe online capabilities are incomplete', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    const onlineProduct = vi.fn();
    fixture.prepareExecution(item);
    fixture.adapters.create.mockReturnValue({
      onlineProduct,
      offlineProduct: vi.fn(),
      syncInventory: vi.fn(),
      getProductState: vi.fn(),
    });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '当前平台不支持库存可回读的安全上架',
    );

    expect(onlineProduct).not.toHaveBeenCalled();
  });

  it('does not submit online when the lock expires after the write fence is persisted', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValue(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    );
    fixture.productLocks.renew
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('product lock lost'));

    let thrown: unknown;
    try {
      await fixture.service.executeClaimed(item);
    } catch (error) {
      thrown = error;
    }

    expect(fixture.adapter.onlineProduct).not.toHaveBeenCalled();
    await expect(fixture.service.failClaimedItem(item, thrown)).resolves.toBe('retry_wait');
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'retry_wait',
          errorCode: 'ONLINE_WRITE_GUARD_LOST',
        }),
      }),
    );
  });

  it('quarantines a post-write readback failure and keeps the online fence despite cancellation', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockRejectedValueOnce(new Error('readback timed out'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValue(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    );
    let writeStarted = false;
    fixture.prisma.productBatchItem.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (data?.errorCode === 'ONLINE_WRITE_STARTED') {
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
    (item.task as { cancelRequestedAt: Date | null }).cancelRequestedAt = NOW;

    expect(fixture.adapter.onlineProduct).toHaveBeenCalledOnce();
    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.adapter.offlineProduct).toHaveBeenCalledOnce();
    await expect(fixture.service.failClaimedItem(item, thrown)).resolves.toBe('failed');
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'ONLINE_RESULT_UNKNOWN',
        }),
      }),
    );
  });

  it('creates a new quarantine revision when a retried online attempt crashes again', async () => {
    const fixture = createFixture();
    const base = onlineExecutionRecord();
    const item = onlineExecutionRecord({
      expectedMutationRevision: 2,
      publishedProduct: {
        ...base.publishedProduct,
        mutationRevision: 2,
      },
    });
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockRejectedValueOnce(new Error('second attempt readback timed out'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValue(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    );

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '上架写入后无法可靠回读平台状态与库存',
    );

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 2 }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({ quarantineRevision: 3 }),
        }),
      }),
    );
  });

  it('quarantines a reverse post-write state and inventory inconsistency exactly once', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 7],
            ['sku-b', 13],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 7],
            ['sku-b', 13],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 13],
        ]),
      );

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '平台状态与库存双回读未稳定收敛',
    );

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledOnce();
  });

  it('stops local quarantine commit when the product lock expires after remote offlining', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockRejectedValueOnce(new Error('readback timed out'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValue(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    );
    fixture.productLocks.renew
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('product lock lost after remote offline'));

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow('自动下架隔离未确认');

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledOnce();
    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
  });

  it('does not let a lost old attempt offline a newer local revision', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory.mockResolvedValue(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    );
    fixture.productLocks.renew
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('product lock lost'));
    fixture.productLocks.acquire
      .mockResolvedValueOnce('product-lock')
      .mockResolvedValueOnce('quarantine-lock');
    fixture.prisma.publishedProduct.findUnique
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce({
        ...item.publishedProduct,
        status: 'online',
        mutationRevision: 2,
      });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '旧上架任务不能覆盖其平台状态',
    );

    expect(fixture.adapter.onlineProduct).toHaveBeenCalledOnce();
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
    expect(fixture.productLocks.release).toHaveBeenCalledWith(11n, 'quarantine-lock');
  });

  it('preserves an explicit online inconsistency even when inventory sync also failed', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));
    fixture.adapter.getProductInventory
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 5],
            ['sku-b', 8],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce(
        platformInventory([
          ['sku-a', 7],
          ['sku-b', 13],
        ]),
      );
    fixture.adapter.syncInventory.mockRejectedValueOnce(new Error('inventory mutation failed'));

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '库存同步期间平台商品状态发生变化',
    );

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
  });

  it('does not quarantine when the online transaction committed but its ACK was lost', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    const desiredInventory = inventorySnapshot([
      ['sku-a', 7],
      ['sku-b', 13],
    ]);
    const committedProduct = publishedProduct({
      status: 'online',
      mutationRevision: 2,
      skuInventorySnapshot: desiredInventory,
      inventoryFingerprint: 'b'.repeat(64),
      inventoryTargetFingerprint: 'b'.repeat(64),
      inventoryVersion: 4,
      inventoryTargetVersion: 4,
      inventorySyncStatus: 'synced',
      task: { userId: 1n },
    });
    const committedItem = {
      ...item,
      status: 'succeeded',
      errorCode: null,
      result: {
        actualStatus: 'online',
        actualInventory: desiredInventory,
      },
    };
    fixture.prepareExecution(item);
    prepareConfirmedOnlineReadback(fixture);
    fixture.prisma.publishedProduct.findUnique
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(committedProduct);
    fixture.prisma.productBatchItem.findUnique
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce(committedItem);
    fixture.prisma.$transaction.mockImplementation(async (callback: any) => {
      await callback(fixture.prisma);
      throw new Error('transaction commit acknowledgement lost');
    });

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledOnce();
  });

  it('persists a rejected post-write state so the product cannot be previewed online again', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('rejected'))
      .mockResolvedValueOnce(platformState('rejected'));
    fixture.adapter.getProductInventory
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 7],
            ['sku-b', 13],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce(
        platformInventory(
          [
            ['sku-a', 7],
            ['sku-b', 13],
          ],
          'offline',
        ),
      )
      .mockResolvedValueOnce({
        ...platformState('rejected'),
        items: inventorySnapshot([
          ['sku-a', 7],
          ['sku-b', 13],
        ]).items,
      });

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'rejected',
          mutationRevision: { increment: 1 },
          platformCheckStatusRaw: 4,
        }),
      }),
    );
    expect(fixture.prisma.productBatchItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorCode: 'ONLINE_RESULT_REJECTED',
        }),
      }),
    );
  });

  it('quarantines a confirmed platform online result when the local product CAS loses', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    fixture.prepareExecution(item);
    prepareConfirmedOnlineReadback(fixture);
    fixture.adapter.getProductState.mockResolvedValueOnce(platformState('offline'));
    fixture.prisma.publishedProduct.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow('商品已在上架期间发生变化');

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mutationRevision: 1 }),
        data: expect.objectContaining({ status: 'offline' }),
      }),
    );
  });

  it('quarantines when the 1688 inventory version changes after platform online', async () => {
    const fixture = createFixture();
    const item = onlineExecutionRecord();
    const changedSource = publishedProduct({
      status: 'offline',
      inventorySyncStatus: 'pending',
      task: item.publishedProduct.task,
      sourceProduct: {
        ...item.publishedProduct.sourceProduct,
        inventoryFingerprint: 'c'.repeat(64),
        inventoryVersion: 5,
      },
    });
    fixture.prepareExecution(item);
    prepareConfirmedOnlineReadback(fixture);
    fixture.adapter.getProductState.mockResolvedValueOnce(platformState('offline'));
    fixture.prisma.publishedProduct.findUnique
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(item.publishedProduct)
      .mockResolvedValueOnce(changedSource)
      .mockResolvedValueOnce(item.publishedProduct);

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '1688 货源、商品状态或库存快照已变化',
    );

    expect(fixture.adapter.offlineProduct).toHaveBeenCalledWith('shop-token', '998877');
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

  it('switches only the local versioned source binding after two stable offline reads', async () => {
    const fixture = createFixture();
    const item = sourceChangeExecutionRecord();
    const target = targetSourceProduct();
    fixture.prepareExecution(item);
    fixture.prisma.sourceProduct.findFirst.mockResolvedValue(target);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));

    await expect(fixture.service.executeClaimed(item)).resolves.toBe('processed');

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(2);
    expect(fixture.adapter.onlineProduct).not.toHaveBeenCalled();
    expect(fixture.adapter.offlineProduct).not.toHaveBeenCalled();
    expect(fixture.adapter.updateProductTitle).not.toHaveBeenCalled();
    expect(fixture.adapter.updateProductPrice).not.toHaveBeenCalled();
    expect(fixture.adapter.syncInventory).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProductSourceBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 71n, revision: 1, currentSlot: 1 }),
        data: expect.objectContaining({ currentSlot: null, effectiveTo: expect.any(Date) }),
      }),
    );
    expect(fixture.prisma.publishedProductSourceBinding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishedProductId: 11n,
          sourceProductId: 32n,
          revision: 2,
          currentSlot: 1,
          sourceOfferId: '16880002',
        }),
      }),
    );
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 11n,
          status: 'offline',
          sourceProductId: 31n,
          mutationRevision: 1,
        }),
        data: expect.objectContaining({
          sourceProductId: 32n,
          costPrice: 11,
          mutationRevision: { increment: 1 },
          inventorySyncStatus: 'pending',
          inventoryTargetFingerprint: 'e'.repeat(64),
          inventoryTargetVersion: 8,
        }),
      }),
    );
  });

  it('does not change the source when the platform is not stably offline', async () => {
    const fixture = createFixture();
    const item = sourceChangeExecutionRecord();
    fixture.prepareExecution(item);
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('online'));

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '平台未连续确认商品处于下架状态',
    );

    expect(fixture.prisma.publishedProductSourceBinding.updateMany).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProductSourceBinding.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
  });

  it('does not switch the binding when the target loses its supplier identifier', async () => {
    const fixture = createFixture();
    const item = sourceChangeExecutionRecord();
    fixture.prepareExecution(item);
    fixture.prisma.sourceProduct.findFirst.mockResolvedValue(
      targetSourceProduct({ supplierId: null }),
    );
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'));

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '目标 1688 货源缺少供应商标识，不能安全采购',
    );

    expect(fixture.prisma.publishedProductSourceBinding.updateMany).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProductSourceBinding.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
  });

  it('reconfirms two stable offline reads before retrying a serialization conflict', async () => {
    const fixture = createFixture();
    const item = sourceChangeExecutionRecord();
    fixture.prepareExecution(item);
    fixture.prisma.sourceProduct.findFirst.mockResolvedValue(targetSourceProduct());
    fixture.prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    fixture.adapter.getProductState
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('offline'))
      .mockResolvedValueOnce(platformState('online'));

    await expect(fixture.service.executeClaimed(item)).rejects.toThrow(
      '并发重试前平台未连续确认商品下架',
    );

    expect(fixture.adapter.getProductState).toHaveBeenCalledTimes(4);
    expect(fixture.prisma.$transaction).toHaveBeenCalledOnce();
    expect(fixture.prisma.publishedProductSourceBinding.updateMany).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProductSourceBinding.create).not.toHaveBeenCalled();
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

function createFixture(configOverrides: Record<string, string> = {}) {
  const adapter = {
    onlineProduct: vi.fn(),
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
    $queryRaw: vi.fn().mockResolvedValue([]),
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
    publishedProductSourceBinding: {
      create: vi.fn().mockResolvedValue({
        id: 72n,
        revision: 2,
        bindingFingerprint: 'd'.repeat(64),
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sourceProduct: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
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
    DOUYIN_ORDER_SYNC_ENABLED: 'true',
    DOUYIN_ORDER_SYNC_INTERVAL_MS: '60000',
    DOUYIN_ORDER_SYNC_LOOKBACK_DAYS: '30',
    DOUYIN_ORDER_SYNC_HISTORY_VERIFIED_AT: '2026-08-03T00:00:00.000Z',
    PRODUCT_BATCH_ENABLED: 'true',
    PRODUCT_BATCH_MAX_ATTEMPTS: '3',
    ...configOverrides,
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
      prisma.publishedProduct.findUnique.mockResolvedValue(item.publishedProduct);
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

function onlineExecutionRecord(overrides: Record<string, unknown> = {}) {
  const record = executionRecord();
  return {
    ...record,
    beforeSnapshot: {
      status: 'offline',
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
    task: { ...record.task, action: 'online' },
    publishedProduct: publishedProduct({
      status: 'offline',
      inventorySyncStatus: 'pending',
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

function sourceChangeExecutionRecord(overrides: Record<string, unknown> = {}) {
  const record = executionRecord();
  const target = targetSourceProduct();
  const targetSuggestion = buildSkuSuggestion(target.skuList, Number(target.price));
  const targetRoutes = [
    {
      platformSkuKey: 'sku-a',
      sourceSpecId: 'new-white',
      sourceSpecRequired: true,
      sourceUnitCost: 11,
      values: ['白色'],
    },
    {
      platformSkuKey: 'sku-b',
      sourceSpecId: 'new-black',
      sourceSpecRequired: true,
      sourceUnitCost: 13,
      values: ['黑色'],
    },
  ];
  const bindingFingerprint = sourceBindingFingerprint({
    sourceProductId: target.id,
    sourceOfferId: target.productId1688,
    sourceSupplierId: target.supplierId,
    sourceOnePieceDrop: target.isOnePieceDrop,
    sourceFingerprint: targetSuggestion.sourceFingerprint,
    inventoryFingerprint: target.inventoryFingerprint,
    inventoryVersion: target.inventoryVersion,
    skuRoutes: targetRoutes,
  });
  const product = publishedProduct({
    status: 'offline',
    shop: cleanupShop(),
    task: { userId: 1n, skuSnapshot: null },
  });
  return {
    ...record,
    beforeSnapshot: {
      status: 'offline',
      platformProductId: '998877',
      shopId: '21',
      mutationRevision: 1,
      sourceProductDatabaseId: '31',
      sourceProductId: '16880001',
      sourceTitle: '旧 1688 货源',
      sourceBindingId: '71',
      sourceBindingRevision: 1,
      sourceBindingFingerprint: 'c'.repeat(64),
      sourceRoutesFingerprint: sourceBindingRoutesFingerprint(currentSourceRoutes()),
      sourceRoutes: currentSourceRoutes(),
    },
    desiredSnapshot: {
      status: 'offline',
      sourceProductDatabaseId: '32',
      sourceProductId: '16880002',
      sourceTitle: '新 1688 货源',
      sourceSupplierId: 'supplier-new',
      sourceOnePieceDrop: true,
      sourceFingerprint: targetSuggestion.sourceFingerprint,
      inventoryFingerprint: 'e'.repeat(64),
      inventoryVersion: 8,
      sourceSyncedAt: NOW.toISOString(),
      sourceBindingRevision: 2,
      sourceBindingFingerprint: bindingFingerprint,
      sourceRoutesFingerprint: sourceBindingRoutesFingerprint(targetRoutes),
      sourceRoutes: targetRoutes,
    },
    task: { ...record.task, action: 'change_source' },
    publishedProduct: product,
    ...overrides,
  } as unknown as ProductBatchExecutionRecord;
}

function unknownOnlineExecutionRecord(
  onlineWriteStartedAt: string,
  overrides: Record<string, unknown> = {},
) {
  const record = onlineExecutionRecord();
  return {
    ...record,
    status: 'failed',
    errorCode: 'ONLINE_RESULT_UNKNOWN',
    errorMessage: '上架写入结果未知',
    result: { phase: 'platform_write_started', onlineWriteStartedAt },
    lockedAt: null,
    lockedBy: null,
    finishedAt: NOW,
    task: { ...record.task, status: 'failed' },
    ...overrides,
  } as unknown as ProductBatchExecutionRecord;
}

function cleanupExecutionRecord(overrides: Record<string, unknown> = {}) {
  const record = executionRecord();
  const product = cleanupReadyProduct({ task: { userId: 1n, skuSnapshot: null } });
  return {
    ...record,
    beforeSnapshot: {
      status: 'online',
      title: product.title,
      platformProductId: product.platformProductId,
      shopId: product.shopId.toString(),
      mutationRevision: 1,
      cleanupEvidence: cleanupEvidence(product),
    },
    desiredSnapshot: { status: 'offline', reason: 'slow_sales_cleanup' },
    task: { ...record.task, action: 'cleanup' },
    publishedProduct: product,
    ...overrides,
  } as unknown as ProductBatchExecutionRecord;
}

function unknownOfflineExecutionRecord(
  offlineWriteStartedAt: string,
  action: 'offline' | 'cleanup' = 'offline',
) {
  const record = action === 'cleanup' ? cleanupExecutionRecord() : executionRecord();
  return {
    ...record,
    status: 'failed',
    errorCode: 'OFFLINE_RESULT_UNKNOWN',
    errorMessage: '下架写入结果未知',
    result: { phase: 'platform_write_started', offlineWriteStartedAt },
    lockedAt: null,
    lockedBy: null,
    finishedAt: NOW,
    task: { ...record.task, action, status: 'failed' },
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

function platformInventory(items: Array<[string, number]>, state: 'online' | 'offline' = 'online') {
  return {
    state,
    status: state === 'online' ? 0 : 1,
    checkStatus: 3,
    items: inventorySnapshot(items).items,
  };
}

function prepareConfirmedOnlineReadback(fixture: ReturnType<typeof createFixture>) {
  fixture.adapter.getProductState
    .mockResolvedValueOnce(platformState('offline'))
    .mockResolvedValueOnce(platformState('offline'))
    .mockResolvedValueOnce(platformState('online'))
    .mockResolvedValueOnce(platformState('online'));
  fixture.adapter.getProductInventory
    .mockResolvedValueOnce(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    )
    .mockResolvedValueOnce(
      platformInventory(
        [
          ['sku-a', 7],
          ['sku-b', 13],
        ],
        'offline',
      ),
    )
    .mockResolvedValueOnce(
      platformInventory([
        ['sku-a', 7],
        ['sku-b', 13],
      ]),
    );
}

function platformState(
  state:
    | 'online'
    | 'offline'
    | 'deleted'
    | 'draft'
    | 'reviewing'
    | 'rejected'
    | 'blocked'
    | 'approved_pending_online'
    | 'unknown',
) {
  return {
    state,
    status: state === 'online' ? 0 : state === 'deleted' ? 2 : 1,
    checkStatus:
      state === 'draft'
        ? 1
        : state === 'reviewing'
          ? 2
          : state === 'rejected'
            ? 4
            : state === 'blocked'
              ? 5
              : state === 'approved_pending_online'
                ? 7
                : 3,
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

function currentSourceRoutes() {
  return [
    {
      platformSkuKey: 'sku-a',
      sourceSpecId: 'sku-a',
      sourceSpecRequired: true,
      sourceUnitCost: 10,
      values: ['白色'],
    },
    {
      platformSkuKey: 'sku-b',
      sourceSpecId: 'sku-b',
      sourceSpecRequired: true,
      sourceUnitCost: 12,
      values: ['黑色'],
    },
  ];
}

function currentSourceBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 71n,
    publishedProductId: 11n,
    sourceProductId: 31n,
    revision: 1,
    currentSlot: 1,
    effectiveFrom: NOW,
    effectiveTo: null,
    sourceOfferId: '16880001',
    sourceSupplierId: 'supplier-old',
    sourceOnePieceDrop: true,
    sourceFingerprint: 'a'.repeat(64),
    inventoryFingerprint: 'b'.repeat(64),
    inventoryVersion: 4,
    skuRoutes: currentSourceRoutes(),
    bindingFingerprint: 'c'.repeat(64),
    createdAt: NOW,
    ...overrides,
  };
}

function targetSourceProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 32n,
    productId1688: '16880002',
    supplierId: 'supplier-new',
    title: '新 1688 货源',
    price: 11,
    priceMin: 11,
    priceMax: 13,
    mainImage: null,
    detailImages: null,
    categoryPath: null,
    categoryL1: null,
    categoryL2: null,
    skuList: [
      {
        skuId: 'new-white',
        specName: '颜色：白色',
        price: 11,
        stock: 8,
        attributes: { 颜色: '白色' },
      },
      {
        skuId: 'new-black',
        specName: '颜色：黑色',
        price: 13,
        stock: 12,
        attributes: { 颜色: '黑色' },
      },
    ],
    attributes: null,
    monthlySold: 0,
    isCrossBorder: false,
    isOnePieceDrop: true,
    availability: 'available',
    totalStock: 20,
    inventoryFingerprint: 'e'.repeat(64),
    inventoryVersion: 8,
    availabilityChangedAt: NOW,
    syncedAt: NOW,
    ...overrides,
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
    platformStatusRaw: null,
    platformCheckStatusRaw: null,
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
      lastOrderSyncAt: NOW,
      orderSyncAttemptAt: NOW,
      orderSyncError: null,
    },
    sourceProduct: {
      id: 31n,
      productId1688: '16880001',
      supplierId: 'supplier-old',
      title: '旧 1688 货源',
      price: 10,
      availability: 'available',
      isOnePieceDrop: true,
      mainImage: null,
      totalStock: 20,
      inventoryFingerprint: 'b'.repeat(64),
      inventoryVersion: 4,
      skuList: [
        {
          skuId: 'sku-a',
          specName: '颜色：白色',
          price: 10,
          stock: 7,
          attributes: { 颜色: '白色' },
        },
        {
          skuId: 'sku-b',
          specName: '颜色：黑色',
          price: 12,
          stock: 13,
          attributes: { 颜色: '黑色' },
        },
      ],
      syncedAt: NOW,
    },
    sourceBindings: [currentSourceBinding()],
    ...overrides,
  };
}

function cleanupShop(overrides: Record<string, unknown> = {}) {
  return {
    id: 21n,
    shopName: '真实抖店',
    platform: 'douyin',
    platformShopId: 'real-douyin-shop',
    role: 'seller',
    status: 'active',
    accessTokenEnc: 'encrypted',
    lastOrderSyncAt: new Date(Date.now() - 60_000),
    orderSyncAttemptAt: new Date(Date.now() - 60_000),
    orderSyncError: null,
    ...overrides,
  };
}

function cleanupReadyProduct(overrides: Record<string, unknown> = {}) {
  return publishedProduct({
    publishedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
    shop: cleanupShop(),
    task: { skuSnapshot: null },
    ...overrides,
  });
}

function cleanupEvidence(product: ReturnType<typeof publishedProduct>) {
  const observedAt = new Date();
  return {
    policyVersion: 1,
    windowDays: 30,
    graceDays: 7,
    observedAt: observedAt.toISOString(),
    windowStartedAt: new Date(observedAt.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
    daysOnline: 8,
    validOrderCount: 0,
    lastPaidAt: null,
    orderSyncAt: (product.shop.lastOrderSyncAt as Date).toISOString(),
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
  sourceTargets?: Array<{
    publishedProductId: string;
    expectedMutationRevision: number;
    targetSourceProductId: string;
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
        ...(sourceTargets
          ? {
              sourceTargets: [...sourceTargets].sort((left, right) =>
                left.publishedProductId.localeCompare(right.publishedProductId),
              ),
            }
          : {}),
      }),
    )
    .digest('hex');
}
