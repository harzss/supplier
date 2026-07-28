import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { OAuthConfigService } from './oauth-config.service';
import type { DouyinReadinessService } from './douyin-readiness.service';
import type { OAuthFlowService } from './oauth-flow.service';
import { ShopController } from './shop.controller';
import type { ShopService } from './shop.service';
import type { AuditService } from '../observability/audit.service';
import type { Alibaba1688ReadinessService } from './alibaba1688-readiness.service';

describe('ShopController OAuth callback', () => {
  it('redirects a successful callback to settings without exposing tokens', async () => {
    const oauth = {
      exchange: vi.fn().mockResolvedValue({
        userId: 42n,
        platform: 'douyin',
        shop: {
          id: '9',
          platform: 'douyin',
          platformLabel: '抖音小店',
          platformShopId: '4463798',
          shopName: '测试店铺',
          role: 'seller',
          connectionType: 'oauth',
          status: 'active',
          tokenExpiresAt: '2026-07-14T12:00:00.000Z',
          createdAt: '2026-07-16T00:00:00.000Z',
        },
        expiresAt: new Date('2026-07-14T12:00:00.000Z'),
        scope: [],
      }),
    };
    const oauthConfig = {
      buildResultRedirect: vi.fn(
        (params: Record<string, string>) =>
          `https://supplier.example.com/settings?${new URLSearchParams(params).toString()}`,
      ),
    } as unknown as OAuthConfigService;
    const controller = new ShopController(
      {} as ShopService,
      oauth as unknown as OAuthFlowService,
      oauthConfig,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.callbackDouyin({
      code: 'auth-code',
      state: 'a'.repeat(43),
    });

    expect(result.url).toContain('oauth=douyin');
    expect(result.url).toContain('result=success');
    expect(result.url).toContain('shopId=9');
    expect(result.url).not.toContain('access-token');
    expect(result.url).not.toContain('refresh-token');
  });

  it('redirects safe callback errors to settings', async () => {
    const oauth = {
      exchange: vi.fn().mockRejectedValue(new BadRequestException('OAuth state 已失效')),
    } as unknown as OAuthFlowService;
    const oauthConfig = {
      buildResultRedirect: vi.fn(
        (params: Record<string, string>) =>
          `https://supplier.example.com/settings?${new URLSearchParams(params).toString()}`,
      ),
    } as unknown as OAuthConfigService;
    const controller = new ShopController(
      {} as ShopService,
      oauth,
      oauthConfig,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.callbackDouyin({ code: 'bad', state: 'a'.repeat(43) });

    expect(result.url).toContain('result=error');
    expect(new URL(result.url).searchParams.get('message')).toBe('OAuth state 已失效');
  });

  it('uses an isolated callback route for 1688 buyer OAuth', async () => {
    const oauth = {
      exchange: vi.fn().mockResolvedValue({
        userId: 42n,
        platform: 'alibaba_1688',
        shop: { id: '12', shopName: 'buyer-login' },
        expiresAt: new Date('2026-07-14T12:00:00.000Z'),
        scope: [],
      }),
    };
    const oauthConfig = {
      buildResultRedirect: vi.fn(
        (params: Record<string, string>) =>
          `https://supplier.example.com/settings?${new URLSearchParams(params).toString()}`,
      ),
    } as unknown as OAuthConfigService;
    const audit = { record: vi.fn() } as unknown as AuditService;
    const controller = new ShopController(
      {} as ShopService,
      oauth as unknown as OAuthFlowService,
      oauthConfig,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      audit,
    );

    const result = await controller.callbackAlibaba1688({
      code: 'auth-code',
      state: 'a'.repeat(43),
    });

    expect(oauth.exchange).toHaveBeenCalledWith('alibaba_1688', 'auth-code', 'a'.repeat(43));
    expect(result.url).toContain('oauth=alibaba_1688');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/shops/oauth/alibaba_1688/callback' }),
    );
  });
});
