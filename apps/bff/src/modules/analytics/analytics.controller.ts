import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import { RequireFeature } from '../entitlement/require-feature.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { AnalyticsService } from './analytics.service';
import { AnalyticsOverviewQueryDto } from './dto/analytics-overview-query.dto';

@ApiTags('analytics')
@Controller('analytics')
@RequireFeature('analytics.dashboard')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@CurrentUser() user: CurrentUserType, @Query() query: AnalyticsOverviewQueryDto) {
    return this.analytics.overview(user.userId, query.days);
  }
}
