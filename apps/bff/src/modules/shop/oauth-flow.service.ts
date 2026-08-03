import { Injectable } from '@nestjs/common';
import { Alibaba1688Adapter, DouyinAdapter, type PlatformAdapter } from '@supplier/platform-sdk';
import type { ShopView } from './shop.service';
import { OAuthConfigService, type OAuthPlatform } from './oauth-config.service';
import {
  OAuthStateService,
  type OAuthResultData,
  type OAuthResultPayload,
} from './oauth-state.service';
import { ShopService } from './shop.service';

export interface OAuthAuthorizationResult {
  platform: OAuthPlatform;
  authorizationUrl: string;
  expiresInSeconds: number;
}

export interface OAuthExchangeResult {
  userId: bigint;
  platform: OAuthPlatform;
  shop: ShopView;
  expiresAt: Date;
  scope: string[];
  returnTo: string;
}

export class OAuthExchangeFailure extends Error {
  constructor(
    readonly returnTo: string,
    readonly userId: bigint,
    readonly platform: OAuthPlatform,
    readonly originalError: unknown,
  ) {
    super('OAuth exchange failed');
    this.name = 'OAuthExchangeFailure';
  }
}

@Injectable()
export class OAuthFlowService {
  constructor(
    private readonly config: OAuthConfigService,
    private readonly state: OAuthStateService,
    private readonly shops: ShopService,
  ) {}

  async authorize(
    userId: bigint,
    platform: OAuthPlatform,
    returnTo?: string,
  ): Promise<OAuthAuthorizationResult> {
    const platformConfig = this.config.getPlatformConfig(platform);
    const state = await this.state.issue(userId, platform, platformConfig.redirectUri, returnTo);
    const adapter = this.createAdapter(platform, platformConfig);
    return {
      platform,
      authorizationUrl: adapter.buildAuthUrl(state),
      expiresInSeconds: this.config.getStateTtlSeconds(),
    };
  }

  async exchange(
    platform: OAuthPlatform,
    code: string,
    state: string,
  ): Promise<OAuthExchangeResult> {
    const platformConfig = this.config.getPlatformConfig(platform);
    const payload = await this.state.consume(state, platform, platformConfig.redirectUri);
    const userId = BigInt(payload.userId);
    try {
      const adapter = this.createAdapter(platform, platformConfig);
      const tokenSet = await adapter.exchangeToken(code);
      const shop = await this.shops.saveAuthorized(
        userId,
        platform,
        tokenSet,
        platform === 'alibaba_1688' ? 'buyer' : 'seller',
      );
      return {
        userId,
        platform,
        shop,
        expiresAt: tokenSet.expiresAt,
        scope: tokenSet.scope ?? [],
        returnTo: payload.returnTo,
      };
    } catch (error) {
      throw new OAuthExchangeFailure(payload.returnTo, userId, platform, error);
    }
  }

  issueResult(userId: bigint, result: OAuthResultData): Promise<string> {
    return this.state.issueResult(userId, result);
  }

  async consumeResult(userId: bigint, token: string): Promise<OAuthResultData> {
    const payload = await this.state.consumeResult(token, userId);
    return resultData(payload);
  }

  private createAdapter(
    platform: OAuthPlatform,
    config: ReturnType<OAuthConfigService['getPlatformConfig']>,
  ): PlatformAdapter {
    switch (platform) {
      case 'douyin':
        return new DouyinAdapter(config);
      case 'alibaba_1688':
        return new Alibaba1688Adapter(config);
    }
  }
}

function resultData(payload: OAuthResultPayload): OAuthResultData {
  return payload.result === 'success'
    ? {
        platform: payload.platform,
        result: 'success',
        shopId: payload.shopId,
        shopName: payload.shopName,
      }
    : {
        platform: payload.platform,
        result: 'error',
        message: payload.message,
      };
}
