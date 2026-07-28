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
    expect(() => svc.assertFeature('free', 'ai.detail')).toThrow(ForbiddenException);
  });

  it('allows premium features on the granting plan', () => {
    expect(() => svc.assertFeature('pro', 'ai.image.watermark')).not.toThrow();
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
  it('returns plan view with usage and upgrade options', async () => {
    const { service: svc } = makeService(3);
    const view = await svc.buildView(1n, 'free');
    expect(view.plan).toBe('free');
    expect(view.planName).toBe('免费版');
    expect(view.aiUsage.used).toBe(3);
    expect(view.aiUsage.remaining).toBe(17);
    expect(view.plans).toHaveLength(5);
    expect(view.features).toContain('ai.title');
    expect(view.features).not.toContain('ai.detail');
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
