import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { DouyinReadinessService } from './douyin-readiness.service';
import { OAuthConfigService } from './oauth-config.service';

const USER_ID = 42n;
const CALLBACK = 'https://supplier.example.com/api/shops/oauth/douyin/callback';

function makeService(
  values: Record<string, string>,
  options: {
    shop?: object;
    confirmedMapping?: object;
    products?: object[];
    runtimeStateReady?: boolean;
  } = {},
) {
  const config = { get: (key: string) => values[key] } as ConfigService;
  const oauthConfig = new OAuthConfigService(config);
  const prisma = {
    shop: { findFirst: vi.fn().mockResolvedValue(options.shop ?? null) },
    productCategoryMapping: {
      findFirst: vi.fn().mockResolvedValue(options.confirmedMapping ?? null),
    },
    sourceProduct: { findMany: vi.fn().mockResolvedValue(options.products ?? []) },
  } as unknown as PrismaService;
  return new DouyinReadinessService(config, oauthConfig, prisma, {
    ping: options.runtimeStateReady
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('runtime state unavailable')),
  } as never);
}

describe('DouyinReadinessService', () => {
  it('reports ready only when config, OAuth shop and publish candidate are all present', async () => {
    const service = makeService(
      {
        DOUYIN_APP_KEY: 'app-key',
        DOUYIN_APP_SECRET: 'app-secret',
        DOUYIN_SERVICE_ID: 'service-id',
        DOUYIN_CUSTOMER_MOBILE: '4001234567',
        DOUYIN_ORDER_SYNC_ENABLED: 'true',
        DOUYIN_OAUTH_REDIRECT_URI: CALLBACK,
        OAUTH_CALLBACK_ALLOWLIST: CALLBACK,
        OAUTH_RESULT_REDIRECT_URL: 'https://supplier.example.com/settings',
        ENCRYPTION_KEY: 'encryption-key',
      },
      {
        shop: {
          id: 9n,
          shopName: '测试店铺',
          status: 'active',
          accessTokenEnc: 'access-enc',
          refreshTokenEnc: 'refresh-enc',
          tokenExpireAt: new Date('2026-07-16T20:00:00.000Z'),
        },
        confirmedMapping: {
          categoryId: '12345',
          categoryName: '女式T恤',
          sourceProduct: {
            productId1688: '1688-1',
            title: '测试商品',
          },
        },
        runtimeStateReady: true,
      },
    );

    const result = await service.get(USER_ID);

    expect(result.ready).toBe(true);
    expect(result.readyCount).toBe(6);
    expect(result.checks.every((check) => check.ready)).toBe(true);
  });

  it('returns actionable missing items without exposing secret values', async () => {
    const service = makeService({});

    const result = await service.get(USER_ID);
    const serialized = JSON.stringify(result);

    expect(result.ready).toBe(false);
    expect(result.readyCount).toBe(0);
    expect(result.checks.find((check) => check.id === 'app_credentials')?.detail).toContain(
      'DOUYIN_APP_KEY',
    );
    expect(serialized).not.toContain('app-secret');
    expect(serialized).not.toContain('encryption-key');
  });
});
