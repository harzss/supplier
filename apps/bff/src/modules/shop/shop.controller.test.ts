import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { OAuthConfigService } from './oauth-config.service';
import type { DouyinReadinessService } from './douyin-readiness.service';
import { OAuthExchangeFailure, type OAuthFlowService } from './oauth-flow.service';
import { ShopController } from './shop.controller';
import type { ShopService } from './shop.service';
import type { AuditService } from '../observability/audit.service';
import type { Alibaba1688ReadinessService } from './alibaba1688-readiness.service';

describe('ShopController OAuth callback', () => {
  it('passes only the authorize return target into the OAuth flow', () => {
    const oauth = { authorize: vi.fn() } as unknown as OAuthFlowService;
    const controller = new ShopController(
      {} as ShopService,
      oauth,
      {} as OAuthConfigService,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      {} as AuditService,
    );

    controller.authorizeDouyin({ userId: 42n } as never, {
      returnTo: '/products?id=offer%2F1001#publish',
    });

    expect(oauth.authorize).toHaveBeenCalledWith(
      42n,
      'douyin',
      '/products?id=offer%2F1001#publish',
    );
  });

  it('redirects a successful callback with only an opaque one-time result token', async () => {
    const resultToken = 'r'.repeat(43);
    const oauth = {
      issueResult: vi.fn().mockResolvedValue(resultToken),
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
        returnTo: '/products?id=offer%2F1001#publish',
      }),
    };
    const oauthConfig = {
      buildResultRedirect: vi.fn((params: Record<string, string>, returnTo?: string) => {
        const url = new URL(returnTo ?? '/settings', 'https://supplier.example.com');
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url.toString();
      }),
    } as unknown as OAuthConfigService;
    const controller = new ShopController(
      {} as ShopService,
      oauth as unknown as OAuthFlowService,
      oauthConfig,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      { record: vi.fn() } as unknown as AuditService,
    );

    const query = {
      code: 'auth-code',
      state: 'a'.repeat(43),
      returnTo: 'https://evil.example.com',
    };
    const result = await controller.callbackDouyin(query);

    expect(new URL(result.url).pathname).toBe('/products');
    expect(new URL(result.url).searchParams.get('id')).toBe('offer/1001');
    expect(new URL(result.url).hash).toBe('#publish');
    expect(new URL(result.url).searchParams.get('oauthResult')).toBe(resultToken);
    expect(new URL(result.url).searchParams.has('oauth')).toBe(false);
    expect(new URL(result.url).searchParams.has('result')).toBe(false);
    expect(new URL(result.url).searchParams.has('shopId')).toBe(false);
    expect(new URL(result.url).searchParams.has('shopName')).toBe(false);
    expect(result.url).not.toContain('access-token');
    expect(result.url).not.toContain('refresh-token');
    expect(result.url).not.toContain('evil.example.com');
    expect(oauth.exchange).toHaveBeenCalledWith('douyin', 'auth-code', 'a'.repeat(43));
    expect(oauth.issueResult).toHaveBeenCalledWith(42n, {
      platform: 'douyin',
      result: 'success',
      shopId: '9',
      shopName: '测试店铺',
    });
    expect(oauthConfig.buildResultRedirect).toHaveBeenCalledWith(
      { oauthResult: resultToken },
      '/products?id=offer%2F1001#publish',
    );
  });

  it('uses only a generic fixed-page marker when state cannot identify a user', async () => {
    const oauth = {
      issueResult: vi.fn(),
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

    expect(new URL(result.url).pathname).toBe('/settings');
    expect(new URL(result.url).searchParams.get('oauth')).toBe('douyin');
    expect(result.url).toContain('result=error');
    expect(new URL(result.url).searchParams.has('message')).toBe(false);
    expect(new URL(result.url).searchParams.has('oauthResult')).toBe(false);
    expect(oauth.issueResult).not.toHaveBeenCalled();
    expect(oauthConfig.buildResultRedirect).toHaveBeenCalledWith({
      oauth: 'douyin',
      result: 'error',
    });
  });

  it('uses the state-bound return target after a consumed-state exchange failure', async () => {
    const resultToken = 'r'.repeat(43);
    const oauth = {
      issueResult: vi.fn().mockResolvedValue(resultToken),
      exchange: vi
        .fn()
        .mockRejectedValue(
          new OAuthExchangeFailure(
            '/products?id=offer%2F1001#publish',
            42n,
            'douyin',
            new BadRequestException('店铺授权保存失败'),
          ),
        ),
    } as unknown as OAuthFlowService;
    const oauthConfig = {
      buildResultRedirect: vi.fn((params: Record<string, string>, returnTo?: string) => {
        const url = new URL(returnTo ?? '/settings', 'https://supplier.example.com');
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url.toString();
      }),
    } as unknown as OAuthConfigService;
    const audit = { record: vi.fn() } as unknown as AuditService;
    const controller = new ShopController(
      {} as ShopService,
      oauth,
      oauthConfig,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      audit,
    );

    const result = await controller.callbackDouyin({ code: 'bad', state: 'a'.repeat(43) });

    expect(new URL(result.url).pathname).toBe('/products');
    expect(new URL(result.url).searchParams.get('oauthResult')).toBe(resultToken);
    expect(new URL(result.url).searchParams.has('message')).toBe(false);
    expect(oauth.issueResult).toHaveBeenCalledWith(42n, {
      platform: 'douyin',
      result: 'error',
      message: '店铺授权保存失败',
    });
    expect(oauthConfig.buildResultRedirect).toHaveBeenCalledWith(
      { oauthResult: resultToken },
      '/products?id=offer%2F1001#publish',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, metadata: { errorType: 'BadRequestException' } }),
    );
  });

  it('fails closed to the fixed page when the result token cannot be stored', async () => {
    const oauth = {
      issueResult: vi.fn().mockRejectedValue(new Error('redis down')),
      exchange: vi.fn().mockResolvedValue({
        userId: 42n,
        platform: 'douyin',
        shop: { id: '9', shopName: '测试店铺' },
        expiresAt: new Date('2026-07-14T12:00:00.000Z'),
        scope: [],
        returnTo: '/products?id=offer%2F1001#publish',
      }),
    } as unknown as OAuthFlowService;
    const oauthConfig = {
      buildResultRedirect: vi.fn((params: Record<string, string>, returnTo?: string) => {
        const url = new URL(returnTo ?? '/settings', 'https://supplier.example.com');
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url.toString();
      }),
    } as unknown as OAuthConfigService;
    const controller = new ShopController(
      {} as ShopService,
      oauth,
      oauthConfig,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.callbackDouyin({ code: 'auth-code', state: 'a'.repeat(43) });

    expect(new URL(result.url).pathname).toBe('/settings');
    expect(new URL(result.url).searchParams.get('result')).toBe('error');
    expect(new URL(result.url).searchParams.has('oauthResult')).toBe(false);
    expect(new URL(result.url).searchParams.has('shopId')).toBe(false);
  });

  it('consumes a result token for the authenticated user', async () => {
    const resultToken = 'r'.repeat(43);
    const verifiedResult = {
      platform: 'douyin' as const,
      result: 'success' as const,
      shopId: '9',
      shopName: '测试店铺',
    };
    const oauth = {
      consumeResult: vi.fn().mockResolvedValue(verifiedResult),
    } as unknown as OAuthFlowService;
    const controller = new ShopController(
      {} as ShopService,
      oauth,
      {} as OAuthConfigService,
      {} as DouyinReadinessService,
      {} as Alibaba1688ReadinessService,
      {} as AuditService,
    );

    await expect(
      controller.consumeOAuthResult({ userId: 42n } as never, { token: resultToken }),
    ).resolves.toEqual(verifiedResult);
    expect(oauth.consumeResult).toHaveBeenCalledWith(42n, resultToken);
  });

  it('uses an isolated callback route for 1688 buyer OAuth', async () => {
    const resultToken = 'r'.repeat(43);
    const oauth = {
      issueResult: vi.fn().mockResolvedValue(resultToken),
      exchange: vi.fn().mockResolvedValue({
        userId: 42n,
        platform: 'alibaba_1688',
        shop: { id: '12', shopName: 'buyer-login' },
        expiresAt: new Date('2026-07-14T12:00:00.000Z'),
        scope: [],
        returnTo: '/settings',
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
    expect(new URL(result.url).searchParams.get('oauthResult')).toBe(resultToken);
    expect(new URL(result.url).searchParams.has('oauth')).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/shops/oauth/alibaba_1688/callback' }),
    );
  });
});
