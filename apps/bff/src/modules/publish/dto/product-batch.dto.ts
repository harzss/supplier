import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsDefined,
  IsArray,
  IsBoolean,
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
import { productSkuPropertyIdentity } from '../product-sku-state';
import { IsPositiveInt64String } from './create-publish-task.dto';

export const PRODUCT_BATCH_ACTIONS = [
  'online',
  'offline',
  'edit_title',
  'edit_price',
  'edit_sku',
  'sync_inventory',
  'change_source',
  'cleanup',
] as const;
export type SupportedProductBatchAction = (typeof PRODUCT_BATCH_ACTIONS)[number];
export const PRODUCT_BATCH_MAX_ITEMS = 100;

export const PRODUCT_BATCH_PRICE_RULE_MODES = ['percentage', 'targets'] as const;
export const PRODUCT_BATCH_PRICE_DIRECTIONS = ['increase', 'decrease'] as const;
const PRODUCT_SKU_FINGERPRINT = /^[a-f0-9]{64}$/;
const PRODUCT_SKU_IDENTIFIER = /^[^\u0000-\u001f\u007f]+$/;
const PRODUCT_SKU_PICTURE_URL = /^https:\/\/[^\s]+$/i;

export class ProductBatchSkuPropertyDto {
  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  propertyId!: string;

  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  propertyName!: string;

  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  valueId!: string;

  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  valueName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  remark?: string;
}

export class ProductBatchSkuDimensionValueDto {
  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  valueId!: string;

  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  valueName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  remark?: string;
}

export class ProductBatchSkuDimensionDto {
  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  propertyId!: string;

  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  propertyName!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((value: ProductBatchSkuDimensionValueDto) =>
    JSON.stringify([value.valueId, value.valueName, value.remark ?? null]),
  )
  @ValidateNested({ each: true })
  @Type(() => ProductBatchSkuDimensionValueDto)
  values!: ProductBatchSkuDimensionValueDto[];
}

export class ProductBatchSkuRowDto {
  @IsString()
  @MaxLength(128)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  rowId!: string;

  @IsBoolean()
  isNew!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  platformSkuId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  platformSkuKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(PRODUCT_SKU_IDENTIFIER)
  sourceSpecId?: string;

  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique((property: ProductBatchSkuPropertyDto) =>
    productSkuPropertyIdentity(property.propertyId, property.propertyName),
  )
  @ValidateNested({ each: true })
  @Type(() => ProductBatchSkuPropertyDto)
  properties!: ProductBatchSkuPropertyDto[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  priceCents!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  @Matches(PRODUCT_SKU_PICTURE_URL, { each: true })
  skuPictureUrls?: string[];
}

export class ProductBatchSkuTargetDto {
  @IsString()
  @IsPositiveInt64String()
  publishedProductId!: string;

  @IsInt()
  @Min(1)
  expectedMutationRevision!: number;

  @IsString()
  @Matches(PRODUCT_SKU_FINGERPRINT)
  expectedPlatformSkuFingerprint!: string;

  @IsString()
  @Matches(PRODUCT_SKU_FINGERPRINT)
  expectedRuleFingerprint!: string;

  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique((dimension: ProductBatchSkuDimensionDto) =>
    productSkuPropertyIdentity(dimension.propertyId, dimension.propertyName),
  )
  @ValidateNested({ each: true })
  @Type(() => ProductBatchSkuDimensionDto)
  dimensions!: ProductBatchSkuDimensionDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((row: ProductBatchSkuRowDto) => row.rowId)
  @ValidateNested({ each: true })
  @Type(() => ProductBatchSkuRowDto)
  rows!: ProductBatchSkuRowDto[];
}

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

export class ProductBatchSourceTargetDto {
  @IsString()
  @IsPositiveInt64String()
  publishedProductId!: string;

  @IsInt()
  @Min(1)
  expectedMutationRevision!: number;

  @IsString()
  @MaxLength(32)
  @Matches(/^[1-9]\d{0,31}$/)
  targetSourceProductId!: string;
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

  @ValidateIf((value: CreateProductBatchPreviewDto) => value.action === 'change_source')
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRODUCT_BATCH_MAX_ITEMS)
  @ArrayUnique((target: ProductBatchSourceTargetDto) => target.publishedProductId)
  @ValidateNested({ each: true })
  @Type(() => ProductBatchSourceTargetDto)
  sourceTargets?: ProductBatchSourceTargetDto[];

  @ValidateIf((value: CreateProductBatchPreviewDto) => value.action === 'edit_sku')
  @IsDefined()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRODUCT_BATCH_MAX_ITEMS)
  @ArrayUnique((target: ProductBatchSkuTargetDto) => target.publishedProductId)
  @ValidateNested({ each: true })
  @Type(() => ProductBatchSkuTargetDto)
  skuTargets?: ProductBatchSkuTargetDto[];
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
