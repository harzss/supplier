import type { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AiGatewayService } from '../ai/ai-gateway.service';
import type { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import type { ShopTokenService } from '../shop/shop-token.service';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { CategoryPropertyService } from '../category/category-property.service';
import type { CategoryQualificationService } from '../category/category-qualification.service';
import type { AssetStorageService } from './asset-storage.service';
import type { DetailImageRenderer } from './detail-image-renderer.service';
import type { ImagePipelineService, MainImageProcessResult } from './image-pipeline.service';
import { PublishService } from './publish.service';
import { buildSkuSuggestion } from '../sku/sku-normalizer';
import type { PlatformProductLockService } from './platform-product-lock.service';
import { PublishJobLeaseError, type PublishExecutionLease } from './publish-job-lease';
import type { PricingPreviewReceiptService } from './pricing-preview-receipt.service';
import { pricingSourceFingerprint } from './pricing-source-fingerprint';
import type { PublishDraftService } from './publish-draft.service';

const USER: CurrentUser = { userId: 1n, plan: 'pro' };
const CLIENT_REQUEST_ID = '8a4d5b1e-7d9a-4e60-9f81-3ce8f3f5a2d1';
const SHOP = {
  id: 9n,
  userId: 1n,
  platform: 'douyin',
  platformShopId: '4463798',
  shopName: '测试店铺',
  role: 'seller',
  status: 'active',
  accessTokenEnc: 'encrypted-token',
};

describe('PublishService', () => {
  it('returns only entitlement blockers and performs no reads when publishing is locked', async () => {
    const fixture = createFixture();
    fixture.entitlement.assertFeature.mockImplementation((_plan, feature) => {
      if (feature === 'publish.single') throw new ForbiddenException('当前套餐不可铺货');
    });

    const result = await fixture.service.preflight(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
      aiOptions: { titleOverride: '用户确认的纯棉T恤' },
    });

    expect(result).toEqual({
      ready: false,
      checks: [
        expect.objectContaining({
          id: 'entitlement.publish',
          severity: 'blocker',
          scope: 'entitlement',
        }),
      ],
      sourcePricingFingerprint: null,
      pricingPreviewConfirmed: false,
      pricing: null,
    });
    expect(fixture.prisma.sourceProduct.findUnique).not.toHaveBeenCalled();
    expect(fixture.prisma.shop.findMany).not.toHaveBeenCalled();
    expect(fixture.entitlement.getMonthlyPublishCount).not.toHaveBeenCalled();
    expect(fixture.pricingPreviewReceipts.assertValid).not.toHaveBeenCalled();
  });

  it('continues non-pricing checks without exposing a quote when smart pricing is locked', async () => {
    const fixture = createFixture();
    fixture.entitlement.assertFeature.mockImplementation((_plan, feature) => {
      if (feature === 'ai.pricing') throw new ForbiddenException('当前套餐不可使用智能定价');
    });

    const result = await fixture.service.preflight(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
      pricingStrategy: { mode: 'competitor_anchor' },
      aiOptions: { titleOverride: '用户确认的纯棉T恤' },
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'entitlement.pricing' })]),
    );
    expect(result.checks.some((check) => check.id.startsWith('pricing.'))).toBe(false);
    expect(result.sourcePricingFingerprint).toBeNull();
    expect(result.pricing).toBeNull();
    expect(result.pricingPreviewConfirmed).toBe(false);
    expect(fixture.pricingPreviewReceipts.assertValid).not.toHaveBeenCalled();
    expect(fixture.prisma.sourceProduct.findUnique).toHaveBeenCalled();
    expect(fixture.prisma.shop.findMany).toHaveBeenCalled();
    expect(fixture.categoryProperties.buildPublishSnapshot).toHaveBeenCalled();
  });

  it('runs a complete publish preflight without writes, AI or platform adapters', async () => {
    const fixture = createFixture({ authMode: 'supabase' });
    const dto = {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
      aiOptions: { titleOverride: '用户确认的纯棉T恤' },
    };

    await expect(fixture.service.preflight(USER, dto)).resolves.toMatchObject({
      ready: true,
      checks: [],
      sourcePricingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      pricingPreviewConfirmed: true,
      pricing: { costPrice: 10, suggestedPrice: 15 },
    });

    expect(fixture.prisma.shop.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [9n] },
        userId: 1n,
        role: 'seller',
        status: 'active',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
    });
    expect(fixture.categoryProperties.buildPublishSnapshot).toHaveBeenCalledWith(
      1n,
      2n,
      [{ shopId: 9n, categoryId: '12345' }],
      { refresh: false },
    );
    expect(fixture.categoryQualifications.buildPublishSnapshot).toHaveBeenCalledWith(
      1n,
      2n,
      [{ shopId: 9n, categoryId: '12345' }],
      { refresh: false, cachedOnly: true },
    );
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.prisma.shopCategory.update).not.toHaveBeenCalled();
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishTask.update).not.toHaveBeenCalled();
    expect(fixture.prisma.publishJob.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.upsert).not.toHaveBeenCalled();
    expect(fixture.ai.generateTitle).not.toHaveBeenCalled();
    expect(fixture.ai.generateDetail).not.toHaveBeenCalled();
    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.shopTokens.getAccessToken).not.toHaveBeenCalled();
    expect(fixture.publishProduct).not.toHaveBeenCalled();
  });

  it('aggregates independent publish blockers in one preflight response', async () => {
    const skuList = [
      { skuId: 'sku-1', specName: '白色', price: 10, stock: 10, attributes: { 颜色: '白色' } },
      { skuId: 'sku-2', specName: '黑色', price: 10, stock: 10, attributes: { 颜色: '黑色' } },
    ];
    const fixture = createFixture({ attributes: {}, skuList });
    fixture.entitlement.assertFeature.mockImplementation((_plan, feature) => {
      if (feature === 'ai.detail') throw new ForbiddenException('当前套餐不可优化详情');
    });
    fixture.pricingPreviewReceipts.assertValid.mockImplementation(() => {
      throw new BadRequestException('利润试算凭证无效');
    });
    fixture.entitlement.assertWithinQuota.mockImplementation(() => {
      throw new BadRequestException('本月铺货额度不足');
    });

    const result = await fixture.service.preflight(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'invalid-preview',
      aiOptions: { titleOverride: '全网最便宜纯棉T恤', rewriteDetail: true },
    });

    expect(result.ready).toBe(false);
    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'entitlement.ai_detail',
        'pricing.preview_receipt',
        'title.compliance',
        'category.mapping',
        'sku.mapping',
        'quota.publish_monthly',
      ]),
    );
    expect(result.pricingPreviewConfirmed).toBe(false);
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it('does not report dependent qualification errors when category properties are unavailable', async () => {
    const fixture = createFixture();
    fixture.categoryProperties.buildPublishSnapshot.mockRejectedValue(
      new BadRequestException('类目属性尚未确认'),
    );

    const result = await fixture.service.preflight(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
      aiOptions: { titleOverride: '用户确认的纯棉T恤' },
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'category.properties', shopId: '9' })]),
    );
    expect(result.checks.some((check) => check.id === 'category.qualifications')).toBe(false);
    expect(fixture.categoryQualifications.buildPublishSnapshot).not.toHaveBeenCalled();
  });

  it('reports cached qualification blockers without refreshing platform data', async () => {
    const fixture = createFixture();
    fixture.categoryQualifications.buildPublishSnapshot.mockRejectedValue(
      new BadRequestException('请上传必填资质：质检报告'),
    );

    const result = await fixture.service.preflight(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
      aiOptions: { titleOverride: '用户确认的纯棉T恤' },
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'category.qualifications',
          shopId: '9',
          message: '请上传必填资质：质检报告',
        }),
      ]),
    );
    expect(fixture.categoryQualifications.buildPublishSnapshot).toHaveBeenCalledWith(
      1n,
      2n,
      [{ shopId: 9n, categoryId: '12345' }],
      { refresh: false, cachedOnly: true },
    );
  });

  it('filters preflight targets by tenant and production-visible seller shops', async () => {
    const fixture = createFixture({
      authMode: 'supabase',
      shops: [{ ...SHOP, userId: 2n }],
    });

    const result = await fixture.service.preflight(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
      aiOptions: { titleOverride: '用户确认的纯棉T恤' },
    });

    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'shop.target_unavailable', shopId: '9' }),
    );
    expect(fixture.prisma.shop.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 1n, role: 'seller' }) }),
    );
    expect(fixture.entitlement.getMonthlyPublishCount).not.toHaveBeenCalled();
    expect(fixture.categoryProperties.buildPublishSnapshot).not.toHaveBeenCalled();
  });

  it('returns a blocker with null confirmations when a required read fails', async () => {
    const fixture = createFixture();
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fixture.prisma.sourceProduct.findUnique.mockRejectedValue(new Error('db unavailable'));

    const result = await fixture.service.preflight(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
    });

    expect(result).toMatchObject({
      ready: false,
      checks: [
        expect.objectContaining({
          id: 'source.lookup',
          severity: 'blocker',
          message: '预检读取失败，请稍后重试',
        }),
      ],
      sourcePricingFingerprint: null,
      pricingPreviewConfirmed: false,
      pricing: null,
    });
    expect(JSON.stringify(result)).not.toContain('db unavailable');
    expect(logError).toHaveBeenCalledWith({
      event: 'publish.preflight.check_failed',
      checkId: 'source.lookup',
      errorType: 'Error',
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain('db unavailable');
    logError.mockRestore();
  });

  it('revalidates authoritative checks on submit after a successful preflight', async () => {
    const fixture = createFixture();
    const dto = {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingPreviewToken: 'preview-token',
      aiOptions: { titleOverride: '用户确认的纯棉T恤' },
    };
    await expect(fixture.service.preflight(USER, dto)).resolves.toMatchObject({ ready: true });
    fixture.pricingPreviewReceipts.assertValid.mockImplementation(() => {
      throw new BadRequestException('利润试算已失效');
    });

    await expect(fixture.service.enqueue(USER, dto)).rejects.toThrow('利润试算已失效');
    expect(fixture.pricingPreviewReceipts.assertValid).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishJob.create).not.toHaveBeenCalled();
  });

  it('pages all publish tasks without a silent recent-record limit', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.count.mockResolvedValue(51);

    await expect(fixture.service.list(USER, 2, 20)).resolves.toEqual({
      items: [],
      total: 51,
      page: 2,
      pageSize: 20,
    });

    const where = { userId: 1n };
    expect(fixture.prisma.publishTask.count).toHaveBeenCalledWith({ where });
    expect(fixture.prisma.publishTask.findMany).toHaveBeenCalledWith({
      where,
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
      include: {
        publishedProducts: { include: { shop: true } },
        sourceProduct: true,
        job: true,
      },
    });
  });

  it('uses the same real-shop target filter for production count and page queries', async () => {
    const fixture = createFixture({ authMode: 'supabase' });
    fixture.prisma.publishTask.count.mockResolvedValue(1);

    await fixture.service.list(USER, 1, 20);

    expect(fixture.prisma.shop.findMany).toHaveBeenCalledWith({
      where: {
        userId: 1n,
        role: 'seller',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      select: { id: true },
    });
    const where = {
      userId: 1n,
      OR: [{ targetShopIds: { array_contains: ['9'] } }],
    };
    expect(fixture.prisma.publishTask.count).toHaveBeenCalledWith({ where });
    expect(fixture.prisma.publishTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        include: expect.objectContaining({
          publishedProducts: {
            where: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
            include: { shop: true },
          },
        }),
      }),
    );
  });

  it('scopes client request recovery to the current user and production-visible shops', async () => {
    const fixture = createFixture({ authMode: 'supabase' });

    await expect(fixture.service.detailByClientRequestId(USER, CLIENT_REQUEST_ID)).rejects.toThrow(
      '任务不存在',
    );

    expect(fixture.prisma.publishTask.findFirst).toHaveBeenCalledWith({
      where: {
        clientRequestId: CLIENT_REQUEST_ID,
        userId: 1n,
        OR: [{ targetShopIds: { array_contains: ['9'] } }],
      },
      include: {
        publishedProducts: {
          where: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
          include: { shop: true },
        },
        sourceProduct: true,
        job: true,
      },
    });
  });

  it('propagates publish-task database errors instead of returning an empty list', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.count.mockRejectedValue(new Error('db unavailable'));

    await expect(fixture.service.list(USER, 1, 20)).rejects.toThrow('db unavailable');
  });

  it('does not create a publish task when monthly usage cannot be counted', async () => {
    const fixture = createFixture();
    fixture.entitlement.getMonthlyPublishCount.mockRejectedValue(new Error('db unavailable'));

    await expect(
      fixture.service.enqueue(USER, {
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).rejects.toThrow('db unavailable');
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it('replays the original queued task before checking quota or creating another job', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findFirst.mockResolvedValue(
      idempotentTaskRecord({
        targetShopIds: ['10', '9'],
        pricingStrategy: {
          mode: 'fixed_markup',
          markupRatio: 0.6,
          finalPrice: 16,
          breakEvenPrice: 14.74,
          estimatedProfit: 1.2,
          estimatedMargin: 0.075,
          warning: null,
        },
        aiOptions: { rewriteTitle: true },
        job: { id: 7n },
      }),
    );

    await expect(
      fixture.service.enqueue(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9', '10'],
        pricingStrategy: { markupRatio: 0.6, mode: 'fixed_markup' },
        aiOptions: { rewriteTitle: true },
      }),
    ).resolves.toEqual({ taskId: '17', status: 'pending', queued: true, reused: true });

    expect(fixture.entitlement.getMonthlyPublishCount).not.toHaveBeenCalled();
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
    expect(fixture.prisma.publishJob.create).not.toHaveBeenCalled();
  });

  it('does not expose a legacy demo-only task through a production idempotency replay', async () => {
    const fixture = createFixture({ authMode: 'supabase', shops: [] });
    fixture.prisma.publishTask.findFirst.mockResolvedValue(
      idempotentTaskRecord({ targetShopIds: ['9'], job: { id: 7n } }),
    );

    await expect(
      fixture.service.enqueue(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).rejects.toThrow('任务不存在');

    expect(fixture.entitlement.getMonthlyPublishCount).not.toHaveBeenCalled();
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it.each([
    ['source product', { sourceProductId: '1688-2' }],
    ['target shops', { targetShopIds: ['10'] }],
    ['pricing', { pricingStrategy: { mode: 'fixed_markup' as const, markupRatio: 0.7 } }],
    ['AI options', { aiOptions: { rewriteDetail: true } }],
  ])('rejects reuse of a client request id with different %s', async (_label, override) => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findFirst.mockResolvedValue(
      idempotentTaskRecord({
        targetShopIds: ['9'],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.6 },
        aiOptions: { rewriteTitle: true },
        job: { id: 7n },
      }),
    );

    await expect(
      fixture.service.enqueue(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.6 },
        aiOptions: { rewriteTitle: true },
        ...override,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(fixture.entitlement.getMonthlyPublishCount).not.toHaveBeenCalled();
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it('recovers the original task after a concurrent client request id unique conflict', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
      idempotentTaskRecord({
        targetShopIds: ['9'],
        pricingStrategy: null,
        aiOptions: null,
        job: { id: 7n },
      }),
    );
    fixture.prisma.publishTask.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      fixture.service.enqueue(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).resolves.toEqual({ taskId: '17', status: 'pending', queued: true, reused: true });

    expect(fixture.prisma.publishJob.create).not.toHaveBeenCalled();
  });

  it('returns a conflict when a concurrent winner used the same id for different input', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
      idempotentTaskRecord({
        targetShopIds: ['9'],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.6 },
        aiOptions: null,
        job: { id: 7n },
      }),
    );
    fixture.prisma.publishTask.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      fixture.service.enqueue(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
        pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.7 },
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(fixture.prisma.publishJob.create).not.toHaveBeenCalled();
  });

  it('does not execute an existing inline task again', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findFirst.mockResolvedValue(
      idempotentTaskRecord({
        status: 'success',
        targetShopIds: ['9'],
        pricingStrategy: {
          mode: 'fixed_markup',
          finalPrice: 15,
          breakEvenPrice: 14.74,
          estimatedProfit: 0.25,
          estimatedMargin: 0.0167,
          warning: null,
        },
        aiOptions: null,
        job: null,
      }),
    );

    await expect(
      fixture.service.create(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).resolves.toEqual({ taskId: '17', status: 'success', queued: false, reused: true });

    expect(fixture.ai.generateTitle).not.toHaveBeenCalled();
    expect(fixture.publishProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishTask.update).not.toHaveBeenCalled();
  });

  it('creates the pending task and queue job in one transaction', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.enqueue(USER, {
        pricingPreviewToken: 'preview-token',
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).resolves.toEqual({ taskId: '3', status: 'pending', queued: true });
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(fixture.prisma.publishTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 1n,
        status: 'pending',
        pricingStrategy: expect.objectContaining({ costPrice: 10, finalPrice: 15 }),
        publishExternalIds: {
          '9': expect.stringMatching(/^supplier-[0-9a-f-]{36}$/),
        },
      }),
    });
    expect(fixture.prisma.publishJob.create).toHaveBeenCalledWith({
      data: { taskId: 3n, maxAttempts: 3 },
    });
    expect(fixture.pricingPreviewReceipts.assertValid).toHaveBeenCalledWith('preview-token', {
      userId: 1n,
      sourceProductId: '1688-1',
      pricingStrategy: undefined,
      costPrice: 10,
      sourcePricingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fixture.publishDrafts.consumeForPublish).not.toHaveBeenCalled();
  });

  it('validates and consumes an exact draft revision inside the task transaction', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.enqueue(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        draftRevision: 4,
        pricingPreviewToken: 'preview-token',
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).resolves.toEqual({ taskId: '3', status: 'pending', queued: true });

    expect(fixture.publishDrafts.consumeForPublish).toHaveBeenCalledWith(
      fixture.prisma,
      1n,
      expect.objectContaining({
        clientRequestId: CLIENT_REQUEST_ID,
        draftRevision: 4,
      }),
    );
    expect(fixture.prisma.publishJob.create).toHaveBeenCalled();
  });

  it('does not create a queue job when exact draft consumption fails', async () => {
    const fixture = createFixture();
    fixture.publishDrafts.consumeForPublish.mockRejectedValueOnce(
      new BadRequestException('draft changed'),
    );

    await expect(
      fixture.service.enqueue(USER, {
        clientRequestId: CLIENT_REQUEST_ID,
        draftRevision: 4,
        pricingPreviewToken: 'preview-token',
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).rejects.toThrow('draft changed');

    expect(fixture.prisma.publishJob.create).not.toHaveBeenCalled();
  });

  it('returns a server receipt bound to the previewed pricing inputs', async () => {
    const fixture = createFixture();
    const pricingStrategy = { mode: 'fixed_markup' as const, markupRatio: 0.6 };

    await expect(
      fixture.service.previewPricing(USER, { sourceProductId: '1688-1', pricingStrategy }),
    ).resolves.toMatchObject({
      suggestedPrice: 16,
      pricingPreviewToken: 'preview-token',
      pricingPreviewExpiresAt: '2026-08-03T12:30:00.000Z',
      sourcePricingFingerprint: 'pricing-source-fingerprint',
    });
    expect(fixture.pricingPreviewReceipts.issue).toHaveBeenCalledWith({
      userId: 1n,
      sourceProductId: '1688-1',
      pricingStrategy,
      costPrice: 10,
      sourcePricingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('uses plaintext shop tokens and publishes the hosted AI detail image', async () => {
    const fixture = createFixture();

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      aiOptions: { rewriteDetail: true },
    });

    expect(fixture.entitlement.assertFeature).toHaveBeenCalledWith('pro', 'ai.detail');
    expect(fixture.ai.generateDetail).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        title: 'AI 优化标题',
        attributes: expect.objectContaining({ material: '棉' }),
      }),
    );
    expect(fixture.shopTokens.getAccessToken).toHaveBeenCalledWith(9n, 1n);
    expect(fixture.adapters.create).toHaveBeenCalledWith(SHOP);
    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({
        detailHtml: 'https://cdn.example/detail.png|https://img.example/detail.jpg',
        categoryProperties: {
          '2176': [{ value: 111, name: '棉', diyType: 0 }],
        },
        qualifications: [expect.objectContaining({ qualityKey: '9001', qualityName: '质检报告' })],
      }),
    );
    expect(fixture.detailRenderer.render).toHaveBeenCalledWith(
      '<div><section>AI 详情</section></div>',
    );
    expect(fixture.prisma.publishJob.create).not.toHaveBeenCalled();
    expect(fixture.assetStorage.uploadDetailImage).toHaveBeenCalledWith(
      1n,
      3n,
      Buffer.from('detail-png'),
    );
    expect(fixture.prisma.publishedProduct.upsert).toHaveBeenCalledWith({
      where: { uk_publish_task_shop: { taskId: 3n, shopId: 9n } },
      create: expect.objectContaining({
        status: 'draft',
        skuInventorySnapshot: {
          version: 1,
          items: [{ sourceSkuId: 'default', stock: 999 }],
        },
      }),
      update: expect.objectContaining({
        status: 'draft',
        skuInventorySnapshot: {
          version: 1,
          items: [{ sourceSkuId: 'default', stock: 999 }],
        },
      }),
    });
    expect(result.status).toBe('success');
    expect(result.detailOptimized).toBe(true);
    expect(result.detailImageHosted).toBe(true);
    expect(result.mainImageRequested).toBe(false);
  });

  it('publishes the title explicitly selected by the user without regenerating it', async () => {
    const fixture = createFixture();

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      aiOptions: { titleOverride: '用户选择的纯棉T恤', rewriteTitle: true },
    });

    expect(fixture.ai.generateTitle).not.toHaveBeenCalled();
    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({ title: '用户选择的纯棉T恤' }),
    );
    expect(fixture.prisma.publishTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aiOptions: expect.objectContaining({ titleOverride: '用户选择的纯棉T恤' }),
      }),
    });
    expect(result.optimizedTitle).toBe('用户选择的纯棉T恤');
  });

  it('persists an online publish readback so pending inventory is worker-eligible', async () => {
    const fixture = createFixture();
    fixture.getProductInventory.mockResolvedValue({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [{ sourceSkuId: 'default', stock: 777 }],
    });

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    expect(result.status).toBe('success');
    expect(fixture.prisma.publishedProduct.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          skuInventorySnapshot: {
            version: 1,
            items: [{ sourceSkuId: 'default', stock: 777 }],
          },
          inventorySyncStatus: 'pending',
          inventoryFingerprint: null,
          inventoryTargetFingerprint: 'f'.repeat(64),
          inventoryTargetVersion: 4,
          inventorySyncReason: 'publish_readback_mismatch',
          status: 'online',
          platformStatusRaw: 0,
          platformCheckStatusRaw: 3,
        }),
      }),
    );
  });

  it('rechecks the source after publish persistence and queues a newer online target', async () => {
    const fixture = createFixture();
    const initialSource = await fixture.prisma.sourceProduct.findUnique({ where: { id: 2n } });
    fixture.prisma.sourceProduct.findUnique.mockImplementation(async () =>
      fixture.prisma.publishedProduct.upsert.mock.calls.length
        ? {
            ...initialSource,
            inventoryFingerprint: '9'.repeat(64),
            inventoryVersion: 5,
          }
        : initialSource,
    );
    fixture.getProductInventory.mockResolvedValue({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [{ sourceSkuId: 'default', stock: 999 }],
    });

    await expect(
      fixture.service.create(USER, {
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).resolves.toMatchObject({ status: 'success' });

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith({
      where: {
        taskId: 3n,
        shopId: 9n,
        platformProductId: 'mock-product-1',
        status: 'online',
        sourceProduct: {
          inventoryFingerprint: '9'.repeat(64),
          inventoryVersion: 5,
        },
      },
      data: expect.objectContaining({
        inventorySyncStatus: 'pending',
        inventoryTargetFingerprint: '9'.repeat(64),
        inventoryTargetVersion: 5,
        inventoryNextRunAt: expect.any(Date),
        inventorySyncReason: 'source_changed_after_publish',
      }),
    });
  });

  it('does not persist a real publish result when SKU inventory cannot be read back', async () => {
    const fixture = createFixture();
    fixture.adapters.create.mockReturnValue({
      publishProduct: fixture.publishProduct,
      findProductByExternalId: fixture.findProductByExternalId,
    });

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    expect(result.status).toBe('failed');
    expect(result.results[0]?.error).toContain('无法回读 SKU 库存');
    expect(fixture.prisma.publishedProduct.upsert).not.toHaveBeenCalled();
  });

  it('rejects a user-selected title that violates the target platform rules', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.enqueue(USER, {
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
        aiOptions: { titleOverride: '全网最便宜纯棉T恤' },
      }),
    ).rejects.toThrow('所选标题不符合 douyin 平台要求');
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it('rejects buyer accounts as publish targets', async () => {
    const fixture = createFixture({ shops: [{ ...SHOP, role: 'buyer' }] });

    await expect(
      fixture.service.enqueue(USER, {
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).rejects.toThrow('部分目标店铺不可用或不是销售店铺');
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it('excludes legacy demo shops before creating a production publish task', async () => {
    const fixture = createFixture({ authMode: 'supabase', shops: [] });

    await expect(
      fixture.service.enqueue(USER, {
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).rejects.toThrow('部分目标店铺不可用或不是销售店铺');

    expect(fixture.prisma.shop.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [9n] },
        userId: 1n,
        role: 'seller',
        status: 'active',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
    });
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it('keeps demo published products online without waiting for platform review', async () => {
    const fixture = createFixture({
      shops: [{ ...SHOP, platformShopId: 'demo-douyin-1', accessTokenEnc: null }],
    });

    await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    expect(fixture.prisma.publishedProduct.upsert).toHaveBeenCalledWith({
      where: { uk_publish_task_shop: { taskId: 3n, shopId: 9n } },
      create: expect.objectContaining({ status: 'online' }),
      update: expect.objectContaining({ status: 'online' }),
    });
  });

  it('blocks a real platform adapter that cannot recover an ambiguous publish result', async () => {
    const fixture = createFixture();
    fixture.adapters.create.mockReturnValue({ publishProduct: fixture.publishProduct });

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
    });

    expect(result.status).toBe('failed');
    expect(result.results[0]?.error).toContain('暂不支持安全幂等铺货');
    expect(fixture.publishProduct).not.toHaveBeenCalled();
  });

  it('gates, processes, uploads and publishes a requested main-image transformation', async () => {
    const fixture = createFixture({ mainImage: 'https://img.example/main.jpg' });

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      aiOptions: {
        removeWatermark: true,
        relightImages: true,
        backgroundStyle: 'white_studio',
      },
    });

    expect(fixture.entitlement.assertFeature).toHaveBeenCalledWith('pro', 'ai.image.watermark');
    expect(fixture.entitlement.assertFeature).toHaveBeenCalledWith('pro', 'ai.image.relight');
    expect(fixture.entitlement.assertFeature).toHaveBeenCalledWith('pro', 'ai.image.compose');
    expect(fixture.assetStorage.assertConfigured).toHaveBeenCalled();
    expect(fixture.imagePipeline.process).toHaveBeenCalledWith(
      USER,
      'https://img.example/main.jpg',
      {
        removeWatermark: true,
        relight: true,
        backgroundStyle: 'white_studio',
      },
    );
    expect(fixture.assetStorage.uploadMainImage).toHaveBeenCalledWith(
      1n,
      3n,
      Buffer.from('main-png'),
    );
    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({ mainImages: ['https://cdn.example/main.png'] }),
    );
    expect(fixture.prisma.publishedProduct.upsert).toHaveBeenCalledWith({
      where: { uk_publish_task_shop: { taskId: 3n, shopId: 9n } },
      create: expect.objectContaining({ mainImage: 'https://cdn.example/main.png' }),
      update: expect.objectContaining({ mainImage: 'https://cdn.example/main.png' }),
    });
    expect(fixture.prisma.publishTask.update).toHaveBeenCalledWith({
      where: { id: 3n },
      data: expect.objectContaining({
        aiOptimized: expect.objectContaining({
          mainImageRequested: true,
          mainImageUrl: 'https://cdn.example/main.png',
          mainImageError: null,
          mainImageProcessing: expect.objectContaining({
            provider: 'gpu-worker',
            watermarkDetected: true,
          }),
        }),
      }),
    });
    expect(result.mainImageRequested).toBe(true);
    expect(result.mainImageProcessed).toBe(true);
    expect(result.mainImageMessage).toContain('检测到 1 处水印区域');
  });

  it('keeps the original image and does not block publishing when processing fails', async () => {
    const fixture = createFixture({
      mainImage: 'https://img.example/main.jpg',
      imagePipelineError: new Error('主图处理服务未配置'),
    });

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      aiOptions: { removeWatermark: true },
    });

    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({ mainImages: ['https://img.example/main.jpg'] }),
    );
    expect(result.status).toBe('success');
    expect(result.mainImageRequested).toBe(true);
    expect(result.mainImageProcessed).toBe(false);
    expect(result.mainImageMessage).toBe('主图处理服务未配置');
  });

  it('gates smart pricing and persists the resolved profit-target quote', async () => {
    const fixture = createFixture();

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingStrategy: {
        mode: 'profit_target',
        targetMargin: 0.3,
        estimatedShipping: 4,
        platformFeeRate: 0.05,
      },
    });

    expect(fixture.entitlement.assertFeature).toHaveBeenCalledWith('pro', 'ai.pricing');
    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({ salePrice: 21.54 }),
    );
    expect(fixture.prisma.publishTask.update).toHaveBeenCalledWith({
      where: { id: 3n },
      data: expect.objectContaining({
        status: 'publishing',
        pricingStrategy: expect.objectContaining({
          mode: 'profit_target',
          finalPrice: 21.54,
          breakEvenPrice: 14.74,
        }),
      }),
    });
    expect(result.pricing.suggestedPrice).toBe(21.54);
    expect(result.pricing.estimatedMargin).toBeCloseTo(0.3, 3);
  });

  it('publishes confirmed source SKUs with normalized dimensions and per-SKU prices', async () => {
    const skuList = [
      {
        skuId: 'sku-1',
        specName: '米白/M',
        price: 10,
        stock: 12,
        attributes: { 颜色: '米白', 尺码: 'M' },
      },
      {
        skuId: 'sku-2',
        specName: '黑色/L',
        price: 12,
        stock: 8,
        attributes: { 颜色: '黑色', 尺码: 'L' },
      },
    ];
    const fixture = createFixture({
      skuList,
      skuMappings: [
        {
          platform: 'douyin',
          dimensions: ['颜色', '尺码'],
          skus: [
            { sourceSkuId: 'sku-1', values: ['奶白', 'M'], enabled: true },
            { sourceSkuId: 'sku-2', values: ['黑色', 'L'], enabled: true },
          ],
          sourceFingerprint: buildSkuSuggestion(skuList, 10).sourceFingerprint,
        },
      ],
    });
    const sourceProduct = {
      id: 2n,
      productId1688: '1688-1',
      title: '纯棉T恤',
      price: 10,
      categoryPath: '女装/T恤',
      categoryL1: '女装',
      categoryL2: 'T恤',
      isOnePieceDrop: true,
      availability: 'available',
      inventoryFingerprint: 'f'.repeat(64),
      inventoryVersion: 4,
      mainImage: null,
      detailImages: ['https://img.example/detail.jpg'],
      skuList,
      attributes: { douyinCategoryId: '12345', material: '棉' },
      score: null,
    };
    fixture.prisma.sourceProduct.findUnique.mockResolvedValueOnce(sourceProduct).mockResolvedValue({
      price: 10,
      skuList: skuList.map((sku, index) => ({ ...sku, stock: index === 0 ? 7 : 3 })),
      inventoryFingerprint: 'f'.repeat(64),
      inventoryVersion: 4,
    });

    const result = await fixture.service.create(USER, {
      sourceProductId: '1688-1',
      targetShopIds: ['9'],
      pricingStrategy: {
        mode: 'fixed_markup',
        markupRatio: 0.5,
      },
    });

    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({
        skus: [
          {
            sourceSkuId: 'sku-1',
            specName: '奶白/M',
            price: 15,
            stock: 7,
            attributes: { 颜色: '奶白', 尺码: 'M' },
          },
          {
            sourceSkuId: 'sku-2',
            specName: '黑色/L',
            price: 18,
            stock: 3,
            attributes: { 颜色: '黑色', 尺码: 'L' },
          },
        ],
      }),
    );
    expect(fixture.prisma.publishedProduct.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          skuInventorySnapshot: {
            version: 1,
            items: [
              { sourceSkuId: 'sku-1', stock: 7 },
              { sourceSkuId: 'sku-2', stock: 3 },
            ],
          },
        }),
        update: expect.objectContaining({
          skuInventorySnapshot: {
            version: 1,
            items: [
              { sourceSkuId: 'sku-1', stock: 7 },
              { sourceSkuId: 'sku-2', stock: 3 },
            ],
          },
        }),
      }),
    );
    expect(result.skuCount).toBe(2);
    expect(result.skuDimensions).toEqual(['颜色', '尺码']);
  });

  it('rejects a multi-SKU product before queue creation when mapping is unconfirmed', async () => {
    const fixture = createFixture({
      skuList: [
        {
          skuId: 'sku-1',
          specName: '白色',
          price: 10,
          stock: 12,
          attributes: { 颜色: '白色' },
        },
        {
          skuId: 'sku-2',
          specName: '黑色',
          price: 10,
          stock: 8,
          attributes: { 颜色: '黑色' },
        },
      ],
    });

    await expect(
      fixture.service.enqueue(USER, {
        sourceProductId: '1688-1',
        targetShopIds: ['9'],
      }),
    ).rejects.toThrow('请先确认 douyin SKU 规格映射');
    expect(fixture.prisma.publishTask.create).not.toHaveBeenCalled();
  });

  it('retries only unfinished shops and reuses persisted AI output', async () => {
    const fixture = createFixture({ mainImage: 'https://img.example/main.jpg' });
    const pendingShop = { ...SHOP, id: 10n, platformShopId: '4463800', shopName: '待重试店铺' };
    fixture.prisma.publishTask.findUnique.mockResolvedValue({
      id: 3n,
      userId: 1n,
      sourceProductId: 2n,
      targetShopIds: ['9', '10'],
      status: 'partial',
      aiOptimized: {
        title: '已持久化标题',
        mainImageUrl: 'https://cdn.example/reused-main.png',
        mainImageRequested: true,
      },
      aiOptions: { rewriteTitle: true, removeWatermark: true },
      pricingStrategy: fixedPricingSnapshot(),
      errorMsg: '第一次失败',
      createdAt: new Date(),
      finishedAt: new Date(),
      user: { id: 1n, plan: 'pro' },
      sourceProduct: {
        id: 2n,
        productId1688: '1688-1',
        title: '纯棉T恤',
        price: 10,
        categoryPath: '女装/T恤',
        categoryL1: '女装',
        categoryL2: 'T恤',
        isOnePieceDrop: true,
        mainImage: 'https://img.example/main.jpg',
        detailImages: ['https://img.example/detail.jpg'],
        attributes: { douyinCategoryId: '12345', material: '棉' },
        score: null,
      },
      publishedProducts: [{ shopId: 9n }],
    });
    fixture.prisma.shop.findMany.mockResolvedValueOnce([pendingShop]);

    const result = await fixture.service.executeQueued(3n);

    expect(fixture.ai.generateTitle).not.toHaveBeenCalled();
    expect(fixture.imagePipeline.process).not.toHaveBeenCalled();
    expect(fixture.adapters.create).toHaveBeenCalledWith(pendingShop);
    expect(fixture.publishProduct).toHaveBeenCalledTimes(1);
    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({
        title: '已持久化标题',
        mainImages: ['https://cdn.example/reused-main.png'],
      }),
    );
    expect(result.status).toBe('success');
  });

  it('restores the user-selected title from a queued task snapshot', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findUnique.mockResolvedValue({
      id: 3n,
      userId: 1n,
      sourceProductId: 2n,
      targetShopIds: ['9'],
      status: 'pending',
      aiOptimized: null,
      aiOptions: { titleOverride: '队列快照中的纯棉T恤', rewriteTitle: false },
      pricingStrategy: fixedPricingSnapshot(),
      skuSnapshot: null,
      errorMsg: null,
      createdAt: new Date(),
      finishedAt: null,
      user: { id: 1n, plan: 'pro' },
      sourceProduct: {
        id: 2n,
        productId1688: '1688-1',
        title: '纯棉T恤',
        price: 10,
        categoryPath: '女装/T恤',
        categoryL1: '女装',
        categoryL2: 'T恤',
        isOnePieceDrop: true,
        mainImage: null,
        detailImages: [],
        skuList: null,
        attributes: { douyinCategoryId: '12345', material: '棉' },
        score: null,
      },
      publishedProducts: [],
    });

    const result = await fixture.service.executeQueued(3n);

    expect(fixture.ai.generateTitle).not.toHaveBeenCalled();
    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({ title: '队列快照中的纯棉T恤' }),
    );
    expect(result.optimizedTitle).toBe('队列快照中的纯棉T恤');
  });

  it('stops before the next paid operation when ownership is lost after title generation', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findUnique.mockResolvedValue(
      queuedTaskRecord({ aiOptions: { rewriteTitle: true, rewriteDetail: true } }),
    );
    let lost = false;
    fixture.ai.generateTitle.mockImplementation(async () => {
      lost = true;
      return { titles: ['AI 优化标题'] };
    });
    const lease = leaseLostWhen(() => lost);

    await expect(fixture.service.executeQueued(3n, lease)).rejects.toThrow('所有权已变化');

    expect(fixture.ai.generateTitle).toHaveBeenCalledOnce();
    expect(fixture.ai.generateDetail).not.toHaveBeenCalled();
    expect(fixture.imagePipeline.process).not.toHaveBeenCalled();
    expect(fixture.publishProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.upsert).not.toHaveBeenCalled();
  });

  it('stops a queued publish when the 1688 cost changed after pricing confirmation', async () => {
    const fixture = createFixture();
    const task = queuedTaskRecord();
    fixture.prisma.publishTask.findUnique.mockResolvedValue({
      ...task,
      sourceProduct: { ...task.sourceProduct, price: 12 },
    });

    await expect(fixture.service.executeQueued(3n)).rejects.toMatchObject({ status: 409 });

    expect(fixture.ai.generateTitle).not.toHaveBeenCalled();
    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.publishProduct).not.toHaveBeenCalled();
  });

  it('stops a queued publish when a non-minimum SKU cost changed', async () => {
    const fixture = createFixture();
    const task = queuedTaskRecord();
    const originalSource = {
      ...task.sourceProduct,
      skuList: [
        { skuId: 'sku-1', specName: '白色/M', price: 10, stock: 5 },
        { skuId: 'sku-2', specName: '黑色/L', price: 12, stock: 6 },
      ],
    };
    fixture.prisma.publishTask.findUnique.mockResolvedValue({
      ...task,
      pricingStrategy: fixedPricingSnapshot(originalSource),
      sourceProduct: {
        ...originalSource,
        skuList: [originalSource.skuList[0], { ...originalSource.skuList[1], price: 13 }],
      },
    });

    await expect(fixture.service.executeQueued(3n)).rejects.toMatchObject({ status: 409 });

    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.publishProduct).not.toHaveBeenCalled();
  });

  it('finishes an already published task from its confirmed quote without rechecking current cost', async () => {
    const fixture = createFixture();
    const task = queuedTaskRecord();
    fixture.prisma.publishTask.findUnique.mockResolvedValue({
      ...task,
      sourceProduct: { ...task.sourceProduct, price: 12 },
      publishedProducts: [{ shopId: 9n }],
    });

    await expect(fixture.service.executeQueued(3n)).resolves.toMatchObject({
      status: 'success',
      salePrice: 15,
      pricing: { costPrice: 10, suggestedPrice: 15 },
    });

    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.publishProduct).not.toHaveBeenCalled();
  });

  it('rechecks the confirmed cost immediately before the external publish call', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findUnique.mockResolvedValue(
      queuedTaskRecord({ aiOptions: { rewriteTitle: false } }),
    );
    fixture.prisma.sourceProduct.findUnique.mockResolvedValue({ price: 12 });

    await expect(fixture.service.executeQueued(3n)).rejects.toMatchObject({ status: 409 });

    expect(fixture.adapters.create).not.toHaveBeenCalled();
    expect(fixture.publishProduct).not.toHaveBeenCalled();
  });

  it('does not persist an old attempt after platform publishing returns without ownership', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findUnique.mockResolvedValue(
      queuedTaskRecord({ aiOptions: { rewriteTitle: false } }),
    );
    let lost = false;
    fixture.publishProduct.mockImplementation(async () => {
      lost = true;
      return { platformProductId: '998877' };
    });
    const lease = leaseLostWhen(() => lost);

    await expect(fixture.service.executeQueued(3n, lease)).rejects.toThrow('所有权已变化');

    expect(fixture.publishProduct).toHaveBeenCalledOnce();
    expect(fixture.prisma.publishedProduct.upsert).not.toHaveBeenCalled();
    expect(
      fixture.prisma.publishTask.update.mock.calls.some(
        ([input]) => input.data.finishedAt instanceof Date,
      ),
    ).toBe(false);
  });

  it('checkpoints a generated title before the next paid stage and reuses it after takeover', async () => {
    const fixture = createFixture();
    const dtoSnapshot = { rewriteTitle: true, rewriteDetail: true };
    fixture.prisma.publishTask.findUnique.mockResolvedValue(
      queuedTaskRecord({ aiOptions: dtoSnapshot }),
    );
    let checkpoint: Record<string, unknown> | undefined;
    let interrupted = false;
    fixture.prisma.publishTask.update.mockImplementation(async (input) => {
      const aiOptimized = input.data.aiOptimized;
      if (!checkpoint && aiOptimized && typeof aiOptimized === 'object') {
        checkpoint = { ...(aiOptimized as Record<string, unknown>) };
        interrupted = true;
      }
      return {};
    });

    await expect(
      fixture.service.executeQueued(
        3n,
        leaseLostWhen(() => interrupted),
      ),
    ).rejects.toThrow('所有权已变化');
    expect(checkpoint).toMatchObject({ title: 'AI 优化标题', rewriteTitle: true });
    expect(fixture.ai.generateTitle).toHaveBeenCalledOnce();
    expect(fixture.ai.generateDetail).not.toHaveBeenCalled();

    interrupted = false;
    fixture.prisma.publishTask.update.mockResolvedValue({});
    fixture.prisma.publishTask.findUnique.mockResolvedValue(
      queuedTaskRecord({ aiOptions: dtoSnapshot, aiOptimized: checkpoint }),
    );

    await expect(fixture.service.executeQueued(3n)).resolves.toMatchObject({ status: 'success' });
    expect(fixture.ai.generateTitle).toHaveBeenCalledOnce();
    expect(fixture.ai.generateDetail).toHaveBeenCalledOnce();
  });

  it('does not repeat a billed main-image attempt after its checkpoint was persisted', async () => {
    const fixture = createFixture();
    const task = queuedTaskRecord();
    fixture.prisma.publishTask.findUnique.mockResolvedValue({
      ...task,
      aiOptions: { rewriteTitle: false, removeWatermark: true },
      aiOptimized: {
        title: '纯棉T恤',
        mainImageAttempted: true,
        mainImageError: '主图合规审核未通过',
      },
      sourceProduct: {
        ...task.sourceProduct,
        mainImage: 'https://img.example/main.jpg',
      },
    });

    await expect(fixture.service.executeQueued(3n)).resolves.toMatchObject({ status: 'success' });

    expect(fixture.imagePipeline.process).not.toHaveBeenCalled();
    expect(fixture.publishProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({ mainImages: ['https://img.example/main.jpg'] }),
    );
  });

  it('recovers the same platform product after the first local persistence attempt fails', async () => {
    const fixture = createFixture();
    fixture.prisma.publishTask.findUnique.mockResolvedValue({
      id: 3n,
      userId: 1n,
      sourceProductId: 2n,
      targetShopIds: ['9'],
      status: 'pending',
      aiOptimized: null,
      aiOptions: null,
      pricingStrategy: fixedPricingSnapshot(),
      skuSnapshot: null,
      categoryPropertySnapshot: null,
      categoryQualificationSnapshot: null,
      publishExternalIds: { '9': 'supplier-retry-1' },
      errorMsg: null,
      createdAt: new Date(),
      finishedAt: null,
      user: { id: 1n, plan: 'pro' },
      sourceProduct: {
        id: 2n,
        productId1688: '1688-1',
        title: '纯棉T恤',
        price: 10,
        categoryPath: '女装/T恤',
        categoryL1: '女装',
        categoryL2: 'T恤',
        isOnePieceDrop: true,
        mainImage: null,
        detailImages: [],
        skuList: null,
        attributes: { douyinCategoryId: '12345', material: '棉' },
        score: null,
      },
      publishedProducts: [],
    });
    fixture.publishProduct
      .mockResolvedValueOnce({ platformProductId: '998877' })
      .mockRejectedValueOnce(new Error('outerProductId already exists'));
    fixture.findProductByExternalId.mockResolvedValueOnce({ platformProductId: '998877' });
    fixture.prisma.publishedProduct.upsert
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce({});

    await expect(fixture.service.executeQueued(3n)).resolves.toMatchObject({ status: 'failed' });
    await expect(fixture.service.executeQueued(3n)).resolves.toMatchObject({ status: 'success' });

    expect(fixture.publishProduct).toHaveBeenCalledTimes(2);
    expect(fixture.publishProduct.mock.calls[0]?.[1]).toMatchObject({
      externalProductId: 'supplier-retry-1',
    });
    expect(fixture.publishProduct.mock.calls[1]?.[1]).toMatchObject({
      externalProductId: 'supplier-retry-1',
    });
    expect(fixture.findProductByExternalId).toHaveBeenCalledWith(
      'plain-access-token',
      'supplier-retry-1',
    );
    expect(fixture.prisma.publishedProduct.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { uk_publish_task_shop: { taskId: 3n, shopId: 9n } },
        create: expect.objectContaining({ platformProductId: '998877' }),
      }),
    );
  });

  it('revalidates current category data and edits an existing Douyin product', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({
      categoryId: '12345',
      categoryName: 'T恤',
    });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());

    const result = await fixture.service.updatePublishedProduct(USER, '7', {
      title: '修正后的纯棉T恤',
    });

    expect(fixture.updateProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({
        platformProductId: '998877',
        title: '修正后的纯棉T恤',
        categoryId: '12345',
        categoryProperties: {
          '2176': [{ value: 111, name: '棉', diyType: 0 }],
        },
        qualifications: [expect.objectContaining({ qualityKey: '9001' })],
        mainImages: ['https://img.example/main.jpg'],
        skus: [expect.objectContaining({ sourceSkuId: 'default', price: 15 })],
      }),
    );
    expect(fixture.getProductPrices).toHaveBeenCalledWith('plain-access-token', '998877');
    expect(fixture.categoryQualifications.buildPublishSnapshot).toHaveBeenCalledWith(
      1n,
      2n,
      [{ shopId: 9n, categoryId: '12345' }],
      { refresh: true },
    );
    expect(fixture.platformProductLocks.acquire).toHaveBeenCalledWith(7n);
    expect(fixture.platformProductLocks.renew).toHaveBeenCalledTimes(2);
    expect(fixture.platformProductLocks.release).toHaveBeenCalledWith(7n, 'product-lock');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 7n,
        platformProductId: '998877',
        mutationRevision: 1,
        sourceProduct: {
          inventoryFingerprint: 'f'.repeat(64),
          inventoryVersion: 4,
        },
      },
      data: expect.objectContaining({
        title: '修正后的纯棉T恤',
        status: 'draft',
        salePrice: 15,
        skuPriceSnapshot: {
          version: 1,
          items: [{ sourceSkuId: 'default', priceCents: 1500 }],
        },
        skuInventorySnapshot: {
          version: 1,
          items: [{ sourceSkuId: 'default', stock: 999 }],
        },
        inventorySyncStatus: 'synced',
        inventoryFingerprint: 'f'.repeat(64),
        inventoryTargetFingerprint: 'f'.repeat(64),
        inventoryVersion: 4,
        inventoryTargetVersion: 4,
        inventorySyncReason: 'product_edit',
        inventorySyncError: null,
        lastEditError: null,
        platformStatusRaw: 1,
        platformCheckStatusRaw: 1,
        platformStatusSyncedAt: expect.any(Date),
        platformStatusError: null,
      }),
    });
    expect(result).toMatchObject({
      publishedProductId: '7',
      title: '修正后的纯棉T恤',
      status: 'draft',
    });
  });

  it('persists the confirmed platform status instead of reviving a locally online product', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue({
      ...publishedProductRecord(),
      status: 'online',
    });
    fixture.getProductInventory.mockResolvedValue({
      state: 'offline',
      status: 1,
      checkStatus: 3,
      items: [{ sourceSkuId: 'default', stock: 999 }],
    });

    await expect(
      fixture.service.updatePublishedProduct(USER, '7', { title: '下架后修正标题' }),
    ).resolves.toMatchObject({ status: 'offline' });

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'offline',
          platformStatusRaw: 1,
          platformCheckStatusRaw: 3,
          platformStatusSyncedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('preserves a newer batch SKU price when a later title edit rebuilds the full product', async () => {
    const fixture = createFixture();
    const record = publishedProductRecord();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue({
      ...record,
      salePrice: 18,
      skuPriceSnapshot: {
        version: 1,
        items: [{ sourceSkuId: 'default', priceCents: 1800 }],
      },
    });
    fixture.getProductPrices.mockResolvedValue({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [{ sourceSkuId: 'default', priceCents: 1800 }],
    });

    await fixture.service.updatePublishedProduct(USER, '7', { title: '只修改标题' });

    expect(fixture.updateProduct).toHaveBeenCalledWith(
      'plain-access-token',
      expect.objectContaining({
        title: '只修改标题',
        salePrice: 18,
        skus: [expect.objectContaining({ sourceSkuId: 'default', price: 18 })],
      }),
    );
  });

  it('synchronizes unexpected platform inventory and stops before a full product edit', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.getProductInventory.mockResolvedValue({
      state: 'draft',
      status: 1,
      checkStatus: 1,
      items: [{ sourceSkuId: 'default', stock: 555 }],
    });

    await expect(
      fixture.service.updatePublishedProduct(USER, '7', { title: '只修改标题' }),
    ).rejects.toThrow('平台 SKU 库存已变化并同步');

    expect(fixture.updateProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith({
      where: {
        id: 7n,
        platformProductId: '998877',
        mutationRevision: 1,
        sourceProduct: {
          inventoryFingerprint: 'f'.repeat(64),
          inventoryVersion: 4,
        },
      },
      data: expect.objectContaining({
        skuInventorySnapshot: {
          version: 1,
          items: [{ sourceSkuId: 'default', stock: 555 }],
        },
        inventorySyncStatus: 'pending',
        inventorySyncReason: 'platform_inventory_changed',
        mutationRevision: { increment: 1 },
      }),
    });
  });

  it('rejects a full product edit while the platform product is online', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.getProductInventory.mockResolvedValue({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [{ sourceSkuId: 'default', stock: 999 }],
    });

    await expect(
      fixture.service.updatePublishedProduct(USER, '7', { title: '只修改标题' }),
    ).rejects.toThrow('请先下架商品');

    expect(fixture.updateProduct).not.toHaveBeenCalled();
  });

  it('stops before editV2 when inventory changes after the first non-saleable readback', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.getProductInventory
      .mockResolvedValueOnce({
        state: 'draft',
        status: 1,
        checkStatus: 1,
        items: [{ sourceSkuId: 'default', stock: 999 }],
      })
      .mockResolvedValueOnce({
        state: 'draft',
        status: 1,
        checkStatus: 1,
        items: [{ sourceSkuId: 'default', stock: 998 }],
      });

    await expect(
      fixture.service.updatePublishedProduct(USER, '7', { title: '只修改标题' }),
    ).rejects.toThrow('提交前发生变化');

    expect(fixture.updateProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          skuInventorySnapshot: {
            version: 1,
            items: [{ sourceSkuId: 'default', stock: 998 }],
          },
          inventorySyncReason: 'platform_inventory_changed_before_edit',
        }),
      }),
    );
  });

  it('does not mark inventory synced when full product edit readback differs', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.getProductInventory
      .mockResolvedValueOnce({
        state: 'draft',
        status: 1,
        checkStatus: 1,
        items: [{ sourceSkuId: 'default', stock: 999 }],
      })
      .mockResolvedValueOnce({
        state: 'draft',
        status: 1,
        checkStatus: 1,
        items: [{ sourceSkuId: 'default', stock: 999 }],
      })
      .mockResolvedValueOnce({
        state: 'draft',
        status: 1,
        checkStatus: 1,
        items: [{ sourceSkuId: 'default', stock: 555 }],
      });

    await expect(
      fixture.service.updatePublishedProduct(USER, '7', { title: '只修改标题' }),
    ).rejects.toThrow('平台未确认商品编辑后的 SKU 库存');

    expect(fixture.updateProduct).toHaveBeenCalledOnce();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          skuInventorySnapshot: {
            version: 1,
            items: [{ sourceSkuId: 'default', stock: 555 }],
          },
          inventorySyncStatus: 'pending',
          inventorySyncReason: 'product_edit_readback_mismatch',
          mutationRevision: { increment: 1 },
        }),
      }),
    );
    expect(
      fixture.prisma.publishedProduct.updateMany.mock.calls.some(
        ([input]) => input.data?.inventorySyncStatus === 'synced',
      ),
    ).toBe(false);
  });

  it('synchronizes unexpected platform prices and stops before a full product edit', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.getProductPrices.mockResolvedValue({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [{ sourceSkuId: 'default', priceCents: 1800 }],
    });

    await expect(fixture.service.updatePublishedProduct(USER, '7', {})).rejects.toThrow(
      '平台 SKU 价格已变化并同步',
    );

    expect(fixture.updateProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith({
      where: { id: 7n, platformProductId: '998877', mutationRevision: 1 },
      data: expect.objectContaining({
        salePrice: 18,
        skuPriceSnapshot: {
          version: 1,
          items: [{ sourceSkuId: 'default', priceCents: 1800 }],
        },
        mutationRevision: { increment: 1 },
      }),
    });
  });

  it('does not overwrite newer platform inventory with an edit prepared from an older source version', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.prisma.sourceProduct.findUnique.mockResolvedValue({
      inventoryFingerprint: '9'.repeat(64),
      inventoryVersion: 5,
    });

    await expect(fixture.service.updatePublishedProduct(USER, '7', {})).rejects.toThrow(
      '货源库存已变化',
    );

    expect(fixture.updateProduct).not.toHaveBeenCalled();
    expect(fixture.platformProductLocks.release).toHaveBeenCalledWith(7n, 'product-lock');
  });

  it('does not revive a product that was batch-offlined while an edit waited for the lock', async () => {
    const fixture = createFixture();
    const initial = publishedProductRecord();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, status: 'offline', mutationRevision: 2 });

    await expect(fixture.service.updatePublishedProduct(USER, '7', {})).rejects.toThrow(
      '商品已在修正前发生变化',
    );

    expect(fixture.updateProduct).not.toHaveBeenCalled();
    expect(fixture.prisma.publishedProduct.updateMany).not.toHaveBeenCalled();
    expect(fixture.platformProductLocks.release).toHaveBeenCalledWith(7n, 'product-lock');
  });

  it('blocks an edit when the confirmed category changed after publishing', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '54321' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());

    await expect(fixture.service.updatePublishedProduct(USER, '7', {})).rejects.toThrow(
      '不支持修改已发布商品类目',
    );
    expect(fixture.updateProduct).not.toHaveBeenCalled();
  });

  it('persists a safe platform error when product.editV2 rejects the correction', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.findUnique.mockResolvedValue({ categoryId: '12345' });
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.updateProduct.mockRejectedValue(
      new Error('Douyin product update failed: title invalid'),
    );

    await expect(fixture.service.updatePublishedProduct(USER, '7', {})).rejects.toThrow(
      '平台商品更新失败',
    );
    expect(fixture.prisma.publishedProduct.update).toHaveBeenCalledWith({
      where: { id: 7n },
      data: { lastEditError: 'Douyin product update failed: title invalid' },
    });
  });

  it('syncs a rejected Douyin audit state to the published product', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.getProductState.mockResolvedValue({ state: 'rejected', status: 0, checkStatus: 4 });

    const result = await fixture.service.syncPublishedProductStatus(USER, '7');

    expect(fixture.getProductState).toHaveBeenCalledWith('plain-access-token', '998877');
    expect(fixture.platformProductLocks.acquire).toHaveBeenCalledWith(7n);
    expect(fixture.platformProductLocks.renew).toHaveBeenCalledTimes(2);
    expect(fixture.platformProductLocks.release).toHaveBeenCalledWith(7n, 'product-lock');
    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith({
      where: {
        id: 7n,
        platformProductId: '998877',
        mutationRevision: 1,
      },
      data: {
        status: 'rejected',
        mutationRevision: { increment: 1 },
        platformStatusRaw: 0,
        platformCheckStatusRaw: 4,
        platformStatusSyncedAt: expect.any(Date),
        platformStatusError: null,
      },
    });
    expect(result).toMatchObject({
      publishedProductId: '7',
      status: 'rejected',
      platformStatus: 0,
      platformCheckStatus: 4,
    });
  });

  it('queues a retained inventory target when a non-online product becomes online', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue({
      ...publishedProductRecord(),
      status: 'draft',
      inventoryFingerprint: 'f'.repeat(64),
      inventoryVersion: 4,
      inventoryTargetFingerprint: '9'.repeat(64),
      inventoryTargetVersion: 5,
      inventorySyncStatus: 'synced',
    });
    fixture.getProductState.mockResolvedValue({ state: 'online', status: 0, checkStatus: 3 });

    await expect(fixture.service.syncPublishedProductStatus(USER, '7')).resolves.toMatchObject({
      status: 'online',
    });

    expect(fixture.prisma.publishedProduct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'online',
          inventorySyncStatus: 'pending',
          inventorySyncAttempts: 0,
          inventoryNextRunAt: expect.any(Date),
          inventoryLockedAt: null,
          inventoryLockedBy: null,
        }),
      }),
    );
  });

  it('persists the platform error when product status synchronization fails', async () => {
    const fixture = createFixture();
    fixture.prisma.publishedProduct.findFirst.mockResolvedValue(publishedProductRecord());
    fixture.getProductState.mockRejectedValue(new Error('Douyin product detail failed: timeout'));

    await expect(fixture.service.syncPublishedProductStatus(USER, '7')).rejects.toThrow(
      '平台商品状态同步失败',
    );

    expect(fixture.prisma.publishedProduct.update).toHaveBeenCalledWith({
      where: { id: 7n },
      data: { platformStatusError: 'Douyin product detail failed: timeout' },
    });
  });
});

function idempotentTaskRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 17n,
    userId: 1n,
    clientRequestId: CLIENT_REQUEST_ID,
    sourceProductId: 2n,
    targetShopIds: ['9'],
    status: 'pending',
    aiOptions: null,
    pricingStrategy: null,
    sourceProduct: { productId1688: '1688-1', price: 10 },
    job: null,
    ...overrides,
  };
}

function queuedTaskRecord(overrides: Record<string, unknown> = {}) {
  const sourceProduct = {
    id: 2n,
    productId1688: '1688-1',
    title: '纯棉T恤',
    price: 10,
    categoryPath: '女装/T恤',
    categoryL1: '女装',
    categoryL2: 'T恤',
    isOnePieceDrop: true,
    availability: 'available',
    mainImage: null,
    detailImages: [],
    skuList: null,
    attributes: { douyinCategoryId: '12345', material: '棉' },
    score: null,
  };
  return {
    id: 3n,
    userId: 1n,
    sourceProductId: 2n,
    targetShopIds: ['9'],
    status: 'pending',
    aiOptimized: null,
    aiOptions: null,
    pricingStrategy: fixedPricingSnapshot(sourceProduct),
    skuSnapshot: null,
    categoryPropertySnapshot: {
      '9': { '2176': [{ value: 111, name: '棉', diyType: 0 }] },
    },
    categoryQualificationSnapshot: { '9': [] },
    publishExternalIds: { '9': 'supplier-lease-test' },
    errorMsg: null,
    createdAt: new Date(),
    finishedAt: null,
    user: { id: 1n, plan: 'pro' },
    sourceProduct,
    publishedProducts: [],
    ...overrides,
  };
}

function fixedPricingSnapshot(source: { price: unknown; skuList?: unknown } = { price: 10 }) {
  return {
    mode: 'fixed_markup',
    markupRatio: 0.5,
    costPrice: 10,
    finalPrice: 15,
    sourcePricingFingerprint: pricingSourceFingerprint({
      price: source.price,
      skuList: source.skuList ?? null,
    }),
  };
}

function leaseLostWhen(predicate: () => boolean): PublishExecutionLease {
  return {
    assertOwned: vi.fn().mockImplementation(async () => {
      if (predicate()) {
        throw new PublishJobLeaseError('lost', '铺货队列任务所有权已变化');
      }
    }),
  };
}

function publishedProductRecord() {
  return {
    id: 7n,
    shopId: 9n,
    sourceProductId: 2n,
    platformProductId: '998877',
    title: '旧标题',
    salePrice: 15,
    costPrice: 10,
    skuPriceSnapshot: {
      version: 1,
      items: [{ sourceSkuId: 'default', priceCents: 1500 }],
    },
    skuInventorySnapshot: {
      version: 1,
      items: [{ sourceSkuId: 'default', stock: 999 }],
    },
    priceSyncedAt: new Date(),
    status: 'rejected',
    mutationRevision: 1,
    categoryId: '12345',
    mainImage: 'https://img.example/main.jpg',
    shop: SHOP,
    task: {
      pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.5 },
      skuSnapshot: {
        douyin: {
          dimensions: [],
          skus: [
            {
              sourceSkuId: 'default',
              specName: '默认',
              price: 15,
              stock: 999,
              attributes: {},
            },
          ],
        },
      },
      aiOptimized: { detailImageUrl: 'https://cdn.example/detail.png' },
    },
    sourceProduct: {
      id: 2n,
      productId1688: '1688-1',
      title: '纯棉T恤',
      price: 10,
      categoryPath: '女装/T恤',
      categoryL1: '女装',
      categoryL2: 'T恤',
      isOnePieceDrop: true,
      availability: 'available',
      totalStock: 999,
      inventoryFingerprint: 'f'.repeat(64),
      inventoryVersion: 4,
      mainImage: 'https://img.example/source-main.jpg',
      detailImages: ['https://img.example/detail.jpg'],
      skuList: null,
      attributes: { material: '棉' },
      score: null,
    },
  };
}

function createFixture(
  options: {
    mainImage?: string | null;
    imagePipelineError?: Error;
    skuList?: unknown;
    skuMappings?: unknown[];
    attributes?: unknown;
    shops?: unknown[];
    authMode?: 'demo' | 'supabase';
  } = {},
) {
  const prisma = {
    $transaction: vi.fn(),
    sourceProduct: {
      findUnique: vi.fn().mockResolvedValue({
        id: 2n,
        productId1688: '1688-1',
        title: '纯棉T恤',
        price: 10,
        categoryPath: '女装/T恤',
        categoryL1: '女装',
        categoryL2: 'T恤',
        isOnePieceDrop: true,
        availability: 'available',
        inventoryFingerprint: 'f'.repeat(64),
        inventoryVersion: 4,
        mainImage: options.mainImage ?? null,
        detailImages: ['https://img.example/detail.jpg'],
        skuList: options.skuList ?? null,
        attributes: options.attributes ?? { douyinCategoryId: '12345', material: '棉' },
        score: null,
      }),
    },
    shop: {
      findMany: vi.fn().mockResolvedValue(options.shops ?? [SHOP]),
      count: vi.fn().mockResolvedValue((options.shops ?? [SHOP]).length),
    },
    productCategoryMapping: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    productSkuMapping: { findMany: vi.fn().mockResolvedValue(options.skuMappings ?? []) },
    shopCategory: {
      count: vi.fn().mockResolvedValue(1),
      findFirst: vi.fn().mockResolvedValue({ id: 1n }),
      update: vi.fn().mockResolvedValue({}),
    },
    publishTask: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 3n, ...data })),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    publishJob: {
      create: vi.fn().mockResolvedValue({ id: 7n }),
    },
    publishedProduct: {
      upsert: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
  const entitlement = {
    assertFeature: vi.fn(),
    getMonthlyPublishCount: vi.fn().mockResolvedValue(0),
    assertWithinQuota: vi.fn(),
  };
  const ai = {
    generateTitle: vi.fn().mockResolvedValue({ titles: ['AI 优化标题'] }),
    generateDetail: vi.fn().mockResolvedValue({
      detailHtml: '<div><section>AI 详情</section></div>',
      complianceFlags: [],
    }),
  };
  const shopTokens = {
    getAccessToken: vi.fn().mockResolvedValue('plain-access-token'),
  };
  const publishProduct = vi.fn().mockResolvedValue({ platformProductId: 'mock-product-1' });
  const findProductByExternalId = vi.fn().mockResolvedValue(null);
  const updateProduct = vi.fn().mockResolvedValue(undefined);
  const getProductPrices = vi.fn().mockResolvedValue({
    state: 'online',
    status: 0,
    checkStatus: 3,
    items: [{ sourceSkuId: 'default', priceCents: 1500 }],
  });
  const getProductInventory = vi.fn().mockImplementation(async () => {
    const publishInput = publishProduct.mock.calls.at(-1)?.[1] as
      | { skus?: Array<{ sourceSkuId?: string; stock: number }> }
      | undefined;
    const items = publishInput?.skus
      ?.map((sku) => (sku.sourceSkuId ? { sourceSkuId: sku.sourceSkuId, stock: sku.stock } : null))
      .filter((item): item is { sourceSkuId: string; stock: number } => item !== null) ?? [
      { sourceSkuId: 'default', stock: 999 },
    ];
    return { state: 'draft' as const, status: 1, checkStatus: 1, items };
  });
  const getProductState = vi.fn().mockResolvedValue({ state: 'online', status: 0, checkStatus: 3 });
  const adapters = {
    create: vi.fn().mockReturnValue({
      publishProduct,
      findProductByExternalId,
      updateProduct,
      getProductPrices,
      getProductInventory,
      getProductState,
    }),
  };
  const categoryProperties = {
    buildPublishSnapshot: vi.fn().mockResolvedValue({
      '9': { '2176': [{ value: 111, name: '棉', diyType: 0 }] },
    }),
  };
  const categoryQualifications = {
    buildPublishSnapshot: vi.fn().mockResolvedValue({
      '9': [
        {
          qualityKey: '9001',
          qualityName: '质检报告',
          qualityId: 9001,
          attachments: [{ mediaType: 1, url: 'https://cdn.example/quality.jpg' }],
        },
      ],
    }),
  };
  const detailRenderer = { render: vi.fn().mockResolvedValue(Buffer.from('detail-png')) };
  const assetStorage = {
    assertConfigured: vi.fn(),
    uploadDetailImage: vi.fn().mockResolvedValue('https://cdn.example/detail.png'),
    uploadMainImage: vi.fn().mockResolvedValue('https://cdn.example/main.png'),
  };
  const imageResult: MainImageProcessResult = {
    image: Buffer.from('main-png'),
    provider: 'gpu-worker',
    model: 'yolo-flux-sam2-qwen-vl',
    watermarkDetected: true,
    watermarkCount: 1,
    steps: ['watermark_detect', 'inpaint', 'segment', 'background', 'compliance'],
    complianceFlags: [],
    costCny: 0.055,
  };
  const imagePipeline = {
    process: options.imagePipelineError
      ? vi.fn().mockRejectedValue(options.imagePipelineError)
      : vi.fn().mockResolvedValue(imageResult),
  };
  const platformProductLocks = {
    acquire: vi.fn().mockResolvedValue('product-lock'),
    renew: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const pricingPreviewReceipts = {
    issue: vi.fn().mockReturnValue({
      pricingPreviewToken: 'preview-token',
      pricingPreviewExpiresAt: '2026-08-03T12:30:00.000Z',
      sourcePricingFingerprint: 'pricing-source-fingerprint',
    }),
    assertValid: vi.fn(),
  };
  const publishDrafts = {
    consumeForPublish: vi.fn().mockResolvedValue(undefined),
  };
  const service = new PublishService(
    prisma as unknown as PrismaService,
    entitlement as unknown as EntitlementService,
    ai as unknown as AiGatewayService,
    shopTokens as unknown as ShopTokenService,
    adapters as unknown as PlatformAdapterFactory,
    categoryProperties as unknown as CategoryPropertyService,
    categoryQualifications as unknown as CategoryQualificationService,
    detailRenderer as unknown as DetailImageRenderer,
    assetStorage as unknown as AssetStorageService,
    imagePipeline as unknown as ImagePipelineService,
    platformProductLocks as unknown as PlatformProductLockService,
    pricingPreviewReceipts as unknown as PricingPreviewReceiptService,
    publishDrafts as unknown as PublishDraftService,
    {
      get: (key: string) => (key === 'AUTH_MODE' ? (options.authMode ?? 'demo') : undefined),
    } as ConfigService,
  );

  return {
    service,
    prisma,
    entitlement,
    ai,
    shopTokens,
    adapters,
    categoryProperties,
    categoryQualifications,
    publishProduct,
    findProductByExternalId,
    updateProduct,
    getProductPrices,
    getProductInventory,
    getProductState,
    detailRenderer,
    assetStorage,
    imagePipeline,
    platformProductLocks,
    pricingPreviewReceipts,
    publishDrafts,
  };
}
