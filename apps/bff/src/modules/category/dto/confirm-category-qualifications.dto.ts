import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CategoryQualificationValueDto {
  @IsString()
  @MaxLength(64)
  qualificationKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  qualityContentName?: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachmentUrls!: string[];
}

export class ConfirmCategoryQualificationsDto {
  @IsString()
  @MaxLength(32)
  shopId!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CategoryQualificationValueDto)
  qualifications!: CategoryQualificationValueDto[];
}
