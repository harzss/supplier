import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { Alibaba1688ReadinessService } from './alibaba1688-readiness.service';
import { OAuthConfigService } from './oauth-config.service';

const USER_ID = 42n;
const CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';

function makeService(
  values: Record<string, string>,
  options: { buyer?: object; runtimeStateReady?: boolean } = {},
) {
  const config = { get: (key: string) => values[key] } as ConfigService;
  const prisma = {
    shop: { findFirst: vi.fn().mockResolvedValue(options.buyer ?? null) },
    order: { count: vi.fn().mockResolvedValue(0) },
    orderItem: { count: vi.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  return new Alibaba1688ReadinessService(config, new OAuthConfigService(config), prisma, {
    ping: options.runtimeStateReady
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('runtime state unavailable')),
  } as never);
}

describe('Alibaba1688ReadinessService', () => {
  it('reports real purchasing ready only after the explicit production switch is enabled', async () => {
    const service = makeService(
      {
        ALIBABA_1688_APP_KEY: 'app-key',
        ALIBABA_1688_APP_SECRET: 'app-secret',
        ALIBABA_1688_OAUTH_REDIRECT_URI: CALLBACK,
        ALIBABA_1688_PAYMENT_MODE: 'manual',
        ALIBABA_1688_PURCHASE_ENABLED: 'true',
        OAUTH_CALLBACK_ALLOWLIST: CALLBACK,
        OAUTH_RESULT_REDIRECT_URL: 'https://supplier.example.com/settings',
        ENCRYPTION_KEY: 'encryption-key',
      },
      {
        buyer: {
          id: 12n,
          shopName: 'buyer-login',
          status: 'active',
          accessTokenEnc: 'access-enc',
          refreshTokenEnc: 'refresh-enc',
          tokenExpireAt: new Date('2026-07-18T00:00:00.000Z'),
        },
        runtimeStateReady: true,
      },
    );

    const result = await service.get(USER_ID);

    expect(result.ready).toBe(true);
    expect(result.readyCount).toBe(8);
    expect(result.totalCount).toBe(8);
    expect(result.checks.find((check) => check.id === 'authorized_buyer')?.ready).toBe(true);
    expect(result.checks.find((check) => check.id === 'structured_address')?.ready).toBe(true);
    expect(result.checks.find((check) => check.id === 'sku_binding')?.ready).toBe(true);
    expect(result.checks.find((check) => check.id === 'purchase_enabled')?.ready).toBe(true);
    expect(result.checks.find((check) => check.id === 'multi_purchase_orders')?.ready).toBe(true);
  });

  it('returns actionable missing configuration without exposing secret values', async () => {
    const result = await makeService({}).get(USER_ID);
    const serialized = JSON.stringify(result);

    expect(result.readyCount).toBe(3);
    expect(result.checks.find((check) => check.id === 'app_credentials')?.detail).toContain(
      'ALIBABA_1688_APP_KEY',
    );
    expect(result.checks.find((check) => check.id === 'payment_strategy')?.detail).toContain(
      'ALIBABA_1688_PAYMENT_MODE=manual',
    );
    expect(serialized).not.toContain('app-secret');
    expect(serialized).not.toContain('encryption-key');
  });
});
