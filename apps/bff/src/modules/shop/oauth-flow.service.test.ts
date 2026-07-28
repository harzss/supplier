import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthConfigService } from './oauth-config.service';
import { OAuthFlowService } from './oauth-flow.service';
import type { OAuthStateService } from './oauth-state.service';
import type { ShopService } from './shop.service';

const CALLBACK = 'https://supplier.example.com/api/shops/oauth/douyin/callback';
const ALIBABA_1688_CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';
const STATE = 'a'.repeat(43);

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
    consume: vi.fn().mockResolvedValue({
      userId: '42',
      platform: 'douyin',
      callbackUri: CALLBACK,
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

    const result = await service.authorize(42n, 'douyin');

    expect(state.issue).toHaveBeenCalledWith(42n, 'douyin', CALLBACK);
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
    expect(result).not.toHaveProperty('tokenSet');
  });

  it('stores 1688 OAuth credentials as a buyer account', async () => {
    const state = makeState();
    state.issue.mockResolvedValue(STATE);
    state.consume.mockResolvedValue({
      userId: '42',
      platform: 'alibaba_1688',
      callbackUri: ALIBABA_1688_CALLBACK,
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
    expect(state.issue).toHaveBeenCalledWith(42n, 'alibaba_1688', ALIBABA_1688_CALLBACK);
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
});
