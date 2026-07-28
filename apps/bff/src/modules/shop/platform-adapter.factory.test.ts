import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { DouyinAdapter, MockPlatformAdapter } from '@supplier/platform-sdk';
import type { OAuthConfigService } from './oauth-config.service';
import { PlatformAdapterFactory } from './platform-adapter.factory';

describe('PlatformAdapterFactory', () => {
  it('keeps demo shops on the mock adapter without requiring OAuth config', () => {
    const oauthConfig = { getPlatformConfig: vi.fn() } as unknown as OAuthConfigService;
    const factory = new PlatformAdapterFactory(oauthConfig, authConfig('demo'));

    const adapter = factory.create({ platform: 'douyin', platformShopId: 'demo-douyin-1' });

    expect(adapter).toBeInstanceOf(MockPlatformAdapter);
    expect(oauthConfig.getPlatformConfig).not.toHaveBeenCalled();
  });

  it('rejects legacy demo shops outside demo auth mode', () => {
    const oauthConfig = { getPlatformConfig: vi.fn() } as unknown as OAuthConfigService;
    const factory = new PlatformAdapterFactory(oauthConfig, authConfig('supabase'));

    expect(() => factory.create({ platform: 'douyin', platformShopId: 'demo-douyin-1' })).toThrow(
      '当前环境不允许执行演示店铺操作',
    );
    expect(oauthConfig.getPlatformConfig).not.toHaveBeenCalled();
  });

  it('uses the real Douyin adapter for OAuth shops', () => {
    const oauthConfig = {
      getPlatformConfig: vi.fn().mockReturnValue({
        appKey: 'app-key',
        appSecret: 'app-secret',
        redirectUri: 'https://supplier.example.com/callback',
        serviceId: 'service-id',
      }),
    } as unknown as OAuthConfigService;
    const factory = new PlatformAdapterFactory(oauthConfig, authConfig('supabase'));

    const adapter = factory.create({ platform: 'douyin', platformShopId: '4463798' });

    expect(adapter).toBeInstanceOf(DouyinAdapter);
    expect(oauthConfig.getPlatformConfig).toHaveBeenCalledWith('douyin');
  });
});

function authConfig(authMode: 'demo' | 'supabase'): ConfigService {
  return { get: (key: string) => (key === 'AUTH_MODE' ? authMode : undefined) } as ConfigService;
}
