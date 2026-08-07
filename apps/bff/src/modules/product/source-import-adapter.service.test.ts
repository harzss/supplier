import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { OAuthConfigService } from '../shop/oauth-config.service';
import type { ShopTokenService } from '../shop/shop-token.service';
import {
  SourceImportAdapterFactory,
  SourceImportRateLimiter,
} from './source-import-adapter.service';

describe('SourceImportAdapterFactory', () => {
  it('uses an isolated mock adapter in demo mode without accepting a real buyer', async () => {
    const fixture = createFactory({ AUTH_MODE: 'demo' });

    await expect(fixture.factory.resolveBuyerShop(1n)).resolves.toBeNull();
    await expect(fixture.factory.resolveBuyerShop(1n, '2')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const context = await fixture.factory.create(1n, null);

    expect(context.demo).toBe(true);
    expect(fixture.prisma.shop.findFirst).not.toHaveBeenCalled();
    expect(fixture.shopTokens.getAccessToken).not.toHaveBeenCalled();
  });

  it('resolves only an active 1688 buyer owned by the current tenant', async () => {
    const fixture = createFactory({
      AUTH_MODE: 'supabase',
      ALIBABA_1688_SOURCE_DATA_SCOPE: 'global_offer',
    });
    fixture.prisma.shop.findFirst.mockResolvedValue({ id: 21n });

    await expect(fixture.factory.resolveBuyerShop(7n, '21')).resolves.toBe(21n);
    expect(fixture.prisma.shop.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 21n,
          userId: 7n,
          platform: 'alibaba_1688',
          role: 'buyer',
          status: 'active',
        }),
      }),
    );
  });

  it('fails safely for malformed, foreign, or inactive buyer IDs', async () => {
    const fixture = createFactory({
      AUTH_MODE: 'supabase',
      ALIBABA_1688_SOURCE_DATA_SCOPE: 'global_offer',
    });

    await expect(fixture.factory.resolveBuyerShop(1n, 'not-an-id')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fixture.prisma.shop.findFirst).not.toHaveBeenCalled();

    fixture.prisma.shop.findFirst.mockResolvedValue(null);
    await expect(fixture.factory.resolveBuyerShop(1n, '2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(fixture.factory.create(1n, 2n)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('keeps real collection closed until global-offer invariance is explicitly verified', async () => {
    const fixture = createFactory({ AUTH_MODE: 'supabase' });

    await expect(fixture.factory.resolveBuyerShop(1n)).rejects.toThrow(
      'ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer',
    );
    await expect(fixture.factory.create(1n, 2n)).rejects.toThrow(
      'ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer',
    );
    expect(fixture.prisma.shop.findFirst).not.toHaveBeenCalled();
  });

  it('creates a real adapter only after rechecking tenant ownership and token state', async () => {
    const fixture = createFactory({
      AUTH_MODE: 'supabase',
      ALIBABA_1688_SOURCE_DATA_SCOPE: 'global_offer',
    });
    fixture.prisma.shop.findFirst.mockResolvedValue({ id: 21n });
    fixture.shopTokens.getAccessToken.mockResolvedValue('access-token');

    await expect(fixture.factory.create(7n, 21n)).resolves.toMatchObject({ demo: false });
    expect(fixture.prisma.shop.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 21n, userId: 7n }) }),
    );
    expect(fixture.shopTokens.getAccessToken).toHaveBeenCalledWith(21n, 7n);
  });
});

describe('SourceImportRateLimiter', () => {
  it('bypasses shared runtime state only for the demo adapter', async () => {
    const runtimeState = { takeFixedWindow: vi.fn() };
    const limiter = new SourceImportRateLimiter(runtimeState as never);

    await expect(limiter.take(true)).resolves.toBeUndefined();
    expect(runtimeState.takeFixedWindow).not.toHaveBeenCalled();
  });

  it.each([-2, -1, Number.NaN])(
    'fails closed for an invalid fixed-window retry delay %s',
    async (retryAfterMs) => {
      const limiter = new SourceImportRateLimiter({
        takeFixedWindow: vi.fn().mockResolvedValue({ allowed: false, retryAfterMs }),
      } as never);

      await expect(limiter.take(false)).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );

  it('fails closed when the shared runtime limiter is unavailable', async () => {
    const limiter = new SourceImportRateLimiter({
      takeFixedWindow: vi.fn().mockRejectedValue(new Error('runtime state unavailable')),
    } as never);

    await expect(limiter.take(false)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

function createFactory(values: Record<string, string>) {
  const prisma = { shop: { findFirst: vi.fn() } };
  const shopTokens = { getAccessToken: vi.fn() };
  const oauthConfig = {
    getPlatformConfig: vi.fn().mockReturnValue({ appKey: 'key', appSecret: 'secret' }),
  };
  const factory = new SourceImportAdapterFactory(
    { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    oauthConfig as unknown as OAuthConfigService,
    shopTokens as unknown as ShopTokenService,
  );
  return { factory, prisma, shopTokens };
}
