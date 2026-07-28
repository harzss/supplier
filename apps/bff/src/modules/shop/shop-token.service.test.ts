import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto.module';
import type { PrismaService } from '../../common/prisma.module';
import { OAuthConfigService } from './oauth-config.service';
import { ShopTokenService } from './shop-token.service';
import type { AlertService } from '../observability/alert.service';

const CALLBACK = 'https://supplier.example.com/api/shops/oauth/douyin/callback';
const ALIBABA_1688_CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';

class FakeRedis {
  lockAvailable = true;
  private readonly values = new Map<string, string>();
  set = vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (key.startsWith('oauth:refresh:') && !this.lockAvailable) return null;
    if (args.includes('NX') && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  });
  get = vi.fn(async (key: string) => this.values.get(key) ?? null);
  del = vi.fn(async (key: string) => (this.values.delete(key) ? 1 : 0));
  eval = vi.fn(async (_script: string, _keys: number, key: string, value: string) => {
    if (this.values.get(key) !== value) return 0;
    this.values.delete(key);
    return 1;
  });
}

function makeConfig(): OAuthConfigService {
  const values: Record<string, string> = {
    DOUYIN_APP_KEY: 'app-key',
    DOUYIN_APP_SECRET: 'app-secret',
    DOUYIN_SERVICE_ID: 'service-123',
    DOUYIN_OAUTH_REDIRECT_URI: CALLBACK,
    ALIBABA_1688_APP_KEY: '1688-app-key',
    ALIBABA_1688_APP_SECRET: '1688-app-secret',
    ALIBABA_1688_OAUTH_REDIRECT_URI: ALIBABA_1688_CALLBACK,
    OAUTH_CALLBACK_ALLOWLIST: `${CALLBACK},${ALIBABA_1688_CALLBACK}`,
  };
  return new OAuthConfigService({ get: (key: string) => values[key] } as ConfigService);
}

function makeService(opts: {
  expiresInMs: number;
  lockAvailable?: boolean;
  platform?: 'douyin' | 'alibaba_1688';
  tokenPersistenceFailures?: number;
}) {
  const crypto = new CryptoService({ get: () => 'unit-test-key' } as unknown as ConfigService);
  const platform = opts.platform ?? 'douyin';
  const shop = {
    id: 9n,
    userId: 42n,
    platform,
    platformShopId: platform === 'douyin' ? '4463798' : 'member-1688',
    accessTokenEnc: crypto.encrypt('old-access-token') as string | null,
    refreshTokenEnc: crypto.encrypt('old-refresh-token') as string | null,
    tokenExpireAt: new Date(Date.now() + opts.expiresInMs),
    status: 'active' as 'active' | 'expired' | 'revoked',
  };
  const updates: Array<Record<string, unknown>> = [];
  let tokenPersistenceFailures = opts.tokenPersistenceFailures ?? 0;
  const prisma = {
    shop: {
      findFirst: vi.fn(async () => ({ ...shop })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (data.accessTokenEnc && tokenPersistenceFailures > 0) {
            tokenPersistenceFailures -= 1;
            throw new Error('db unavailable');
          }
          if (
            (where.status !== undefined && where.status !== shop.status) ||
            (where.accessTokenEnc !== undefined && where.accessTokenEnc !== shop.accessTokenEnc) ||
            (where.refreshTokenEnc !== undefined && where.refreshTokenEnc !== shop.refreshTokenEnc)
          ) {
            return { count: 0 };
          }
          updates.push(data);
          Object.assign(shop, data);
          return { count: 1 };
        },
      ),
    },
  } as unknown as PrismaService;
  const redis = new FakeRedis();
  redis.lockAvailable = opts.lockAvailable ?? true;
  const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
  return {
    service: new ShopTokenService(prisma, crypto, makeConfig(), redis as unknown as Redis, alerts),
    crypto,
    redis,
    updates,
    alerts,
    shop,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShopTokenService', () => {
  it('decrypts a token that is not close to expiry', async () => {
    const { service, redis } = makeService({ expiresInMs: 10 * 60 * 1000 });

    await expect(service.getAccessToken(9n, 42n)).resolves.toBe('old-access-token');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('refreshes a near-expiry token once and stores only ciphertext', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              err_no: 0,
              data: {
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                expires_in: 7200,
                shop_id: '4463798',
                shop_name: '测试店铺',
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const { service, crypto, redis, updates } = makeService({ expiresInMs: 2 * 60 * 1000 });

    await expect(service.getAccessToken(9n, 42n)).resolves.toBe('new-access-token');

    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'oauth:refresh:9',
      expect.any(String),
      'PX',
      60_000,
      'NX',
    );
    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      'oauth:refresh-result:9',
      expect.any(String),
      'PX',
      86_400_000,
    );
    const recoveryPayload = String(redis.set.mock.calls[1]?.[1]);
    expect(recoveryPayload).not.toContain('new-access-token');
    expect(recoveryPayload).not.toContain('new-refresh-token');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.accessTokenEnc).not.toBe('new-access-token');
    expect(updates[0]?.refreshTokenEnc).not.toBe('new-refresh-token');
    expect(crypto.decrypt(String(updates[0]?.accessTokenEnc))).toBe('new-access-token');
    expect(crypto.decrypt(String(updates[0]?.refreshTokenEnc))).toBe('new-refresh-token');
  });

  it('recovers a rotated token from encrypted Redis state after database persistence fails', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            err_no: 0,
            data: {
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              expires_in: 7200,
              shop_id: '4463798',
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const state = makeService({ expiresInMs: -1, tokenPersistenceFailures: 3 });

    await expect(state.service.getAccessToken(9n, 42n)).rejects.toThrow('店铺授权刷新结果待恢复');
    await expect(state.service.getAccessToken(9n, 42n)).resolves.toBe('new-access-token');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.shop.status).toBe('active');
    expect(state.updates).toHaveLength(1);
    expect(state.crypto.decrypt(String(state.shop.refreshTokenEnc))).toBe('new-refresh-token');
    expect(state.redis.del).toHaveBeenCalledWith('oauth:refresh-result:9');
  });

  it('uses the still-valid token when another request owns the refresh lock', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { service } = makeService({ expiresInMs: 2 * 60 * 1000, lockAvailable: false });

    await expect(service.getAccessToken(9n, 42n)).resolves.toBe('old-access-token');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('marks the shop expired when refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ err_no: 10001, message: 'invalid refresh token' }), {
            status: 200,
          }),
      ),
    );
    const { service, updates } = makeService({ expiresInMs: -1 });

    await expect(service.getAccessToken(9n, 42n)).rejects.toThrow('店铺授权已过期');
    expect(updates.at(-1)).toEqual({ status: 'expired' });
  });

  it('refreshes a 1688 buyer token with the platform-specific endpoint', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-1688-access-token',
            refresh_token: 'new-1688-refresh-token',
            expires_in: '36000',
            memberId: 'member-1688',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const { service, crypto, updates } = makeService({
      expiresInMs: -1,
      platform: 'alibaba_1688',
    });

    await expect(service.getAccessToken(9n, 42n)).resolves.toBe('new-1688-access-token');

    const [input] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe(
      '/openapi/param2/1/system.oauth2/getToken/1688-app-key',
    );
    expect(crypto.decrypt(String(updates[0]?.accessTokenEnc))).toBe('new-1688-access-token');
    expect(crypto.decrypt(String(updates[0]?.refreshTokenEnc))).toBe('new-1688-refresh-token');
  });

  it('does not reactivate a shop disconnected while token refresh is in flight', async () => {
    const state = makeService({ expiresInMs: -1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        state.shop.status = 'revoked';
        state.shop.accessTokenEnc = null;
        state.shop.refreshTokenEnc = null;
        return new Response(
          JSON.stringify({
            err_no: 0,
            data: {
              access_token: 'late-access-token',
              refresh_token: 'late-refresh-token',
              expires_in: 7200,
              shop_id: '4463798',
            },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(state.service.getAccessToken(9n, 42n)).rejects.toThrow('店铺授权已过期');
    expect(state.shop).toMatchObject({
      status: 'revoked',
      accessTokenEnc: null,
      refreshTokenEnc: null,
    });
    expect(state.updates).toHaveLength(0);
    expect(state.alerts.raise).not.toHaveBeenCalled();
  });
});
