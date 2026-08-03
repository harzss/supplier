import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsPositiveInt64String } from './create-publish-task.dto';

export const PRODUCT_BATCH_ACTIONS = ['offline'] as const;
export type SupportedProductBatchAction = (typeof PRODUCT_BATCH_ACTIONS)[number];
export const PRODUCT_BATCH_MAX_ITEMS = 100;

export class CreateProductBatchPreviewDto {
  @IsUUID()
  clientRequestId!: string;

  @IsIn(PRODUCT_BATCH_ACTIONS)
  action!: SupportedProductBatchAction;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRODUCT_BATCH_MAX_ITEMS)
  @ArrayUnique()
  @IsString({ each: true })
  @IsPositiveInt64String({ each: true })
  publishedProductIds!: string[];
}

export class ExecuteProductBatchDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  previewRevision!: number;
}

export class RetryProductBatchDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRODUCT_BATCH_MAX_ITEMS)
  @ArrayUnique()
  @IsString({ each: true })
  @IsPositiveInt64String({ each: true })
  itemIds?: string[];
}

export const PUBLISHED_PRODUCT_FILTER_STATUSES = [
  'online',
  'offline',
  'draft',
  'rejected',
] as const;

export type PublishedProductFilterStatus = (typeof PUBLISHED_PRODUCT_FILTER_STATUSES)[number];

export class ProductBatchCandidateQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PRODUCT_BATCH_MAX_ITEMS)
  pageSize: number = 50;

  @IsOptional()
  @IsIn(PUBLISHED_PRODUCT_FILTER_STATUSES)
  status?: PublishedProductFilterStatus;

  @IsOptional()
  @IsString()
  @IsPositiveInt64String()
  shopId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ProductBatchTaskListQueryDto {
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
  pageSize: number = 20;
}
