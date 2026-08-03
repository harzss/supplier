import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  type ValidationOptions,
  ValidateNested,
} from 'class-validator';
import { MAIN_IMAGE_BACKGROUND_STYLES, type MainImageBackgroundStyle } from '../main-image.types';

export const PRICING_MODES = ['fixed_markup', 'competitor_anchor', 'profit_target'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export const MAX_SOURCE_PRODUCT_ID_LENGTH = 128;
export const MAX_PUBLISH_TARGET_SHOPS = 50;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export class PricingStrategyDto {
  @IsIn(PRICING_MODES)
  mode!: PricingMode;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  markupRatio?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(0.8)
  targetMargin?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  @Min(0.01, { each: true })
  competitorPriceRange?: number[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000)
  estimatedShipping?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.5)
  platformFeeRate?: number;
}

export class PublishAiOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  titleOverride?: string;

  @IsOptional()
  @IsBoolean()
  rewriteTitle?: boolean;

  @IsOptional()
  @IsBoolean()
  rewriteDetail?: boolean;

  @IsOptional()
  @IsBoolean()
  removeWatermark?: boolean;

  @IsOptional()
  @IsBoolean()
  relightImages?: boolean;

  @IsOptional()
  @IsIn(MAIN_IMAGE_BACKGROUND_STYLES)
  backgroundStyle?: MainImageBackgroundStyle;
}

export class CreatePublishTaskDto {
  @IsOptional()
  @IsUUID()
  clientRequestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  pricingPreviewToken?: string;

  @IsString()
  @MaxLength(MAX_SOURCE_PRODUCT_ID_LENGTH)
  sourceProductId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PUBLISH_TARGET_SHOPS)
  @ArrayUnique()
  @IsString({ each: true })
  @IsPositiveInt64String({ each: true })
  targetShopIds!: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PricingStrategyDto)
  pricingStrategy?: PricingStrategyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PublishAiOptionsDto)
  aiOptions?: PublishAiOptionsDto;
}

export class PricingPreviewDto {
  @IsString()
  @MaxLength(MAX_SOURCE_PRODUCT_ID_LENGTH)
  sourceProductId!: string;

  @ValidateNested()
  @Type(() => PricingStrategyDto)
  pricingStrategy!: PricingStrategyDto;
}

function IsPositiveInt64String(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isPositiveInt64String',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return false;
          return BigInt(value) <= MAX_SIGNED_BIGINT;
        },
        defaultMessage: () => 'targetShopIds must contain positive signed 64-bit integer strings',
      },
    });
  };
}
