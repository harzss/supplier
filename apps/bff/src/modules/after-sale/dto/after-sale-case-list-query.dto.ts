import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const AFTER_SALE_CASE_STATUSES = [
  'open',
  'handling',
  'waiting_external',
  'verifying',
  'closed',
] as const;

export type AfterSaleCaseStatusQuery = (typeof AFTER_SALE_CASE_STATUSES)[number];

export class AfterSaleCaseListQueryDto {
  @IsOptional()
  @IsIn(AFTER_SALE_CASE_STATUSES)
  status?: AfterSaleCaseStatusQuery;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  overdue?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

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
}
