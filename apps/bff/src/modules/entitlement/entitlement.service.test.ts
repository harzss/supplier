import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../common/prisma.module';
import { EntitlementService } from './entitlement.service';

function makeService(count: number | Error, authMode: 'demo' | 'supabase' = 'demo') {
  const publishedCount = vi.fn().mockImplementation(async () => {
    if (count instanceof Error) throw count;
    return count;
  });
  const prisma = {
    aiUsageLog: {
      count: async () => {
        if (count instanceof Error) throw count;
        return count;
      },
    },
    publishedProduct: { count: publishedCount },
  } as unknown as PrismaService;
  const config = {
    get: (key: string) => (key === 'AUTH_MODE' ? authMode : undefined),
  } as ConfigService;
  return { service: new EntitlementService(prisma, config), publishedCount };
}

describe('EntitlementService.assertFeature', () => {
  const { service: svc } = makeService(0);

  it('allows basic features on free plan', () => {
    expect(() => svc.assertFeature('free', 'ai.title')).not.toThrow();
  });

  it('blocks premium features on free plan with 403', () => {
    let error: ForbiddenException | undefined;
    try {
      svc.assertFeature('free', 'ai.detail');
    } catch (reason) {
      error = reason as ForbiddenException;
    }
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error?.getResponse()).toMatchObject({
      message: '当前内测账号未开放此能力，请申请内测扩容。',
    });
    expect(error?.getResponse()).not.toHaveProperty('requiredPlan');
  });

  it('allows premium features on the granting plan', () => {
    expect(() => svc.assertFeature('pro', 'ai.image.watermark')).not.toThrow();
  });
});

describe('EntitlementService.assertWithinQuota', () => {
  const { service: svc } = makeService(0);

  it('directs over-limit accounts to request beta expansion', () => {
    let response: unknown;
    try {
      svc.assertWithinQuota('free', 'shops.max', 2);
    } catch (reason) {
      response = (reason as { getResponse: () => unknown }).getResponse();
    }
    expect(response).toMatchObject({
      message: '已达当前内测权限上限（1），请申请内测扩容。',
    });
    expect(response).not.toHaveProperty('requiredPlan');
  });
});

describe('EntitlementService.checkAiQuota', () => {
  it('computes remaining from monthly usage', async () => {
    const { service: svc } = makeService(5);
    const q = await svc.checkAiQuota(1n, 'free');
    expect(q.limit).toBe(20);
    expect(q.used).toBe(5);
    expect(q.remaining).toBe(15);
    expect(q.exceeded).toBe(false);
  });

  it('flags exceeded at the limit', async () => {
    const { service: svc } = makeService(20);
    const q = await svc.checkAiQuota(1n, 'free');
    expect(q.exceeded).toBe(true);
  });

  it('fails closed when platform AI usage cannot be counted', async () => {
    const { service: svc } = makeService(new Error('db down'));

    await expect(svc.getMonthlyAiUsage(1n)).rejects.toThrow('db down');
    await expect(svc.checkAiQuota(1n, 'free')).rejects.toThrow('db down');
  });
});

describe('EntitlementService.buildView', () => {
  it('returns plan view with usage and billing availability', async () => {
    const { service: svc } = makeService(3);
    const view = await svc.buildView(1n, 'free', 'active');
    expect(view.accessStatus).toBe('active');
    expect(view.plan).toBe('free');
    expect(view.planName).toBe('内测版');
    expect(view.aiUsage.used).toBe(3);
    expect(view.aiUsage.remaining).toBe(17);
    expect(view.plans).toHaveLength(5);
    expect(view.plans[0]).toMatchObject({
      billingStatus: 'internal_beta',
      billingLabel: '邀请内测 · ¥0 / 内测期',
    });
    expect(view.plans[1]).toMatchObject({
      billingStatus: 'unavailable',
      billingLabel: '暂未开放',
    });
    expect(view.plans[0]).not.toHaveProperty('priceCnyMonthly');
    expect(view.features).toContain('ai.title');
    expect(view.features).not.toContain('ai.detail');
  });

  it('returns suspended access without exposing any subscription identifier', async () => {
    const { service: svc } = makeService(3, 'supabase');

    const view = await svc.buildView(1n, 'free', 'suspended');

    expect(view.accessStatus).toBe('suspended');
    expect(view.planName).toBe('权益已暂停');
    expect(view.features).toEqual([]);
    expect(view.quotas).toEqual({ shopsMax: 0, publishMonthly: 0 });
    expect(view.aiUsage).toEqual({ used: 3, limit: 0, remaining: 0, exceeded: true });
    expect(view.plans).toEqual([]);
    expect(view).not.toHaveProperty('entitlementSource');
    expect(view).not.toHaveProperty('entitlementRevision');
    expect(view).not.toHaveProperty('subscriptionId');
  });

  it('hides internal plan identifiers and plan catalog in Supabase mode', async () => {
    const { service: svc } = makeService(3, 'supabase');

    const view = await svc.buildView(1n, 'pro', 'active');

    expect(view.plan).toBeNull();
    expect(view.planName).toBe('邀请制内测');
    expect(view.plans).toEqual([]);
    expect(view.features).toContain('analytics.dashboard');
    expect(view.quotas.shopsMax).toBe(10);
  });
});

describe('EntitlementService.getMonthlyPublishCount', () => {
  it('excludes legacy demo products from production quota usage', async () => {
    const { service, publishedCount } = makeService(3, 'supabase');

    await expect(service.getMonthlyPublishCount(1n)).resolves.toBe(3);
    expect(publishedCount).toHaveBeenCalledWith({
      where: {
        task: { userId: 1n },
        publishedAt: { gte: expect.any(Date) },
        shop: { NOT: { platformShopId: { startsWith: 'demo-' } } },
      },
    });
  });

  it('fails closed when publish usage cannot be counted', async () => {
    const { service } = makeService(new Error('db down'));

    await expect(service.getMonthlyPublishCount(1n)).rejects.toThrow('db down');
  });
});
