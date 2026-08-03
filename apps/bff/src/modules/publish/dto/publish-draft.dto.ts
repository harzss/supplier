import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  IsPositiveInt64String,
  MAX_PUBLISH_TARGET_SHOPS,
  MAX_SOURCE_PRODUCT_ID_LENGTH,
  PricingStrategyDto,
  PublishAiOptionsDto,
} from './create-publish-task.dto';

export class SavePublishDraftDto {
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  expectedRevision!: number;

  @ValidateIf(
    (dto: SavePublishDraftDto, value: unknown) => value !== undefined || dto.expectedRevision > 0,
  )
  @IsUUID()
  expectedClientRequestId?: string;

  @IsString()
  @MaxLength(MAX_SOURCE_PRODUCT_ID_LENGTH)
  sourceProductId!: string;

  @IsArray()
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

export class DeletePublishDraftDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  expectedRevision!: number;

  @IsUUID()
  expectedClientRequestId!: string;
}
