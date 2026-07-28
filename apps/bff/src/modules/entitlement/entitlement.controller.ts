import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './current-user.decorator';
import { EntitlementService } from './entitlement.service';
import type { CurrentUser as CurrentUserType } from './user-context.service';

@ApiTags('me')
@Controller('me')
export class EntitlementController {
  constructor(private readonly entitlement: EntitlementService) {}

  /** 当前用户的套餐、功能权限与 AI 额度用量 */
  @Get('entitlements')
  getEntitlements(@CurrentUser() user: CurrentUserType) {
    return this.entitlement.buildView(user.userId, user.plan);
  }
}
