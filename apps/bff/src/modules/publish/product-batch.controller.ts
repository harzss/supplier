import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { AuditAction } from '../observability/audit.decorator';
import {
  CreateProductBatchPreviewDto,
  ExecuteProductBatchDto,
  ProductBatchCandidateQueryDto,
  ProductBatchTaskListQueryDto,
  RetryProductBatchDto,
} from './dto/product-batch.dto';
import { ProductBatchService } from './product-batch.service';

@ApiTags('product-batches')
@Controller('product-batches')
export class ProductBatchController {
  constructor(private readonly batches: ProductBatchService) {}

  @Get('candidates')
  candidates(@CurrentUser() user: CurrentUserType, @Query() query: ProductBatchCandidateQueryDto) {
    return this.batches.listCandidates(user, query);
  }

  @Post('previews')
  @AuditAction('product_batch.preview', 'product_batch_task')
  preview(@CurrentUser() user: CurrentUserType, @Body() dto: CreateProductBatchPreviewDto) {
    return this.batches.createPreview(user, dto);
  }

  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query() query: ProductBatchTaskListQueryDto) {
    return this.batches.listTasks(user, query);
  }

  @Get(':id')
  detail(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.batches.detail(user, id);
  }

  @Post(':id/execute')
  @HttpCode(202)
  @AuditAction('product_batch.execute', 'product_batch_task')
  execute(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: ExecuteProductBatchDto,
  ) {
    return this.batches.execute(user, id, dto);
  }

  @Post(':id/cancel')
  @AuditAction('product_batch.cancel', 'product_batch_task')
  cancel(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.batches.cancel(user, id);
  }

  @Post(':id/retry')
  @HttpCode(202)
  @AuditAction('product_batch.retry', 'product_batch_task')
  retry(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: RetryProductBatchDto,
  ) {
    return this.batches.retry(user, id, dto);
  }

  @Post(':id/items/:itemId/verify-title')
  @AuditAction('product_batch.verify_title', 'product_batch_item')
  verifyTitle(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.batches.verifyTitleResult(user, id, itemId);
  }

  @Post(':id/items/:itemId/verify-online')
  @AuditAction('product_batch.verify_online', 'product_batch_item')
  verifyOnline(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.batches.verifyOnlineResult(user, id, itemId);
  }
}
