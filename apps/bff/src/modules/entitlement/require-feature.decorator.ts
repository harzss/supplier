import { SetMetadata } from '@nestjs/common';
import type { FeatureId } from '@supplier/entitlements';

export const REQUIRE_FEATURE = 'require_feature';

/** 声明某路由需要的功能权限，由 FeatureGuard 校验 */
export const RequireFeature = (feature: FeatureId) => SetMetadata(REQUIRE_FEATURE, feature);
