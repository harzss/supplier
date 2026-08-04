import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsDefined,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsPositiveInt64String } from './create-publish-task.dto';

export const PRODUCT_BATCH_ACTIONS = [
  'online',
  'offline',
  'edit_title',
  'edit_price',
  'sync_inventory',
  'cleanup',
] as const;
export type SupportedProductBatchAction = (typeof PRODUCT_BATCH_ACTIONS)[number];
export const PRODUCT_BATCH_MAX_ITEMS = 100;

export const PRODUCT_BATCH_PRICE_RULE_MODES = ['percentage', 'targets'] as const;
export const PRODUCT_BATCH_PRICE_DIRECTIONS = ['increase', 'decrease'] as const;

export class ProductBatchTitleTargetDto {
  @IsString()
  @IsPositiveInt64String()
  publishedProductId!: string;

  @IsInt()
  @Min(1)
  expectedMutationRevision!: number;

  @IsString()
  @MaxLength(60)
  @Matches(/\S/)
  targetTitle!: string;
}

export class ProductBatchPriceTargetDto {
  @IsString()
  @IsPositiveInt64String()
  publishedProductId!: string;

  @IsString()
  @MaxLength(16)
  @Matches(/^\d{1,7}(?:\.\d{1,2})?$/)
  targetStartPrice!: string;
}

export class ProductBatchPriceRuleDto {
  @IsIn(PRODUCT_BATCH_PRICE_RULE_MODES)
  mode!: (typeof PRODUCT_BATCH_PRICE_RULE_MODES)[number];

  @ValidateIf((value: ProductBatchPriceRuleDto) => value.mode === 'percentage')
  @IsDefined()
  @IsIn(PRODUCT_BATCH_PRICE_DIRECTIONS)
  direction?: (typeof PRODUCT_BATCH_PRICE_DIRECTIONS)[number];

  @ValidateIf((value: ProductBatchPriceRuleDto) => value.mode === 'percentage')
  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  basisPoints?: number;

  @ValidateIf((value: ProductBatchPriceRuleDto) => value.mode === 'targets')
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRODUCT_BATCH_MAX_ITEMS)
  @ArrayUnique((target: ProductBatchPriceTargetDto) => target.publishedProductId)
  @ValidateNested({ each: true })
  @Type(() => ProductBatchPriceTargetDto)
  targets?: ProductBatchPriceTargetDto[];
}

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

  @ValidateIf((value: CreateProductBatchPreviewDto) => value.action === 'edit_title')
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRODUCT_BATCH_MAX_ITEMS)
  @ArrayUnique((target: ProductBatchTitleTargetDto) => target.publishedProductId)
  @ValidateNested({ each: true })
  @Type(() => ProductBatchTitleTargetDto)
  titleTargets?: ProductBatchTitleTargetDto[];

  @ValidateIf((value: CreateProductBatchPreviewDto) => value.action === 'edit_price')
  @IsDefined()
  @ValidateNested()
  @Type(() => ProductBatchPriceRuleDto)
  priceRule?: ProductBatchPriceRuleDto;
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
