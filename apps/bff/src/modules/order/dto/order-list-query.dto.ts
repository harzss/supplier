import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, MaxLength, Min } from 'class-validator';

const ORDER_STATUSES = ['paid', 'purchasing', 'shipped', 'received', 'refunded', 'closed'] as const;

export type OrderListStatus = (typeof ORDER_STATUSES)[number];

export class OrderListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 30;

  @IsOptional()
  @Matches(/^[1-9]\d*$/)
  @MaxLength(19)
  shopId?: string;

  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderListStatus;
}
