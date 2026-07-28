import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CurrentUserGuard } from './current-user.guard';
import { EntitlementController } from './entitlement.controller';
import { EntitlementService } from './entitlement.service';
import { FeatureGuard } from './feature.guard';
import { UserContextService } from './user-context.service';
import { AuthTokenService } from './auth-token.service';
import { AiUsageService } from './ai-usage.service';

/**
 * 权益模块（全局）：
 * - CurrentUserGuard 先解析身份挂到 request.currentUser
 * - FeatureGuard 再按 @RequireFeature 校验功能权限
 * 守卫按 provider 顺序执行，务必保持 CurrentUserGuard 在前。
 */
@Global()
@Module({
  controllers: [EntitlementController],
  providers: [
    AuthTokenService,
    UserContextService,
    EntitlementService,
    AiUsageService,
    { provide: APP_GUARD, useClass: CurrentUserGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
  ],
  exports: [AiUsageService, EntitlementService, UserContextService],
})
export class EntitlementModule {}
