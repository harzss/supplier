import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const EXCEPTION_CASE_DOMAINS = [
  'publish',
  'order',
  'purchase',
  'logistics',
  'after_sale',
  'entitlement',
] as const;

export const EXCEPTION_CASE_PRIORITIES = ['critical', 'high', 'medium'] as const;
export const EXCEPTION_CASE_STATUSES = ['open', 'acknowledged', 'resolved'] as const;

export type ExceptionCaseDomain = (typeof EXCEPTION_CASE_DOMAINS)[number];
export type ExceptionCasePriority = (typeof EXCEPTION_CASE_PRIORITIES)[number];
export type ExceptionCaseStatus = (typeof EXCEPTION_CASE_STATUSES)[number];

export class ExceptionCaseListQueryDto {
  @IsOptional()
  @IsIn(EXCEPTION_CASE_STATUSES)
  status?: ExceptionCaseStatus;

  @IsOptional()
  @IsIn(EXCEPTION_CASE_DOMAINS)
  domain?: ExceptionCaseDomain;

  @IsOptional()
  @IsIn(EXCEPTION_CASE_PRIORITIES)
  priority?: ExceptionCasePriority;

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
