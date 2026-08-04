import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { AuditAction } from '../observability/audit.decorator';
import { AcknowledgeExceptionCaseDto } from './dto/acknowledge-exception-case.dto';
import { ExceptionCaseListQueryDto } from './dto/exception-case-list-query.dto';
import { ExceptionCenterService } from './exception-center.service';

@ApiTags('exception-center')
@Controller('exception-cases')
export class ExceptionCenterController {
  constructor(private readonly exceptions: ExceptionCenterService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query() query: ExceptionCaseListQueryDto) {
    return this.exceptions.list(user.userId, query);
  }

  @Post('refresh')
  @HttpCode(200)
  @AuditAction('exception_center.refresh', 'exception_case')
  refresh(@CurrentUser() user: CurrentUserType) {
    return this.exceptions.refresh(user.userId);
  }

  @Get(':id')
  detail(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.exceptions.detail(user.userId, id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @AuditAction('exception_center.acknowledge', 'exception_case')
  acknowledge(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: AcknowledgeExceptionCaseDto,
  ) {
    return this.exceptions.acknowledge(user.userId, id, dto);
  }
}
