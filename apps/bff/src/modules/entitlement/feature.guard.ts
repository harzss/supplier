import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { canUseFeature, type FeatureId } from '@supplier/entitlements';
import { REQUIRE_FEATURE } from './require-feature.decorator';
import type { CurrentUser } from './user-context.service';
import { entitlementSuspended } from './entitlement-access.service';

/** 声明式功能门禁：读取 @RequireFeature 元数据，校验当前用户套餐是否有权 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<FeatureId | undefined>(REQUIRE_FEATURE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!feature) return true;

    const req = ctx.switchToHttp().getRequest<{ currentUser?: CurrentUser }>();
    const currentUser = req.currentUser;
    if (!currentUser) {
      throw new UnauthorizedException({
        code: 'CURRENT_USER_CONTEXT_MISSING',
        message: '当前用户上下文不可用，请重新登录',
      });
    }
    if (currentUser.accessStatus !== 'active') throw entitlementSuspended();
    if (!canUseFeature(currentUser.plan, feature)) {
      throw new ForbiddenException({
        code: 'FEATURE_LOCKED',
        feature,
        message: '当前内测账号未开放此能力，请申请内测扩容。',
      });
    }
    return true;
  }
}
