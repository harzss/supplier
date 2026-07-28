import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const SAFE_SPEC_TEXT = /^[^|,^]+$/;

export class ConfirmSkuRowDto {
  @IsString()
  @MaxLength(64)
  sourceSkuId!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  @Matches(SAFE_SPEC_TEXT, { each: true })
  values!: string[];
}

export class ConfirmSkuMappingDto {
  @IsIn(['douyin'])
  platform!: 'douyin';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  @Matches(SAFE_SPEC_TEXT, { each: true })
  dimensions!: string[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConfirmSkuRowDto)
  skus!: ConfirmSkuRowDto[];
}
