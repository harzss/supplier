import { Type } from 'class-transformer';
import { IsIn } from 'class-validator';
import type { AnalyticsRangeDays } from '@supplier/shared-types';

export class AnalyticsOverviewQueryDto {
  @Type(() => Number)
  @IsIn([7, 30, 90])
  days: AnalyticsRangeDays = 30;
}
