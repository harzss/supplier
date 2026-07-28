import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublishService } from './publish.service';
import { CreatePublishTaskDto, PricingPreviewDto } from './dto/create-publish-task.dto';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { PublishQueueService } from './publish-queue.service';
import { PublishTaskListQueryDto } from './dto/publish-task-list-query.dto';

@ApiTags('publish')
@Controller('publish-tasks')
export class PublishController {
  constructor(
    private readonly publishService: PublishService,
    private readonly queue: PublishQueueService,
  ) {}

  @Post()
  async create(@CurrentUser() user: CurrentUserType, @Body() dto: CreatePublishTaskDto) {
    if (!this.queue.isEnabled()) return this.publishService.create(user, dto);
    return this.publishService.enqueue(user, dto);
  }

  @Post('pricing-preview')
  pricingPreview(@CurrentUser() user: CurrentUserType, @Body() dto: PricingPreviewDto) {
    return this.publishService.previewPricing(user, dto);
  }

  @Post(':id/retry')
  retry(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.queue.manualRetry(user.userId, id);
  }

  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query() query: PublishTaskListQueryDto) {
    return this.publishService.list(user, query.page, query.pageSize);
  }

  @Get(':id')
  detail(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.publishService.detail(user, id);
  }
}
