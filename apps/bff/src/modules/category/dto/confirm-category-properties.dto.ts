import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CategoryPropertySelectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  valueId?: string;

  @IsString()
  @MaxLength(128)
  name!: string;
}

export class CategoryPropertyValueDto {
  @IsString()
  @MaxLength(64)
  propertyId!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CategoryPropertySelectionDto)
  selections!: CategoryPropertySelectionDto[];
}

export class ConfirmCategoryPropertiesDto {
  @IsString()
  @MaxLength(32)
  shopId!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CategoryPropertyValueDto)
  values!: CategoryPropertyValueDto[];
}
