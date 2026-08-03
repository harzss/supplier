import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { canUseFeature, type FeatureId } from '@supplier/entitlements';
import type { UserPlan } from '@supplier/shared-types';
import { REQUIRE_FEATURE } from './require-feature.decorator';
import type { CurrentUser } from './user-context.service';

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
    const plan: UserPlan = req.currentUser?.plan ?? 'free';
    if (!canUseFeature(plan, feature)) {
      throw new ForbiddenException({
        code: 'FEATURE_LOCKED',
        feature,
        message: '当前内测账号未开放此能力，请申请内测扩容。',
      });
    }
    return true;
  }
}
