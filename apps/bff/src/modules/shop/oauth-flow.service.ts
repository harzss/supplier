import { Injectable } from '@nestjs/common';
import { Alibaba1688Adapter, DouyinAdapter, type PlatformAdapter } from '@supplier/platform-sdk';
import type { ShopView } from './shop.service';
import { OAuthConfigService, type OAuthPlatform } from './oauth-config.service';
import { OAuthStateService } from './oauth-state.service';
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
}

@Injectable()
export class OAuthFlowService {
  constructor(
    private readonly config: OAuthConfigService,
    private readonly state: OAuthStateService,
    private readonly shops: ShopService,
  ) {}

  async authorize(userId: bigint, platform: OAuthPlatform): Promise<OAuthAuthorizationResult> {
    const platformConfig = this.config.getPlatformConfig(platform);
    const state = await this.state.issue(userId, platform, platformConfig.redirectUri);
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
    const adapter = this.createAdapter(platform, platformConfig);
    const tokenSet = await adapter.exchangeToken(code);
    const userId = BigInt(payload.userId);
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
    };
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
