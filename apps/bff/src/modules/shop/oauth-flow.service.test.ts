import type { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthConfigService } from './oauth-config.service';
import { OAuthExchangeFailure, OAuthFlowService } from './oauth-flow.service';
import type { OAuthStateService } from './oauth-state.service';
import type { ShopService } from './shop.service';

const CALLBACK = 'https://supplier.example.com/api/shops/oauth/douyin/callback';
const ALIBABA_1688_CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';
const STATE = 'a'.repeat(43);
const RESULT_TOKEN = 'r'.repeat(43);
const RETURN_TO = '/products?id=offer%2F1001#publish';

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
    OAUTH_STATE_TTL_SECONDS: '300',
  };
  return new OAuthConfigService({ get: (key: string) => values[key] } as ConfigService);
}

function makeState() {
  return {
    issue: vi.fn().mockResolvedValue(STATE),
    issueResult: vi.fn().mockResolvedValue(RESULT_TOKEN),
    consumeResult: vi.fn().mockResolvedValue({
      userId: '42',
      platform: 'douyin',
      result: 'success',
      shopId: '9',
      shopName: '测试店铺',
      expiresAt: Date.now() + 300_000,
    }),
    consume: vi.fn().mockResolvedValue({
      userId: '42',
      platform: 'douyin',
      callbackUri: CALLBACK,
      returnTo: RETURN_TO,
      expiresAt: Date.now() + 300_000,
    }),
  };
}

function makeShops() {
  return {
    saveAuthorized: vi.fn().mockResolvedValue({
      id: '9',
      platform: 'douyin',
      platformLabel: '抖音小店',
      platformShopId: '4463798',
      shopName: '测试店铺',
      status: 'active',
      createdAt: '2026-07-16T00:00:00.000Z',
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OAuthFlowService', () => {
  it('issues state before building the Douyin authorization URL', async () => {
    const state = makeState();
    const service = new OAuthFlowService(
      makeConfig(),
      state as unknown as OAuthStateService,
      makeShops() as unknown as ShopService,
    );

    const result = await service.authorize(42n, 'douyin', RETURN_TO);

    expect(state.issue).toHaveBeenCalledWith(42n, 'douyin', CALLBACK, RETURN_TO);
    expect(result).toEqual({
      platform: 'douyin',
      authorizationUrl: `https://fuwu.jinritemai.com/authorize?service_id=service-123&state=${STATE}`,
      expiresInSeconds: 300,
    });
  });

  it('consumes state before exchanging the authorization code', async () => {
    const state = makeState();
    const shops = makeShops();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              err_no: 0,
              data: {
                access_token: 'access-token',
                refresh_token: 'refresh-token',
                expires_in: 3600,
                shop_id: '4463798',
                shop_name: '测试店铺',
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const service = new OAuthFlowService(
      makeConfig(),
      state as unknown as OAuthStateService,
      shops as unknown as ShopService,
    );

    const result = await service.exchange('douyin', 'auth-code', STATE);

    expect(state.consume).toHaveBeenCalledWith(STATE, 'douyin', CALLBACK);
    expect(result.userId).toBe(42n);
    expect(shops.saveAuthorized).toHaveBeenCalledWith(
      42n,
      'douyin',
      expect.objectContaining({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        platformShopId: '4463798',
      }),
      'seller',
    );
    expect(result.shop.id).toBe('9');
    expect(result.returnTo).toBe(RETURN_TO);
    expect(result).not.toHaveProperty('tokenSet');
  });

  it('stores 1688 OAuth credentials as a buyer account', async () => {
    const state = makeState();
    state.issue.mockResolvedValue(STATE);
    state.consume.mockResolvedValue({
      userId: '42',
      platform: 'alibaba_1688',
      callbackUri: ALIBABA_1688_CALLBACK,
      returnTo: '/settings',
      expiresAt: Date.now() + 300_000,
    });
    const shops = makeShops();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: '1688-access-token',
              refresh_token: '1688-refresh-token',
              expires_in: '36000',
              memberId: 'member-1688',
              resource_owner: 'buyer-login',
            }),
            { status: 200 },
          ),
      ),
    );
    const service = new OAuthFlowService(
      makeConfig(),
      state as unknown as OAuthStateService,
      shops as unknown as ShopService,
    );

    const authorization = await service.authorize(42n, 'alibaba_1688');
    const result = await service.exchange('alibaba_1688', 'auth-code', STATE);

    expect(authorization.authorizationUrl).toContain('https://auth.1688.com/oauth/authorize?');
    expect(authorization.authorizationUrl).toContain('site=1688');
    expect(state.issue).toHaveBeenCalledWith(42n, 'alibaba_1688', ALIBABA_1688_CALLBACK, undefined);
    expect(state.consume).toHaveBeenCalledWith(STATE, 'alibaba_1688', ALIBABA_1688_CALLBACK);
    expect(shops.saveAuthorized).toHaveBeenCalledWith(
      42n,
      'alibaba_1688',
      expect.objectContaining({
        accessToken: '1688-access-token',
        refreshToken: '1688-refresh-token',
        platformShopId: 'member-1688',
      }),
      'buyer',
    );
    expect(result.platform).toBe('alibaba_1688');
  });

  it('keeps a consumed safe return target when token persistence fails', async () => {
    const state = makeState();
    const persistenceError = new BadRequestException('店铺授权保存失败');
    const shops = makeShops();
    shops.saveAuthorized.mockRejectedValue(persistenceError);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              err_no: 0,
              data: {
                access_token: 'access-token',
                refresh_token: 'refresh-token',
                expires_in: 3600,
                shop_id: '4463798',
                shop_name: '测试店铺',
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const service = new OAuthFlowService(
      makeConfig(),
      state as unknown as OAuthStateService,
      shops as unknown as ShopService,
    );

    const failure = await service.exchange('douyin', 'auth-code', STATE).catch((error) => error);

    expect(failure).toBeInstanceOf(OAuthExchangeFailure);
    expect(failure).toMatchObject({
      returnTo: RETURN_TO,
      userId: 42n,
      platform: 'douyin',
      originalError: persistenceError,
    });
  });

  it('keeps a consumed safe return target when token exchange fails', async () => {
    const state = makeState();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('platform unavailable')));
    const service = new OAuthFlowService(
      makeConfig(),
      state as unknown as OAuthStateService,
      makeShops() as unknown as ShopService,
    );

    const failure = await service.exchange('douyin', 'auth-code', STATE).catch((error) => error);

    expect(failure).toBeInstanceOf(OAuthExchangeFailure);
    expect(failure).toMatchObject({
      returnTo: RETURN_TO,
      userId: 42n,
      platform: 'douyin',
      originalError: expect.objectContaining({ message: 'Douyin token exchange request failed' }),
    });
  });

  it('does not attach a return target when state consumption fails', async () => {
    const state = makeState();
    const stateError = new BadRequestException('OAuth state is invalid or expired');
    state.consume.mockRejectedValue(stateError);
    const service = new OAuthFlowService(
      makeConfig(),
      state as unknown as OAuthStateService,
      makeShops() as unknown as ShopService,
    );

    await expect(service.exchange('douyin', 'auth-code', STATE)).rejects.toBe(stateError);
  });

  it('issues and consumes a user-bound one-time OAuth result through the state service', async () => {
    const state = makeState();
    const service = new OAuthFlowService(
      makeConfig(),
      state as unknown as OAuthStateService,
      makeShops() as unknown as ShopService,
    );
    const result = {
      platform: 'douyin' as const,
      result: 'success' as const,
      shopId: '9',
      shopName: '测试店铺',
    };

    await expect(service.issueResult(42n, result)).resolves.toBe(RESULT_TOKEN);
    await expect(service.consumeResult(42n, RESULT_TOKEN)).resolves.toEqual(result);
    expect(state.issueResult).toHaveBeenCalledWith(42n, result);
    expect(state.consumeResult).toHaveBeenCalledWith(RESULT_TOKEN, 42n);
  });
});
