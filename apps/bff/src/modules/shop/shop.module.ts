import { Module } from '@nestjs/common';
import { OAuthConfigService } from './oauth-config.service';
import { OAuthFlowService } from './oauth-flow.service';
import { OAuthStateService } from './oauth-state.service';
import { ShopController } from './shop.controller';
import { ShopService } from './shop.service';
import { ShopTokenService } from './shop-token.service';
import { PlatformAdapterFactory } from './platform-adapter.factory';
import { DouyinReadinessService } from './douyin-readiness.service';
import { Alibaba1688ReadinessService } from './alibaba1688-readiness.service';

@Module({
  controllers: [ShopController],
  providers: [
    ShopService,
    ShopTokenService,
    OAuthConfigService,
    OAuthStateService,
    OAuthFlowService,
    PlatformAdapterFactory,
    DouyinReadinessService,
    Alibaba1688ReadinessService,
  ],
  exports: [
    ShopService,
    ShopTokenService,
    OAuthConfigService,
    OAuthStateService,
    OAuthFlowService,
    PlatformAdapterFactory,
  ],
})
export class ShopModule {}
