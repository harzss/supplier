import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { AuditAction } from '../observability/audit.decorator';
import {
  CollectedSourceProductQueryDto,
  CreateSourceImportPreviewDto,
  ExecuteSourceImportDto,
  RetrySourceImportDto,
  SourceImportListQueryDto,
} from './dto/source-import.dto';
import { SourceImportService } from './source-import.service';

@ApiTags('source-imports')
@Controller('source-imports')
export class SourceImportController {
  constructor(private readonly imports: SourceImportService) {}

  @Post('previews')
  @AuditAction('source_import.preview', 'source_import_task')
  preview(@CurrentUser() user: CurrentUserType, @Body() dto: CreateSourceImportPreviewDto) {
    return this.imports.createPreview(user, dto);
  }

  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query() query: SourceImportListQueryDto) {
    return this.imports.list(user, query);
  }

  @Get('by-client-request/:clientRequestId')
  byClientRequest(
    @CurrentUser() user: CurrentUserType,
    @Param('clientRequestId', new ParseUUIDPipe()) clientRequestId: string,
  ) {
    return this.imports.byClientRequest(user, clientRequestId);
  }

  @Get(':id')
  detail(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.imports.detail(user, id);
  }

  @Post(':id/execute')
  @HttpCode(202)
  @AuditAction('source_import.execute', 'source_import_task')
  execute(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: ExecuteSourceImportDto,
  ) {
    return this.imports.execute(user, id, dto);
  }

  @Post(':id/cancel')
  @AuditAction('source_import.cancel', 'source_import_task')
  cancel(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.imports.cancel(user, id);
  }

  @Post(':id/retry')
  @HttpCode(202)
  @AuditAction('source_import.retry', 'source_import_task')
  retry(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: RetrySourceImportDto,
  ) {
    return this.imports.retry(user, id, dto);
  }
}

@ApiTags('source-products')
@Controller('source-products')
export class CollectedSourceProductController {
  constructor(private readonly imports: SourceImportService) {}

  @Get('collected')
  collected(@CurrentUser() user: CurrentUserType, @Query() query: CollectedSourceProductQueryDto) {
    return this.imports.collected(user, query);
  }
}
