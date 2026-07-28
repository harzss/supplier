import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { OAuthConfigService } from './oauth-config.service';

function makeService(values: Record<string, string> = {}): OAuthConfigService {
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new OAuthConfigService(config);
}

const CALLBACK = 'https://supplier.example.com/api/shops/oauth/douyin/callback';
const ALIBABA_1688_CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';

describe('OAuthConfigService', () => {
  it('returns configured Douyin adapter settings', () => {
    const service = makeService({
      DOUYIN_APP_KEY: 'app-key',
      DOUYIN_APP_SECRET: 'app-secret',
      DOUYIN_SERVICE_ID: 'service-123',
      DOUYIN_OAUTH_REDIRECT_URI: CALLBACK,
      DOUYIN_OAUTH_SANDBOX: 'true',
      OAUTH_CALLBACK_ALLOWLIST: CALLBACK,
    });

    expect(service.getPlatformConfig('douyin')).toEqual({
      appKey: 'app-key',
      appSecret: 'app-secret',
      redirectUri: CALLBACK,
      serviceId: 'service-123',
      sandbox: true,
    });
  });

  it('rejects incomplete platform credentials', () => {
    const service = makeService({ OAUTH_CALLBACK_ALLOWLIST: CALLBACK });
    expect(() => service.getPlatformConfig('douyin')).toThrow('douyin OAuth is not configured');
  });

  it('returns configured 1688 buyer OAuth settings without a service id', () => {
    const service = makeService({
      ALIBABA_1688_APP_KEY: '1688-app-key',
      ALIBABA_1688_APP_SECRET: '1688-app-secret',
      ALIBABA_1688_OAUTH_REDIRECT_URI: ALIBABA_1688_CALLBACK,
      OAUTH_CALLBACK_ALLOWLIST: `${CALLBACK},${ALIBABA_1688_CALLBACK}`,
    });

    expect(service.getPlatformConfig('alibaba_1688')).toEqual({
      appKey: '1688-app-key',
      appSecret: '1688-app-secret',
      redirectUri: ALIBABA_1688_CALLBACK,
      sandbox: false,
    });
  });

  it('rejects callbacks outside the exact allowlist', () => {
    const service = makeService({ OAUTH_CALLBACK_ALLOWLIST: CALLBACK });
    expect(() => service.assertAllowedCallback('https://evil.example.com/callback')).toThrow(
      'OAuth callback URL is not allowed',
    );
  });

  it('requires HTTPS callbacks in production', () => {
    expect(() =>
      makeService({
        NODE_ENV: 'production',
        OAUTH_CALLBACK_ALLOWLIST: 'http://supplier.example.com/callback',
      }),
    ).toThrow('OAuth callback URL must use HTTPS in production');
  });

  it('uses a five-minute state TTL and rejects unsafe overrides', () => {
    expect(makeService().getStateTtlSeconds()).toBe(300);
    expect(() => makeService({ OAUTH_STATE_TTL_SECONDS: '30' }).getStateTtlSeconds()).toThrow(
      'OAUTH_STATE_TTL_SECONDS must be between 60 and 900',
    );
  });

  it('builds a safe settings-page redirect for OAuth results', () => {
    const service = makeService({
      OAUTH_RESULT_REDIRECT_URL: 'https://supplier.example.com/settings',
    });

    expect(
      service.buildResultRedirect({ oauth: 'douyin', result: 'success', shopName: '测试店铺' }),
    ).toBe(
      'https://supplier.example.com/settings?oauth=douyin&result=success&shopName=%E6%B5%8B%E8%AF%95%E5%BA%97%E9%93%BA',
    );
  });
});
