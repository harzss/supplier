import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';

@ApiTags('audit')
@Controller('audit-events')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** 仅返回当前租户自己的审计记录；系统级告警通过 operations 端点读取。 */
  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query() query: AuditQueryDto) {
    return this.audit.list(user.userId, query);
  }
}
